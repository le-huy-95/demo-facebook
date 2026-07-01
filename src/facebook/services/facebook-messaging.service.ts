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
  facebookCommentIdsMatch,
} from '../utils/facebook-comment-id.util';
import { resolvePublicAssetUrl } from '../../common/public-url.util';
import { ConversationsService } from './conversations.service';

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
    private readonly conversationsService: ConversationsService,
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

  /** Nội dung lưu DB cho bình luận có media (mirror Graph comment serializer). */
  private buildFeedCommentOutboundContent(
    text: string,
    attachment: OutboundAttachment | undefined,
    isReply: boolean,
  ): { msgType: string; content: string } {
    if (!attachment) {
      return {
        msgType: isReply ? 'feed.comment.reply' : 'feed.comment',
        content: text,
      };
    }

    const publicUrl = this.resolveAttachmentUrl(attachment.url);
    const trimmedText = text.trim();

    if (attachment.type === 'image') {
      const payload = trimmedText
        ? { text: trimmedText, href: publicUrl, type: 'image', title: 'Ảnh' }
        : { href: publicUrl, type: 'image', title: 'Ảnh' };
      return {
        msgType: isReply ? 'feed.comment.reply.photo' : 'feed.comment.photo',
        content: JSON.stringify(payload),
      };
    }

    if (attachment.type === 'video') {
      const payload = trimmedText
        ? { text: trimmedText, href: publicUrl, type: 'video', title: 'Video' }
        : { href: publicUrl, type: 'video', title: 'Video' };
      return {
        msgType: isReply ? 'feed.comment.reply.video' : 'feed.comment.video',
        content: JSON.stringify(payload),
      };
    }

    const label = attachment.type === 'audio' ? 'Audio' : 'Tệp đính kèm';
    const payload = trimmedText
      ? {
          text: trimmedText,
          href: publicUrl,
          type: attachment.type,
          title: label,
        }
      : { href: publicUrl, type: attachment.type, title: label };
    return {
      msgType: isReply ? 'feed.comment.reply' : 'feed.comment',
      content: JSON.stringify(payload),
    };
  }

  private resolveCommentAttachmentUrl(
    attachment: OutboundAttachment,
  ): string | undefined {
    if (attachment.type !== 'image' && attachment.type !== 'video') {
      throw new BadRequestException(
        'Bình luận Facebook chỉ hỗ trợ đính kèm ảnh hoặc video qua URL công khai.',
      );
    }
    return this.resolveAttachmentUrl(attachment.url);
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
        attachment: input.attachment,
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
      sourceCommentId: input.commentId,
      senderName: undefined,
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
    sourceCommentId?: string;
    senderName?: string;
  }) {
    const pageAccessToken = await this.resolvePageAccessToken(
      input.pageId,
      input.orgId,
      'CREATE_CONTENT',
    );

    const commentAuthorId = input.parsed.senderId;

    const resolved = await this.conversationsService.resolveMessengerPsid(
      input.pageId,
      input.orgId,
      {
        commentAuthorId,
        senderName:
          input.senderName ??
          (await this.lookupCommentAuthorName(input.pageId, commentAuthorId)) ??
          undefined,
      },
    );

    const hasRealPsidConversation = Boolean(
      resolved.hasExistingConversation &&
        resolved.psid &&
        resolved.psid !== commentAuthorId,
    );

    let sourceCommentId: string | undefined;
    if (!hasRealPsidConversation) {
      sourceCommentId =
        (await this.resolveVerifiedPrivateReplyCommentId(
          input.pageId,
          commentAuthorId,
          input.sourceCommentId?.trim(),
        )) ?? undefined;
    }

    // Có commentId → private reply lần đầu (mỗi comment chỉ được 1 tin).
    const shouldUsePrivateReply = Boolean(
      !hasRealPsidConversation &&
        sourceCommentId &&
        isValidFacebookCommentId(sourceCommentId) &&
        (input.text.trim() || input.attachment),
    );

    if (shouldUsePrivateReply && sourceCommentId) {
      const postId = await this.lookupPostIdForComment(
        input.pageId,
        sourceCommentId,
      );
      const canonicalCommentId =
        await this.conversationsService.resolveCanonicalCommentId(
          input.pageId,
          input.orgId,
          sourceCommentId,
          postId,
        );
      try {
        return await this.sendMessengerPrivateReply({
          pageId: input.pageId,
          orgId: input.orgId,
          commentId: canonicalCommentId,
          postId,
          text: input.text,
          attachment: input.attachment,
          clientMessageId: input.clientMessageId,
          threadId: input.threadId,
          commentAuthorId,
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        const canFallbackToPsid =
          resolved.psid &&
          resolved.hasExistingConversation &&
          resolved.psid !== commentAuthorId;
        if (!canFallbackToPsid) {
          throw err;
        }
        this.logger.warn(
          `[Messaging] Private reply failed, fallback to PSID ${resolved.psid}: ${message}`,
        );
      }
    }

    let recipientPsid = resolved.psid;
    if (!recipientPsid || recipientPsid === commentAuthorId) {
      const privateReplySent = await this.hasPrivateReplyForAuthor(
        input.pageId,
        commentAuthorId,
      );
      if (privateReplySent) {
        throw new BadRequestException(
          'Đã gửi tin nhắn riêng từ bình luận. Chờ khách trả lời trên Messenger để tiếp tục nhắn tin.',
        );
      }
      throw new BadRequestException(
        'Không tìm được hội thoại Messenger với khách này. Hãy dùng nút Nhắn tin từ bình luận để gửi tin nhắn riêng lần đầu.',
      );
    }

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
      recipientId: recipientPsid,
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
            recipientPsid,
            pageAccessToken,
            {
              ...input.attachment,
              url: this.resolveAttachmentUrl(input.attachment.url),
            },
            input.replyToMessageId,
          )
        : await this.graphApi.sendTextMessage(
            recipientPsid,
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

  private async sendMessengerPrivateReply(input: {
    pageId: string;
    orgId: string;
    commentId: string;
    postId?: string | null;
    text: string;
    attachment?: OutboundAttachment;
    clientMessageId?: string;
    threadId: string;
    commentAuthorId: string;
  }) {
    const pageAccessToken = await this.resolvePageAccessToken(
      input.pageId,
      input.orgId,
      'CREATE_CONTENT',
    );

    const attachment = input.attachment
      ? {
          ...input.attachment,
          url: this.resolveAttachmentUrl(input.attachment.url),
        }
      : undefined;

    const { msgType, content } = this.buildOutboundContent(
      input.text,
      attachment,
    );

    const record = await this.dataService.saveAndBroadcastOutbound({
      organizationId: input.orgId,
      pageId: input.pageId,
      eventType: 'MESSENGER',
      direction: 'OUT',
      senderId: input.pageId,
      senderName: 'Page',
      recipientId: input.commentAuthorId,
      msgType,
      content: attachment ? content : input.text,
      rawPayload: JSON.stringify({
        source: 'app_send_private_reply',
        clientMessageId: input.clientMessageId ?? null,
        sourceCommentId: input.commentId,
        commentAuthorId: input.commentAuthorId,
        attachment: attachment ?? null,
        status: 'SENDING',
      }),
      clientMessageId: input.clientMessageId,
    });

    this.logger.log(
      `[Messaging] Private reply → pageId=${input.pageId} commentId=${input.commentId}`,
    );

    try {
      const fbResp = await this.graphApi.sendPrivateReplyToComment(
        input.pageId,
        input.commentId,
        pageAccessToken,
        {
          text: input.text,
          attachment,
          postId: input.postId ?? undefined,
        },
      );

      const messageId = fbResp.message_id ?? null;
      const resolvedPsid = fbResp.recipient_id?.trim() || null;
      if (messageId) {
        await this.redisCache.setOutboundMessageDedup(
          input.orgId,
          messageId,
          record.id,
        );
      }

      const deliveredPayload = JSON.stringify({
        source: 'app_send_private_reply',
        clientMessageId: input.clientMessageId ?? null,
        sourceCommentId: input.commentId,
        commentAuthorId: input.commentAuthorId,
        resolvedPsid,
        attachment: attachment ?? null,
        status: 'DELIVERED',
      });

      await this.prisma.webhookEvent.update({
        where: { id: record.id },
        data: {
          recipientId: resolvedPsid ?? input.commentAuthorId,
          rawPayload: deliveredPayload,
        },
      });

      const saved = await this.dataService.applySendResult(
        record.id,
        'DELIVERED',
        messageId,
      );

      return {
        savedEvent: saved,
        fb: {
          recipientId: fbResp.recipient_id ?? input.commentAuthorId,
          messageId: messageId ?? undefined,
        },
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Send failed';
      this.logger.error(
        `[Messaging] Messenger private reply failed: ${message}`,
      );
      await this.dataService.applySendResult(record.id, 'FAILED', null);
      throw err;
    }
  }

  private async sendFeedComment(input: {
    pageId: string;
    orgId: string;
    parsed: NonNullable<ReturnType<typeof parseThreadId>>;
    text: string;
    attachment?: OutboundAttachment;
    commentId?: string;
    clientMessageId?: string;
  }) {
    const pageAccessToken = await this.resolvePageAccessToken(
      input.pageId,
      input.orgId,
      'MODERATE',
    );
    const commentText = input.text;
    const attachmentUrl = input.attachment
      ? this.resolveCommentAttachmentUrl(input.attachment)
      : undefined;
    if (!commentText.trim() && !attachmentUrl) {
      throw new BadRequestException('Comment text or attachment is required');
    }
    const postId =
      normalizeFacebookPostId(input.parsed.postId) ?? input.parsed.postId;
    if (!postId) {
      throw new BadRequestException('Thiếu postId cho bình luận');
    }

    const requestedCommentId = input.commentId?.trim() || undefined;
    const isReply =
      !!requestedCommentId && isValidFacebookCommentId(requestedCommentId);

    const { msgType, content } = this.buildFeedCommentOutboundContent(
      commentText,
      input.attachment,
      isReply,
    );

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
      msgType,
      content,
      rawPayload: JSON.stringify({
        source: 'app_send',
        clientMessageId: input.clientMessageId ?? null,
        mode: isReply ? 'reply' : 'post_comment',
        attachment: input.attachment ?? null,
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
        const canonicalTarget =
          await this.conversationsService.resolveCanonicalCommentId(
            input.pageId,
            input.orgId,
            targetCommentId,
            postId,
          );
        fbResp = await this.graphApi.replyToComment(
          canonicalTarget,
          pageAccessToken,
          commentText,
          attachmentUrl,
          postId,
        );
      } else {
        fbResp = await this.graphApi.createPostComment(
          postId,
          pageAccessToken,
          commentText,
          attachmentUrl,
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

  /**
   * Chỉ dùng bình luận IN thật (FEED_COMMENT) của đúng khách — bỏ qua reaction id,
   * message id Messenger, hoặc commentId FE gửi nhầm.
   */
  private async resolveVerifiedPrivateReplyCommentId(
    pageId: string,
    commentAuthorId: string,
    preferredId?: string,
  ): Promise<string | null> {
    const verify = async (id: string): Promise<string | null> => {
      const row = await this.prisma.webhookEvent.findFirst({
        where: {
          pageId,
          eventType: 'FEED_COMMENT',
          direction: 'IN',
          senderId: commentAuthorId.trim(),
          status: 'ACTIVE',
          commentId: { not: null },
          OR: [{ commentId: id }, { messageId: id }],
        },
        orderBy: { createdAt: 'desc' },
        select: { commentId: true },
      });
      const cid = row?.commentId?.trim();
      if (!cid || !isValidFacebookCommentId(cid)) return null;
      if (await this.hasPrivateReplyBeenSent(pageId, cid)) return null;
      return cid;
    };

    if (preferredId && isValidFacebookCommentId(preferredId)) {
      const verified = await verify(preferredId);
      if (verified) return verified;
    }

    return this.resolveSourceCommentIdForPrivateReply(pageId, commentAuthorId);
  }

  /** Bình luận inbound mới nhất của khách — dùng private reply khi FE chưa gửi commentId. */
  private async resolveSourceCommentIdForPrivateReply(
    pageId: string,
    commentAuthorId: string,
  ): Promise<string | null> {
    if (!commentAuthorId?.trim()) return null;
    const row = await this.prisma.webhookEvent.findFirst({
      where: {
        pageId,
        eventType: 'FEED_COMMENT',
        direction: 'IN',
        senderId: commentAuthorId.trim(),
        commentId: { not: null },
        status: 'ACTIVE',
      },
      orderBy: { createdAt: 'desc' },
      select: { commentId: true },
    });
    const id = row?.commentId?.trim();
    if (!id || !isValidFacebookCommentId(id)) return null;
    if (await this.hasPrivateReplyBeenSent(pageId, id)) return null;
    return id;
  }

  /** Facebook chỉ cho 1 private reply / comment. */
  private async hasPrivateReplyBeenSent(
    pageId: string,
    commentId: string,
  ): Promise<boolean> {
    const rows = await this.prisma.webhookEvent.findMany({
      where: {
        pageId,
        eventType: 'MESSENGER',
        direction: 'OUT',
        deliveryStatus: { in: ['DELIVERED', 'SENDING'] },
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: { rawPayload: true },
    });
    for (const row of rows) {
      try {
        const raw = JSON.parse(row.rawPayload ?? '{}') as {
          source?: string;
          sourceCommentId?: string;
        };
        if (
          raw.source === 'app_send_private_reply' &&
          raw.sourceCommentId &&
          facebookCommentIdsMatch(raw.sourceCommentId, commentId)
        ) {
          return true;
        }
      } catch {
        // ignore malformed payload
      }
    }
    return false;
  }

  private async hasPrivateReplyForAuthor(
    pageId: string,
    commentAuthorId: string,
  ): Promise<boolean> {
    const row = await this.prisma.webhookEvent.findFirst({
      where: {
        pageId,
        eventType: 'MESSENGER',
        direction: 'OUT',
        recipientId: commentAuthorId.trim(),
        rawPayload: { contains: 'app_send_private_reply' },
      },
      select: { id: true },
    });
    return !!row;
  }

  private async lookupCommentAuthorName(
    pageId: string,
    commentAuthorId: string,
  ): Promise<string | null> {
    const row = await this.prisma.webhookEvent.findFirst({
      where: {
        pageId,
        eventType: 'FEED_COMMENT',
        direction: 'IN',
        senderId: commentAuthorId.trim(),
        senderName: { not: null },
      },
      orderBy: { createdAt: 'desc' },
      select: { senderName: true },
    });
    return row?.senderName?.trim() ?? null;
  }

  private async lookupPostIdForComment(
    pageId: string,
    commentId: string,
  ): Promise<string | null> {
    const row = await this.prisma.webhookEvent.findFirst({
      where: {
        pageId,
        eventType: 'FEED_COMMENT',
        OR: [{ commentId }, { messageId: commentId }],
      },
      orderBy: { createdAt: 'desc' },
      select: { postId: true },
    });
    return normalizeFacebookPostId(row?.postId) ?? row?.postId?.trim() ?? null;
  }
}
