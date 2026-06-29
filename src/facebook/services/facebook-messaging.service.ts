import { AppLogger } from '../../common/logger.service';
import {
  ForbiddenException,
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { WebhookEvent } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { FacebookRepoService } from './facebook-repo.service';
import { FacebookGraphApiService } from './facebook-graph-api.service';
import { FacebookDataService } from './facebook-data.service';
import { PageMapService } from './page-map.service';
import { ConfigService } from '@nestjs/config';
import { RedisCacheService } from '../../redis/redis-cache.service';
import { parseThreadId } from '../utils/conversation-thread.util';
import {
  isValidFacebookCommentId,
  normalizeFacebookPostId,
} from '../utils/facebook-comment-id.util';
import { resolvePublicAssetUrl } from '../../common/public-url.util';

export interface OutboundAttachment {
  type: 'image' | 'video' | 'audio' | 'file';
  url: string;
}

/**
 * Orchestrator gửi tin Facebook:
 * persist-first (SENDING) → Graph API → Redis dedup → DELIVERED/FAILED
 */
@Injectable()
export class FacebookMessagingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly facebookRepo: FacebookRepoService,
    private readonly graphApi: FacebookGraphApiService,
    private readonly dataService: FacebookDataService,
    private readonly pageMapService: PageMapService,
    private readonly configService: ConfigService,
    private readonly redisCache: RedisCacheService,
    private readonly logger: AppLogger,
  ) {
    this.logger.setContext(FacebookMessagingService.name);
  }

  private getDefaultOrgId(): string {
    return this.configService.get<string>('DEFAULT_ORG_ID', 'default-org');
  }

  private async resolvePageAccessToken(
    pageId: string,
    orgId: string,
    requiredTask?: 'MODERATE' | 'CREATE_CONTENT',
  ): Promise<string> {
    const pages = await this.facebookRepo.listPages(orgId);
    const page = pages.find((p) => p.pageId === pageId);
    if (!page?.pageAccessToken) {
      throw new NotFoundException(
        'Fanpage chưa liên kết hoặc thiếu page access token',
      );
    }

    if (requiredTask) {
      let tasks: string[] = [];
      try {
        tasks = JSON.parse((page as any).tasks ?? '[]');
      } catch {
        tasks = [];
      }
      const normalized = tasks.map((t) => String(t).toUpperCase());
      const hasAllowedTask =
        normalized.includes('MANAGE') ||
        normalized.includes(requiredTask) ||
        (requiredTask === 'MODERATE' && normalized.includes('CREATE_CONTENT'));
      if (!hasAllowedTask) {
        throw new ForbiddenException(
          `Tài khoản Facebook hiện không có task phù hợp trên Page để phản hồi bình luận. Required=${requiredTask}, current=[${normalized.join(', ') || 'none'}].`,
        );
      }
    }

    return page.pageAccessToken;
  }

  private buildOutboundContent(
    text: string,
    attachment?: OutboundAttachment,
  ): { msgType: string; content: string } {
    if (!attachment) {
      return { msgType: 'webchat', content: text };
    }

    const previewByType: Record<OutboundAttachment['type'], string> = {
      image: '[Hình ảnh]',
      video: '[Video]',
      audio: '[Audio]',
      file: '[Tệp đính kèm]',
    };

    const msgTypeByType: Record<OutboundAttachment['type'], string> = {
      image: 'chat.photo',
      video: 'chat.video.msg',
      audio: 'chat.video.msg',
      file: 'share.file',
    };

    const fileObj = {
      title: previewByType[attachment.type],
      description: text || '',
      href: attachment.url,
      thumb: attachment.type === 'image' ? attachment.url : '',
      childnumber: 0,
      action: '',
      params: JSON.stringify({
        fileSize: '0',
        fileExt: attachment.type,
        checksum: '',
        fType: attachment.type === 'file' ? 2 : 1,
      }),
      type: attachment.type,
    };

    return {
      msgType: msgTypeByType[attachment.type],
      content: JSON.stringify(fileObj),
    };
  }

  async sendToThread(input: {
    pageId: string;
    threadId: string;
    text?: string;
    attachment?: OutboundAttachment;
    commentId?: string;
    replyToMessageId?: string;
    clientMessageId?: string;
  }): Promise<{
    savedEvent: WebhookEvent;
    fb: { recipientId?: string; messageId?: string };
  }> {
    const pageId = input.pageId?.trim();
    const threadId = input.threadId?.trim();
    const text = (input.text ?? '').trim();
    const attachment = input.attachment;
    const replyToMessageId = input.replyToMessageId?.trim() || undefined;

    if (!pageId) throw new BadRequestException('Missing pageId');
    if (!threadId) throw new BadRequestException('Missing threadId');
    if (!text && !attachment) {
      throw new BadRequestException('Message text or attachment is required');
    }

    const parsed = parseThreadId(threadId);
    if (!parsed || parsed.pageId !== pageId) {
      throw new BadRequestException('Thread không hợp lệ');
    }

    const map = this.pageMapService.getSocialMap(pageId);
    const orgId = map?.orgId ?? this.getDefaultOrgId();

    if (parsed.kind === 'FEED_COMMENT') {
      return this.sendFeedComment({
        pageId,
        orgId,
        parsed,
        text,
        commentId: input.commentId,
        clientMessageId: input.clientMessageId,
      });
    }

    if (parsed.kind !== 'MESSENGER') {
      throw new BadRequestException('Thread kind không được hỗ trợ');
    }

    return this.sendMessenger({
      pageId,
      orgId,
      parsed,
      text,
      attachment,
      replyToMessageId,
      clientMessageId: input.clientMessageId,
      threadId,
    });
  }

  private async sendMessenger(input: {
    pageId: string;
    orgId: string;
    parsed: NonNullable<ReturnType<typeof parseThreadId>>;
    text: string;
    attachment?: OutboundAttachment;
    replyToMessageId?: string;
    clientMessageId?: string;
    threadId: string;
  }) {
    const pageAccessToken = await this.resolvePageAccessToken(
      input.pageId,
      input.orgId,
      'CREATE_CONTENT',
    );

    const { msgType, content } = this.buildOutboundContent(
      input.text,
      input.attachment,
    );

    // Step 1: Lưu SENDING trước khi gọi Graph API
    const record = await this.dataService.saveAndBroadcastOutbound({
      organizationId: input.orgId,
      pageId: input.pageId,
      eventType: 'MESSENGER',
      direction: 'OUT',
      senderId: input.pageId,
      senderName: 'Page',
      recipientId: input.parsed.senderId,
      msgType,
      content: input.attachment ? content : input.text,
      rawPayload: JSON.stringify({
        source: 'app_send',
        clientMessageId: input.clientMessageId ?? null,
        replyToMessageId: input.replyToMessageId ?? null,
        attachment: input.attachment ?? null,
        status: 'SENDING',
      }),
      clientMessageId: input.clientMessageId,
    });

    try {
      const fbResp = input.attachment
        ? await this.graphApi.sendAttachmentMessage(
            input.parsed.senderId,
            pageAccessToken,
            {
              ...input.attachment,
              url: this.resolveAttachmentUrl(input.attachment.url),
            },
            input.replyToMessageId,
          )
        : await this.graphApi.sendTextMessage(
            input.parsed.senderId,
            pageAccessToken,
            input.text,
            input.replyToMessageId,
          );

      // Step 4: Redis dedup NGAY sau messageId — trước webhook echo
      if (fbResp.message_id) {
        await this.redisCache.setOutboundMessageDedup(
          input.orgId,
          fbResp.message_id,
          record.id,
        );
      }

      // Step 5: Cập nhật DELIVERED
      const saved = await this.dataService.applySendResult(
        record.id,
        'DELIVERED',
        fbResp.message_id ?? null,
      );

      return {
        savedEvent: saved,
        fb: {
          recipientId: fbResp.recipient_id,
          messageId: fbResp.message_id,
        },
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Send failed';
      this.logger.error(`[Messaging] Messenger send failed: ${message}`);
      const saved = await this.dataService.applySendResult(
        record.id,
        'FAILED',
        null,
      );
      throw err;
    }
  }

  private async sendFeedComment(input: {
    pageId: string;
    orgId: string;
    parsed: NonNullable<ReturnType<typeof parseThreadId>>;
    text: string;
    commentId?: string;
    clientMessageId?: string;
  }) {
    const pageAccessToken = await this.resolvePageAccessToken(
      input.pageId,
      input.orgId,
      'MODERATE',
    );
    const commentText = input.text;
    if (!commentText) {
      throw new BadRequestException('Comment text is required');
    }
    const postId =
      normalizeFacebookPostId(input.parsed.postId) ?? input.parsed.postId;
    if (!postId) {
      throw new BadRequestException('Thiếu postId cho bình luận');
    }

    const requestedCommentId = input.commentId?.trim() || undefined;
    const isReply =
      !!requestedCommentId && isValidFacebookCommentId(requestedCommentId);

    const record = await this.dataService.saveAndBroadcastOutbound({
      organizationId: input.orgId,
      pageId: input.pageId,
      eventType: 'FEED_COMMENT',
      direction: 'OUT',
      senderId: input.parsed.senderId,
      senderName: 'Page',
      recipientId: input.pageId,
      postId,
      parentCommentId: input.parsed.commentId ?? requestedCommentId ?? null,
      msgType: isReply ? 'feed.comment.reply' : 'feed.comment',
      content: commentText,
      rawPayload: JSON.stringify({
        source: 'app_send',
        clientMessageId: input.clientMessageId ?? null,
        mode: isReply ? 'reply' : 'post_comment',
        status: 'SENDING',
      }),
      clientMessageId: input.clientMessageId,
    });

    try {
      let fbResp: { id?: string };
      if (isReply) {
        const targetCommentId =
          requestedCommentId ??
          (await this.resolveValidReplyTargetCommentId({
            pageId: input.pageId,
            postId,
            customerId: input.parsed.senderId,
            requestedCommentId,
            threadRootCommentId: input.parsed.commentId,
          }));
        fbResp = await this.graphApi.replyToComment(
          targetCommentId,
          pageAccessToken,
          commentText,
        );
      } else {
        fbResp = await this.graphApi.createPostComment(
          postId,
          pageAccessToken,
          commentText,
        );
      }

      if (fbResp.id) {
        await this.redisCache.setOutboundMessageDedup(
          input.orgId,
          fbResp.id,
          record.id,
        );
      }

      const saved = await this.dataService.applySendResult(
        record.id,
        'DELIVERED',
        fbResp.id ?? null,
        fbResp.id ?? null,
      );

      return {
        savedEvent: { ...saved, commentId: fbResp.id ?? saved.commentId },
        fb: { messageId: fbResp.id },
      };
    } catch (err: unknown) {
      await this.dataService.applySendResult(record.id, 'FAILED', null);
      throw err;
    }
  }

  async sendTextToThread(input: {
    pageId: string;
    threadId: string;
    text: string;
    clientMessageId?: string;
  }) {
    return this.sendToThread(input);
  }

  /** Chọn comment parent từ DB — không gọi Graph API để đọc history */
  private async resolveValidReplyTargetCommentId(input: {
    pageId: string;
    postId: string;
    customerId: string;
    requestedCommentId?: string;
    threadRootCommentId?: string;
  }): Promise<string> {
    const candidates: string[] = [];
    const pushCandidate = (id: string | null | undefined) => {
      if (!id || !isValidFacebookCommentId(id)) return;
      if (!candidates.includes(id)) candidates.push(id);
    };

    pushCandidate(input.requestedCommentId);
    pushCandidate(input.threadRootCommentId);

    const threadCommentFilter = input.threadRootCommentId
      ? [
          { commentId: input.threadRootCommentId },
          { parentCommentId: input.threadRootCommentId },
        ]
      : [];

    const rows = await this.prisma.webhookEvent.findMany({
      where: {
        pageId: input.pageId,
        eventType: 'FEED_COMMENT',
        postId: input.postId,
        commentId: { not: null },
        status: 'ACTIVE',
        OR: [
          { direction: 'IN', senderId: input.customerId },
          { direction: 'IN', senderId: { not: input.pageId } },
          ...threadCommentFilter,
        ],
      },
      orderBy: { createdAt: 'desc' },
      take: 30,
      select: { commentId: true, direction: true, senderId: true },
    });

    for (const row of rows) {
      if (
        row.direction === 'IN' &&
        row.senderId &&
        row.senderId !== input.pageId
      ) {
        pushCandidate(row.commentId);
      }
    }
    for (const row of rows) {
      pushCandidate(row.commentId);
    }

    if (candidates.length === 0) {
      throw new NotFoundException(
        'Không tìm thấy bình luận khách hàng trong DB. Chỉ thấy tin từ lúc webhook hoạt động.',
      );
    }

    return candidates[0];
  }

  private resolveAttachmentUrl(url: string): string {
    const publicBaseUrl = this.configService.get<string>(
      'PUBLIC_BASE_URL',
      'http://localhost:3000',
    );
    return resolvePublicAssetUrl(url, publicBaseUrl);
  }
}
