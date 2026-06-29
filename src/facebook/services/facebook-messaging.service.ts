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
import { FacebookOAuthService } from './facebook-oauth.service';
import { PageMapService } from './page-map.service';
import { ConfigService } from '@nestjs/config';
import { RedisCacheService } from '../../redis/redis-cache.service';
import { parseThreadId } from '../utils/conversation-thread.util';
import { isValidFacebookCommentId } from '../utils/facebook-comment-id.util';
import { resolvePublicAssetUrl } from '../../common/public-url.util';

export interface OutboundAttachment {
  type: 'image' | 'video' | 'audio' | 'file';
  url: string;
}

@Injectable()
export class FacebookMessagingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly facebookRepo: FacebookRepoService,
    private readonly facebookOAuth: FacebookOAuthService,
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
          `Tài khoản Facebook hiện không có task phù hợp trên Page để phản hồi bình luận. Required=${requiredTask}, current=[${normalized.join(', ') || 'none'}]. Vui lòng liên kết lại bằng tài khoản có quyền MANAGE/MODERATE.`,
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
      const pageAccessToken = await this.resolvePageAccessToken(
        pageId,
        orgId,
        'MODERATE',
      );
      const replyText = text;
      if (!replyText) {
        throw new BadRequestException('Reply text is required for comments');
      }

      const targetCommentId = await this.resolveValidReplyTargetCommentId({
        pageId,
        postId: parsed.postId!,
        customerId: parsed.senderId,
        requestedCommentId: input.commentId?.trim(),
        pageAccessToken,
      });

      this.logger.log(
        `[Messaging] Replying to comment ${targetCommentId} on post ${parsed.postId} for customer ${parsed.senderId}`,
      );
      const fbResp = await this.facebookOAuth.replyToComment(
        targetCommentId,
        pageAccessToken,
        replyText,
      );

      const saved = await this.prisma.webhookEvent.create({
        data: {
          organizationId: orgId,
          pageId,
          eventType: 'FEED_COMMENT',
          direction: 'OUT',
          senderId: parsed.senderId,
          senderName: 'Page',
          recipientId: pageId,
          messageId: fbResp.id ?? null,
          postId: parsed.postId ?? null,
          commentId: fbResp.id ?? null,
          parentCommentId: rootCommentId,
          msgType: 'feed.comment.reply',
          content: replyText,
          rawPayload: JSON.stringify({
            source: 'socket_send',
            clientMessageId: input.clientMessageId ?? null,
            targetCommentId,
            fb: fbResp,
          }),
        },
      });

      await this.redisCache.bumpPageRevision(orgId, pageId);
      await this.redisCache.bumpThreadRevision(pageId, threadId);

      return {
        savedEvent: saved,
        fb: { recipientId: undefined, messageId: fbResp.id },
      };
    }

    if (parsed.kind !== 'MESSENGER') {
      throw new BadRequestException('Thread kind không được hỗ trợ');
    }

    const pageAccessToken = await this.resolvePageAccessToken(
      pageId,
      orgId,
      'CREATE_CONTENT',
    );

    const fbResp = attachment
      ? await this.facebookOAuth.sendAttachmentMessageToPsid(
          parsed.senderId,
          pageAccessToken,
          {
            ...attachment,
            url: this.resolveAttachmentUrl(attachment.url),
          },
        )
      : await this.facebookOAuth.sendTextMessageToPsid(
          parsed.senderId,
          pageAccessToken,
          text,
          replyToMessageId,
        );

    const { msgType, content } = this.buildOutboundContent(text, attachment);

    const saved = await this.prisma.webhookEvent.create({
      data: {
        organizationId: orgId,
        pageId,
        eventType: 'MESSENGER',
        direction: 'OUT',
        senderId: pageId,
        senderName: 'Page',
        recipientId: parsed.senderId,
        messageId: fbResp.message_id ?? null,
        postId: null,
        commentId: null,
        msgType,
        content: attachment ? content : text,
        rawPayload: JSON.stringify({
          source: 'socket_send',
          clientMessageId: input.clientMessageId ?? null,
          replyToMessageId: replyToMessageId ?? null,
          attachment: attachment ?? null,
          fb: fbResp,
        }),
      },
    });

    await this.redisCache.bumpPageRevision(orgId, pageId);
    await this.redisCache.bumpThreadRevision(pageId, threadId);

    return {
      savedEvent: saved,
      fb: { recipientId: fbResp.recipient_id, messageId: fbResp.message_id },
    };
  }

  async sendTextToThread(input: {
    pageId: string;
    threadId: string;
    text: string;
    clientMessageId?: string;
  }) {
    return this.sendToThread(input);
  }

  /** Chọn comment parent còn tồn tại trên Graph — tránh reply vào ID cũ/đã xóa. */
  private async resolveValidReplyTargetCommentId(input: {
    pageId: string;
    postId: string;
    customerId: string;
    requestedCommentId?: string;
    pageAccessToken: string;
  }): Promise<string> {
    const candidates: string[] = [];

    if (
      input.requestedCommentId &&
      isValidFacebookCommentId(input.requestedCommentId)
    ) {
      candidates.push(input.requestedCommentId);
    }

    const inboundRows = await this.prisma.webhookEvent.findMany({
      where: {
        pageId: input.pageId,
        eventType: 'FEED_COMMENT',
        direction: 'IN',
        postId: input.postId,
        senderId: input.customerId,
        commentId: { not: null },
      },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: { commentId: true },
    });
    for (const row of inboundRows) {
      if (row.commentId && isValidFacebookCommentId(row.commentId)) {
        candidates.push(row.commentId);
      }
    }

    const graphFallback = await this.resolveLatestInboundCommentId({
      pageId: input.pageId,
      postId: input.postId,
      customerId: input.customerId,
      pageAccessToken: input.pageAccessToken,
    });
    if (graphFallback) {
      candidates.push(graphFallback);
    }

    const seen = new Set<string>();
    for (const id of candidates) {
      if (seen.has(id)) continue;
      seen.add(id);

      const meta = await this.facebookOAuth.getCommentMeta(
        id,
        input.pageAccessToken,
      );
      if (meta?.id) {
        if (id !== input.requestedCommentId) {
          this.logger.warn(
            `[Messaging] commentId ${input.requestedCommentId ?? 'none'} không hợp lệ, dùng ${meta.id}`,
          );
        }
        return meta.id;
      }
    }

    throw new NotFoundException(
      'Không tìm thấy bình luận khách hàng còn tồn tại trên Facebook. Tải lại thread hoặc chọn bình luận khác.',
    );
  }

  private async resolveLatestInboundCommentId(input: {
    pageId: string;
    postId: string;
    rootCommentId?: string;
    customerId: string;
    pageAccessToken?: string;
  }): Promise<string | null> {
    const inbound = await this.prisma.webhookEvent.findFirst({
      where: {
        pageId: input.pageId,
        eventType: 'FEED_COMMENT',
        direction: 'IN',
        postId: input.postId,
        senderId: input.customerId,
        commentId: { not: null },
      },
      orderBy: { createdAt: 'desc' },
      select: { commentId: true },
    });
    if (inbound?.commentId && isValidFacebookCommentId(inbound.commentId)) {
      return inbound.commentId;
    }

    // Fallback: comment gần nhất trong thread (kể cả từ Graph sync)
    const anyInThread = await this.prisma.webhookEvent.findFirst({
      where: {
        pageId: input.pageId,
        eventType: 'FEED_COMMENT',
        postId: input.postId,
        senderId: input.customerId,
        commentId: { not: null },
      },
      orderBy: { createdAt: 'desc' },
      select: { commentId: true },
    });
    if (
      anyInThread?.commentId &&
      isValidFacebookCommentId(anyInThread.commentId)
    ) {
      return anyInThread.commentId;
    }

    // Fallback cuối: lấy từ Graph API comment mới nhất của khách trên post
    try {
      const token =
        input.pageAccessToken ??
        (await this.resolvePageAccessToken(
          input.pageId,
          this.getDefaultOrgId(),
        ));
      const { comments } = await this.facebookOAuth.getPostComments(
        input.postId,
        token,
        { limit: 50 },
      );
      const customerComment = comments
        .filter((c) => c.from?.id === input.customerId && c.id)
        .sort(
          (a, b) =>
            new Date(b.created_time).getTime() -
            new Date(a.created_time).getTime(),
        )[0];
      return customerComment?.id ?? null;
    } catch {
      return null;
    }
  }

  private resolveAttachmentUrl(url: string): string {
    const publicBaseUrl = this.configService.get<string>(
      'PUBLIC_BASE_URL',
      'http://localhost:3000',
    );
    return resolvePublicAssetUrl(url, publicBaseUrl);
  }
}
