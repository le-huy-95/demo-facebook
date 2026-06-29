import { BadRequestException, Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { WebhookEvent } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AppLogger } from '../../common/logger.service';
import { PageMapService } from '../services/page-map.service';
import { EventsService } from '../services/events.service';
import { EventsGateway } from '../gateways/events.gateway';
import { ConversationsService } from '../services/conversations.service';
import { FacebookOAuthService } from '../services/facebook-oauth.service';
import { FacebookRepoService } from '../services/facebook-repo.service';
import {
  transformInboundMessage,
  transformMessagingReceipt,
} from '../utils/facebook-payload.util';
import { transformFeedChange, extractFeedCommentKey, extractFeedPostKey, type FeedEventTransform } from '../utils/facebook-feed.util';
import { buildThreadId } from '../utils/conversation-thread.util';
import { extractPostIdFromMessengerPayload } from '../utils/messenger-thread.util';
import { isValidFacebookCommentId } from '../utils/facebook-comment-id.util';
import {
  EVENT_STATUS_ACTIVE,
  EVENT_STATUS_DELETED,
  EVENT_STATUS_HIDDEN,
  type EventVisibilityStatus,
} from '../utils/event-visibility.util';
import { RedisCacheService } from '../../redis/redis-cache.service';

type WebhookEventCreateData = Parameters<
  PrismaService['webhookEvent']['create']
>[0]['data'];

@Injectable()
export class FacebookWebhookService implements OnModuleInit {
  /** Cooldown map: pageId → timestamp khi sync cuối cùng kết thúc */
  private readonly syncLastAt = new Map<string, number>();
  /** Lock map: ngăn 2 sync cùng pageId chạy song song */
  private readonly syncInProgress = new Set<string>();
  private static readonly SYNC_COOLDOWN_MS = 30_000;

  constructor(
    private readonly logger: AppLogger,
    private readonly prisma: PrismaService,
    private readonly pageMapService: PageMapService,
    private readonly eventsService: EventsService,
    private readonly eventsGateway: EventsGateway,
    private readonly conversationsService: ConversationsService,
    private readonly redisCache: RedisCacheService,
    private readonly facebookOAuth: FacebookOAuthService,
    private readonly facebookRepo: FacebookRepoService,
    private readonly configService: ConfigService,
  ) {
    this.logger.setContext(FacebookWebhookService.name);
  }

  async onModuleInit() {
    void this.backfillParentCommentIds().catch((err) =>
      this.logger.warn('Backfill parentCommentId failed', err?.message),
    );
  }

  private async backfillParentCommentIds(): Promise<void> {
    const events = await this.prisma.webhookEvent.findMany({
      where: {
        eventType: 'FEED_COMMENT',
        parentCommentId: null,
        commentId: { not: null },
      },
      select: { id: true, rawPayload: true },
    });

    let updated = 0;
    for (const event of events) {
      try {
        const raw = JSON.parse(event.rawPayload);
        let parentCommentId: string | null = null;
        if (raw.parent?.id) {
          parentCommentId = raw.parent.id;
        } else if (raw.parent_id) {
          const pid = String(raw.parent_id);
          const postId = raw.post_id ? String(raw.post_id) : null;
          if (pid && pid !== postId) {
            parentCommentId = pid;
          }
        } else if (raw.targetCommentId) {
          parentCommentId = raw.targetCommentId;
        }

        if (parentCommentId) {
          await this.prisma.webhookEvent.update({
            where: { id: event.id },
            data: { parentCommentId },
          });
          updated++;
        }
      } catch {
        // skip malformed payloads
      }
    }

    if (updated > 0) {
      this.logger.log(
        `[Backfill] Updated parentCommentId for ${updated}/${events.length} FEED_COMMENT events`,
      );
    }
  }

  async processWebhookBody(body: any): Promise<void> {
    for (const entry of body.entry ?? []) {
      const pageId: string = entry.id;

      const messagingEvents = [
        ...(entry.messaging ?? []),
        ...(entry.standby ?? []),
      ];
      for (const messagingEvent of messagingEvents) {
        await this.processMessagingEvent(pageId, messagingEvent);
      }

      const changes = entry.changes ?? [];
      const changedFields = (entry.changed_fields ?? []) as string[];

      // needsGraphFallback=true khi Meta chỉ báo changed_fields=feed mà không kèm payload
      // (xảy ra khi include_values=true chưa được đặt hoặc Meta gửi summary-only notification).
      // Khi có changes[].field='feed' với payload đầy đủ → xử lý inline, không cần gọi Graph API.
      let needsGraphFallback = changedFields.includes('feed');

      if (changes.length > 0) {
        this.logger.log(
          `[Webhook] entry.changes raw: ${JSON.stringify(changes)}`,
        );
      }
      if (changedFields.length > 0) {
        this.logger.log(
          `[Webhook] entry.changed_fields: [${changedFields.join(',')}] changes.length=${changes.length}`,
        );
      }

      for (const change of changes) {
        const field = String(change.field ?? '');
        const value = (change.value ?? {}) as Record<string, unknown>;

        if (field === 'feed') {
          // Có payload đầy đủ → xử lý inline, không cần Graph API fallback
          needsGraphFallback = false;
          this.logger.log(
            `[Webhook] feed change inline item=${String(value?.item ?? '')} verb=${String(value?.verb ?? '')} pageId=${pageId}`,
          );
          this.logger.log(
            `[Webhook] feed change value: ${JSON.stringify(value)}`,
          );
          await this.processFeedChange(pageId, value);
          continue;
        }

        if (field) {
          this.logger.log(
            `[Webhook] change field=${field} item=${String(value?.item ?? '')} verb=${String(value?.verb ?? '')} pageId=${pageId}`,
          );
        }
      }

      if (changedFields.length > 0) {
        this.logger.log(
          `[Webhook] changed_fields=[${changedFields.join(',')}] pageId=${pageId} changes=${changes.length}`,
        );
      }

      // Fallback Graph API: chỉ gọi khi Meta báo feed activity nhưng KHÔNG có payload inline.
      // Đây là cơ chế dự phòng (không phải polling) — chỉ chạy khi include_values chưa hoạt động.
      if (needsGraphFallback) {
        this.logger.log(
          `[Webhook] changed_fields=feed nhưng không có changes[] payload → Graph API fallback pageId=${pageId}`,
        );
        const syncResult = await this.syncFeedCommentsFromGraph(pageId, true);
        this.logger.log(
          `[Webhook] Graph fallback done: ingested=${syncResult.ingested} threadIds=${JSON.stringify(syncResult.threadIds)}`,
        );
        this.eventsGateway.emitFeedSynced(pageId, syncResult);
      }
    }
  }

  private async resolveOrgId(pageId: string): Promise<string | null> {
    const map = this.pageMapService.getSocialMap(pageId);
    if (map?.orgId) return map.orgId;

    const row = await this.prisma.facebookPage.findFirst({
      where: { pageId },
      select: { organizationId: true },
    });
    return row?.organizationId ?? null;
  }

  private async findDuplicateEvent(
    data: WebhookEventCreateData,
  ): Promise<WebhookEvent | null> {
    if (!data.pageId) return null;

    const isFeedComment =
      data.eventType === 'FEED_COMMENT' ||
      data.msgType?.startsWith('feed.comment');

    if (isFeedComment) {
      const commentKey = data.commentId ?? data.messageId;
      if (!commentKey) return null;

      return this.prisma.webhookEvent.findFirst({
        where: {
          pageId: data.pageId,
          eventType: 'FEED_COMMENT',
          OR: [{ messageId: commentKey }, { commentId: commentKey }],
        },
      });
    }

    if (!data.messageId) return null;

    return this.prisma.webhookEvent.findFirst({
      where: {
        pageId: data.pageId,
        messageId: data.messageId,
        eventType: { in: ['MESSENGER', 'MESSENGER_POSTBACK'] },
      },
    });
  }

  private async saveAndBroadcast(data: WebhookEventCreateData) {
    const duplicate = await this.findDuplicateEvent(data);
    if (duplicate) {
      this.logger.debug(
        `[Webhook] Duplicate skipped pageId=${data.pageId} messageId=${data.messageId} msgType=${data.msgType}`,
      );
      this.logger.log(
        `[DEBUG] saveAndBroadcast: DUPLICATE → vẫn emit socket. eventType=${data.eventType} id=${duplicate.id}`,
      );
      await this.invalidateCachesForEvent(duplicate.pageId ?? '', duplicate);
      this.eventsService.emitNewMessage(duplicate);
      this.eventsGateway.emitWebhookEvent(duplicate);
      return duplicate;
    }

    const saved = await this.prisma.webhookEvent.create({ data });
    this.logger.log(
      `[DEBUG] saveAndBroadcast: SAVED id=${saved.id} eventType=${saved.eventType} pageId=${saved.pageId} postId=${saved.postId} commentId=${saved.commentId} → emitting socket webhook:event`,
    );
    await this.invalidateCachesForEvent(saved.pageId ?? '', saved);
    this.eventsService.emitNewMessage(saved);
    this.eventsGateway.emitWebhookEvent(saved);
    return saved;
  }

  private async invalidateCachesForEvent(
    pageId: string,
    event: WebhookEvent,
  ): Promise<void> {
    if (!pageId) return;

    const orgId =
      event.organizationId ??
      this.configService.get<string>('DEFAULT_ORG_ID', 'default-org');
    await this.redisCache.bumpPageRevision(orgId, pageId);

    const threadId = buildThreadId(event);
    if (threadId) {
      await this.redisCache.bumpThreadRevision(pageId, threadId);
    }

    if (event.postId) {
      await this.redisCache.invalidateAndPublish([
        this.redisCache.postPreviewKey(pageId, event.postId),
      ]);
    }
  }

  private async markCommentVisibility(
    pageId: string,
    commentKey: string,
    status: EventVisibilityStatus,
  ): Promise<void> {
    const updated = await this.prisma.webhookEvent.updateMany({
      where: {
        pageId,
        eventType: 'FEED_COMMENT',
        OR: [{ commentId: commentKey }, { messageId: commentKey }],
      },
      data: { status },
    });

    if (updated.count === 0) {
      this.logger.debug(
        `[Webhook] ${status} comment ${commentKey} — không có event trong DB`,
      );
    } else {
      this.logger.log(
        `[Webhook] Comment ${commentKey} → ${status} (${updated.count} event)`,
      );
    }

    const orgId = await this.resolveOrgId(pageId);
    if (orgId) {
      await this.redisCache.bumpPageRevision(orgId, pageId);
    }

    const sample = await this.prisma.webhookEvent.findFirst({
      where: {
        pageId,
        OR: [{ commentId: commentKey }, { messageId: commentKey }],
      },
    });
    const threadId = sample ? buildThreadId(sample) : null;

    this.eventsGateway.emitContentRemoved({
      pageId,
      threadId: threadId ?? undefined,
      commentId: commentKey,
      status,
    });
  }

  private async markPostCommentsVisibility(
    pageId: string,
    postId: string,
    status: EventVisibilityStatus,
  ): Promise<void> {
    const updated = await this.prisma.webhookEvent.updateMany({
      where: {
        pageId,
        postId,
        eventType: 'FEED_COMMENT',
      },
      data: { status },
    });

    this.logger.log(
      `[Webhook] Post ${postId} comments → ${status} (${updated.count} event)`,
    );

    const orgId = await this.resolveOrgId(pageId);
    if (orgId) {
      await this.redisCache.bumpPageRevision(orgId, pageId);
    }

    this.eventsGateway.emitContentRemoved({
      pageId,
      postId,
      status,
    });
  }

  private async markMessengerMessageVisibility(
    pageId: string,
    messageId: string,
    status: EventVisibilityStatus,
  ): Promise<void> {
    const updated = await this.prisma.webhookEvent.updateMany({
      where: {
        pageId,
        messageId,
        eventType: { in: ['MESSENGER', 'MESSENGER_POSTBACK'] },
      },
      data: { status },
    });

    if (updated.count > 0) {
      this.logger.log(
        `[Webhook] Messenger ${messageId} → ${status} (${updated.count} event)`,
      );
    }

    const orgId = await this.resolveOrgId(pageId);
    if (orgId) {
      await this.redisCache.bumpPageRevision(orgId, pageId);
    }

    const sample = await this.prisma.webhookEvent.findFirst({
      where: { pageId, messageId },
    });
    const threadId = sample ? buildThreadId(sample) : null;

    this.eventsGateway.emitContentRemoved({
      pageId,
      threadId: threadId ?? undefined,
      messageId,
      status,
    });
  }

  private async processMessagingEvent(
    pageId: string,
    event: any,
  ): Promise<void> {
    if (event.read || event.delivery) {
      await this.processMessagingReceipt(pageId, event);
      return;
    }

    if (!event.message && !event.postback) return;

    // Messenger: user/page thu hồi tin nhắn
    if (event.message?.is_deleted === true) {
      const mid = event.message?.mid ?? '';
      if (mid) {
        await this.markMessengerMessageVisibility(pageId, mid, EVENT_STATUS_DELETED);
      }
      return;
    }

    const extractedPostId = this.extractPostIdFromMessagingEvent(event);
    const resolvedOrgId = await this.resolveOrgId(pageId);

    if (event.postback) {
      const postId = await this.resolveMessengerPostIdForEvent(
        pageId,
        event.sender?.id ?? '',
        extractedPostId,
      );
      await this.saveAndBroadcast({
        organizationId: resolvedOrgId,
        pageId,
        eventType: 'MESSENGER_POSTBACK',
        direction: 'IN',
        senderId: event.sender?.id ?? '',
        senderName: 'Khách hàng',
        recipientId: event.recipient?.id ?? '',
        messageId: event.postback.mid ?? '',
        postId,
        msgType: 'postback',
        content: event.postback.title || event.postback.payload || '[Postback]',
        rawPayload: JSON.stringify(event),
      });
      return;
    }

    const isEcho = event.message.is_echo === true;
    const map = this.pageMapService.getSocialMap(pageId);

    if (map?.status && map.status !== 'ACTIVE') {
      this.logger.warn('[Webhook] Social account is not active. Bỏ qua.');
      return;
    }

    const senderId: string = event.sender?.id ?? '';
    const recipientId: string = event.recipient?.id ?? '';
    const messageId: string = event.message?.mid ?? '';
    const conversationId = isEcho ? recipientId : senderId;
    const direction = isEcho ? 'OUT' : 'IN';
    const postId = await this.resolveMessengerPostIdForEvent(
      pageId,
      conversationId,
      extractedPostId,
    );

    const { msgType, content, contentRaw, lastMessagePreview } =
      transformInboundMessage(event);

    await this.saveAndBroadcast({
      organizationId: map?.orgId ?? resolvedOrgId,
      pageId,
      eventType: 'MESSENGER',
      direction,
      senderId,
      senderName: isEcho ? 'Page' : 'Khách hàng',
      recipientId,
      messageId,
      postId,
      msgType,
      content: content || lastMessagePreview,
      rawPayload: contentRaw,
    });

    if (!isEcho && senderId) {
      const orgId = map?.orgId ?? resolvedOrgId;
      if (orgId) {
        void this.conversationsService
          .fetchAndCacheCustomerProfile(pageId, senderId, orgId)
          .catch((err) =>
            this.logger.warn(
              `Failed to cache customer profile ${senderId}`,
              err?.message,
            ),
          );
      }
    }

    this.logger.log(
      `[Webhook] MESSENGER ${direction} conversationId=${conversationId} pageId=${pageId}`,
    );
  }

  private async processMessagingReceipt(pageId: string, event: any): Promise<void> {
    const receipt = transformMessagingReceipt(pageId, event);
    if (!receipt) return;

    const resolvedOrgId = await this.resolveOrgId(pageId);
    const map = this.pageMapService.getSocialMap(pageId);

    await this.saveAndBroadcast({
      organizationId: map?.orgId ?? resolvedOrgId,
      pageId,
      eventType: 'MESSENGER',
      direction: receipt.direction,
      senderId: receipt.senderId,
      senderName: receipt.msgType === 'read' ? 'Khách hàng' : 'Page',
      recipientId: receipt.recipientId,
      messageId: receipt.messageId,
      postId: null,
      commentId: null,
      msgType: receipt.msgType,
      content: receipt.content,
      rawPayload: JSON.stringify(event),
    });

    this.logger.log(
      `[Webhook] ${receipt.msgType.toUpperCase()} pageId=${pageId} sender=${receipt.senderId}`,
    );
  }

  private extractPostIdFromMessagingEvent(event: any): string | null {
    return extractPostIdFromMessengerPayload(event);
  }

  /**
   * Gắn tin nhắn vào thread quảng cáo đúng:
   * - Có referral/post_id trong webhook → dùng ngay
   * - Tin tiếp theo không có referral → kế thừa postId inbound gần nhất (7 ngày)
   */
  private async resolveMessengerPostIdForEvent(
    pageId: string,
    customerPsid: string,
    fromWebhook: string | null,
  ): Promise<string | null> {
    if (fromWebhook?.trim()) return fromWebhook.trim();
    if (!customerPsid?.trim()) return null;

    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const recent = await this.prisma.webhookEvent.findFirst({
      where: {
        pageId,
        eventType: { in: ['MESSENGER', 'MESSENGER_POSTBACK'] },
        direction: 'IN',
        senderId: customerPsid,
        postId: { not: null },
        createdAt: { gte: cutoff },
      },
      orderBy: { createdAt: 'desc' },
      select: { postId: true },
    });

    return recent?.postId ?? null;
  }

  private async processFeedChange(
    pageId: string,
    value: Record<string, unknown>,
  ): Promise<void> {
    const item = String(value.item ?? '');
    const verb = String(value.verb ?? '');

    if (item === 'comment' && (verb === 'remove' || verb === 'hide')) {
      const commentKey = extractFeedCommentKey(value);
      if (commentKey) {
        await this.markCommentVisibility(
          pageId,
          commentKey,
          verb === 'hide' ? EVENT_STATUS_HIDDEN : EVENT_STATUS_DELETED,
        );
      }
      return;
    }

    if (item === 'comment' && verb === 'unhide') {
      const commentKey = extractFeedCommentKey(value);
      if (commentKey) {
        await this.markCommentVisibility(pageId, commentKey, EVENT_STATUS_ACTIVE);
      }
      return;
    }

    if (item === 'post' && verb === 'remove') {
      const postKey = extractFeedPostKey(value);
      if (postKey) {
        await this.markPostCommentsVisibility(pageId, postKey, EVENT_STATUS_DELETED);
      }
      return;
    }

    const parsed = transformFeedChange(value);
    if (!parsed) {
      this.logger.warn(
        `[DEBUG] processFeedChange: transformFeedChange trả null → DROP. item=${String(value?.item ?? '')} verb=${String(value?.verb ?? '')} value=${JSON.stringify(value)}`,
      );
      return;
    }

    this.logger.log(
      `[DEBUG] processFeedChange parsed OK: eventType=${parsed.eventType} item=${String(value?.item ?? '')} verb=${parsed.verb} senderId=${parsed.senderId} postId=${parsed.postId} commentId=${parsed.commentId} parentCommentId=${parsed.parentCommentId}`,
    );

    const orgId = await this.resolveOrgId(pageId);
    const isPageAction = parsed.senderId === pageId;

    let recipientId: string | null = null;
    if (isPageAction && parsed.parentCommentId && parsed.postId) {
      const parentEvent = await this.prisma.webhookEvent.findFirst({
        where: {
          pageId,
          commentId: parsed.parentCommentId,
          direction: 'IN',
        },
        select: { senderId: true },
      });
      if (parentEvent?.senderId) {
        recipientId = parentEvent.senderId;
      }
    }

    if (parsed.eventType !== 'FEED_COMMENT') {
      await this.saveAndBroadcast({
        organizationId: orgId,
        pageId,
        eventType: parsed.eventType,
        direction: 'IN',
        senderId: parsed.senderId,
        senderName: parsed.senderName,
        messageId: parsed.messageId,
        postId: parsed.postId || null,
        commentId: parsed.commentId || null,
        msgType: parsed.msgType,
        content: parsed.content,
        rawPayload: JSON.stringify(value),
      });
      return;
    }

    let postId = parsed.postId;
    this.logger.log(`[DEBUG] FEED_COMMENT: postId từ payload="${postId}" commentId="${parsed.commentId}" senderId="${parsed.senderId}" pageId="${pageId}"`);

    if (!postId && parsed.commentId && isValidFacebookCommentId(parsed.commentId)) {
      this.logger.log(`[DEBUG] postId rỗng → gọi resolvePostIdFromComment commentId=${parsed.commentId}`);
      postId = await this.resolvePostIdFromComment(
        pageId,
        parsed.commentId,
        orgId,
      );
      this.logger.log(`[DEBUG] resolvePostIdFromComment kết quả: postId="${postId}"`);
    }

    if (parsed.senderId === pageId) {
      this.logger.log(`[DEBUG] senderId===pageId → processPageCommentReply`);
      await this.processPageCommentReply(pageId, parsed, postId, orgId, value);
      return;
    }

    if (!parsed.senderId) {
      this.logger.warn(`[DEBUG] DROP: parsed.senderId rỗng`);
      return;
    }

    if (!postId) {
      this.logger.warn(
        `[DEBUG] DROP: FEED_COMMENT thiếu postId, bỏ qua commentId=${parsed.commentId}. Payload: ${JSON.stringify(value)}`,
      );
      return;
    }

    this.logger.log(
      `[DEBUG] → saveAndBroadcast FEED_COMMENT IN pageId=${pageId} postId=${postId} senderId=${parsed.senderId} commentId=${parsed.commentId}`,
    );

    await this.saveAndBroadcast({
      organizationId: orgId,
      pageId,
      eventType: 'FEED_COMMENT',
      direction: 'IN',
      senderId: parsed.senderId,
      recipientId: recipientId,
      senderName: isPageAction ? 'Page' : parsed.senderName,
      messageId: parsed.messageId,
      postId,
      commentId: parsed.commentId || null,
      parentCommentId: parsed.parentCommentId || null,
      msgType: parsed.msgType,
      content: parsed.content,
      rawPayload: JSON.stringify(value),
    });

    if (orgId) {
      void this.conversationsService
        .fetchAndCacheCustomerProfile(
          pageId,
          parsed.senderId,
          orgId,
          parsed.senderName,
        )
        .catch((err) =>
          this.logger.warn(
            `Failed to cache commenter profile ${parsed.senderId}`,
            err?.message,
          ),
        );
    }

    this.logger.log(
      `[Webhook] FEED_COMMENT IN pageId=${pageId} postId=${postId} sender=${parsed.senderId}`,
    );
  }

  private async processPageCommentReply(
    pageId: string,
    parsed: FeedEventTransform,
    postId: string,
    orgId: string | null,
    rawValue: Record<string, unknown>,
  ): Promise<void> {
    const parentId = parsed.parentId;
    if (!parentId) {
      this.logger.warn(
        `[Webhook] Page comment thiếu parent_id, bỏ qua commentId=${parsed.commentId}`,
      );
      return;
    }

    const ctx = await this.resolveCustomerForPageCommentReply(
      pageId,
      parentId,
      orgId,
    );
    if (!ctx) {
      this.logger.warn(
        `[Webhook] Không xác định được khách cho reply commentId=${parsed.commentId}`,
      );
      return;
    }

    const resolvedPostId = postId || ctx.postId;
    if (!resolvedPostId) {
      this.logger.warn(
        `[Webhook] Page reply thiếu postId, bỏ qua commentId=${parsed.commentId}`,
      );
      return;
    }

    await this.saveAndBroadcast({
      organizationId: orgId,
      pageId,
      eventType: 'FEED_COMMENT',
      direction: 'OUT',
      senderId: ctx.customerId,
      senderName: 'Page',
      recipientId: pageId,
      messageId: parsed.messageId,
      postId: resolvedPostId,
      commentId: parsed.commentId || null,
      msgType: 'feed.comment.reply',
      content: parsed.content,
      rawPayload: JSON.stringify(rawValue),
    });

    this.logger.log(
      `[Webhook] FEED_COMMENT OUT pageId=${pageId} postId=${resolvedPostId} customer=${ctx.customerId}`,
    );
  }

  private async resolvePostIdFromComment(
    pageId: string,
    commentId: string,
    orgId: string | null,
  ): Promise<string> {
    const token = await this.getPageAccessToken(pageId, orgId);
    if (!token) return '';

    const meta = await this.facebookOAuth.getCommentMeta(commentId, token);
    return meta?.postId ?? '';
  }

  private async resolveCustomerForPageCommentReply(
    pageId: string,
    parentCommentId: string,
    orgId: string | null,
  ): Promise<{ customerId: string; postId: string | null } | null> {
    const parentEvent = await this.prisma.webhookEvent.findFirst({
      where: {
        pageId,
        eventType: 'FEED_COMMENT',
        direction: 'IN',
        OR: [{ commentId: parentCommentId }, { messageId: parentCommentId }],
      },
      orderBy: { createdAt: 'desc' },
    });

    if (parentEvent?.senderId && parentEvent.senderId !== pageId) {
      return {
        customerId: parentEvent.senderId,
        postId: parentEvent.postId,
      };
    }

    const token = await this.getPageAccessToken(pageId, orgId);
    if (!token) return null;

    let currentId = parentCommentId;
    for (let depth = 0; depth < 6; depth += 1) {
      const meta = await this.facebookOAuth.getCommentMeta(currentId, token);
      if (!meta) return null;

      if (meta.fromId && meta.fromId !== pageId) {
        return {
          customerId: meta.fromId,
          postId: meta.postId ?? null,
        };
      }

      if (!meta.parentId) break;
      currentId = meta.parentId;
    }

    return null;
  }

  private async getPageAccessToken(
    pageId: string,
    orgId: string | null,
  ): Promise<string | null> {
    const resolvedOrgId =
      orgId ??
      this.pageMapService.getSocialMap(pageId)?.orgId ??
      this.configService.get<string>('DEFAULT_ORG_ID', 'default-org');

    const pages = await this.facebookRepo.listPages(resolvedOrgId);
    const page = pages.find((p) => p.pageId === pageId);
    return page?.pageAccessToken ?? null;
  }

  /**
   * Khi Meta gửi changed_fields=feed nhưng không có changes[] (thiếu include_values),
   * đồng bộ comment mới từ Graph — chỉ chạy khi nhận webhook, không phải polling.
   */
  /** Đồng bộ comment mới từ Graph (gọi từ webhook hoặc client khi tab Bình luận mở). */
  async syncCommentsForPage(
    pageId: string,
    force = false,
  ): Promise<{
    ingested: number;
    threadIds: string[];
  }> {
    return this.syncFeedCommentsFromGraph(pageId, force);
  }

  /**
   * @param force true khi được gọi từ webhook → bỏ qua cooldown nhưng vẫn giữ lock
   *              (chỉ cooldown client polling, không cooldown webhook)
   */
  private async syncFeedCommentsFromGraph(
    pageId: string,
    force = false,
  ): Promise<{
    ingested: number;
    threadIds: string[];
  }> {
    // Luôn giữ lock để tránh 2 sync chạy song song cho cùng page
    if (this.syncInProgress.has(pageId)) {
      return { ingested: 0, threadIds: [] };
    }
    // Cooldown chỉ áp dụng cho client polling (force=false)
    if (!force) {
      const last = this.syncLastAt.get(pageId) ?? 0;
      if (Date.now() - last < FacebookWebhookService.SYNC_COOLDOWN_MS) {
        return { ingested: 0, threadIds: [] };
      }
    }
    this.syncInProgress.add(pageId);
    try {
      return await this._doSyncFeedCommentsFromGraph(pageId);
    } finally {
      this.syncLastAt.set(pageId, Date.now());
      this.syncInProgress.delete(pageId);
    }
  }

  private async _doSyncFeedCommentsFromGraph(pageId: string): Promise<{
    ingested: number;
    threadIds: string[];
  }> {
    const orgId = await this.resolveOrgId(pageId);
    const token = await this.getPageAccessToken(pageId, orgId);
    if (!token) {
      this.logger.warn(
        `[Webhook] syncFeedCommentsFromGraph: không có page token pageId=${pageId}`,
      );
      return { ingested: 0, threadIds: [] };
    }

    const lastIn = await this.prisma.webhookEvent.findFirst({
      where: {
        pageId,
        eventType: 'FEED_COMMENT',
        direction: 'IN',
      },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    // Cửa sổ rộng hơn để không bỏ sót comment khi webhook chỉ báo changed_fields
    const sinceMs = lastIn
      ? lastIn.createdAt.getTime() - 5 * 60_000
      : Date.now() - 24 * 60 * 60_000;

    const threadIds = new Set<string>();
    let ingested = 0;

    try {
      const posts = await this.facebookOAuth.listPageFeedWithComments(
        pageId,
        token,
        15,
      );

      const postIds =
        posts.length > 0
          ? posts.map((p) => p.id).filter(Boolean)
          : await this.listKnownCommentPostIds(pageId, orgId);

      for (const post of posts) {
        if (!post.id) continue;
        const comments =
          post.comments?.data?.length
            ? post.comments.data
            : await this.facebookOAuth.listAllPostComments(post.id, token, {
                pageSize: 25,
                maxComments: 40,
              });

        for (const comment of comments) {
          const senderId = comment.from?.id;
          if (!senderId || senderId === pageId || !comment.id) continue;

          const createdMs = new Date(comment.created_time).getTime();
          if (!Number.isFinite(createdMs) || createdMs < sinceMs) continue;

          if (!isValidFacebookCommentId(comment.id)) continue;

          const payload = {
            organizationId: orgId,
            pageId,
            eventType: 'FEED_COMMENT' as const,
            direction: 'IN' as const,
            senderId,
            senderName: comment.from?.name ?? 'Facebook User',
            messageId: comment.id,
            postId: post.id,
            commentId: comment.id,
            msgType: 'feed.comment',
            content: comment.message ?? '[Bình luận mới trên bài viết]',
            rawPayload: JSON.stringify({
              source: 'webhook_changed_fields_sync',
              comment,
            }),
          };

          const existing = await this.findDuplicateEvent(payload);
          if (existing) {
            const threadId = buildThreadId(existing);
            if (threadId) threadIds.add(threadId);
            continue;
          }

          const saved = await this.saveAndBroadcast(payload);
          ingested += 1;
          const threadId = buildThreadId(saved);
          if (threadId) threadIds.add(threadId);
        }
      }

      if (posts.length === 0) {
        for (const postId of postIds) {
          const comments = await this.facebookOAuth.listAllPostComments(
            postId,
            token,
            { pageSize: 25, maxComments: 40 },
          );

          for (const comment of comments) {
            const senderId = comment.from?.id;
            if (!senderId || senderId === pageId || !comment.id) continue;

            const createdMs = new Date(comment.created_time).getTime();
            if (!Number.isFinite(createdMs) || createdMs < sinceMs) continue;

            if (!isValidFacebookCommentId(comment.id)) continue;

            const payload = {
              organizationId: orgId,
              pageId,
              eventType: 'FEED_COMMENT' as const,
              direction: 'IN' as const,
              senderId,
              senderName: comment.from?.name ?? 'Facebook User',
              messageId: comment.id,
              postId,
              commentId: comment.id,
              msgType: 'feed.comment',
              content: comment.message ?? '[Bình luận mới trên bài viết]',
              rawPayload: JSON.stringify({
                source: 'webhook_changed_fields_sync',
                comment,
              }),
            };

            const existing = await this.findDuplicateEvent(payload);
            if (existing) {
              const threadId = buildThreadId(existing);
              if (threadId) threadIds.add(threadId);
              continue;
            }

            const saved = await this.saveAndBroadcast(payload);
            ingested += 1;
            const threadId = buildThreadId(saved);
            if (threadId) threadIds.add(threadId);
          }
        }
      }

      if (ingested > 0) {
        this.logger.log(
          `[Webhook] syncFeedCommentsFromGraph pageId=${pageId} ingested=${ingested} threads=${threadIds.size}`,
        );
      }
    } catch (err: any) {
      this.logger.warn(
        `[Webhook] syncFeedCommentsFromGraph failed pageId=${pageId}: ${err?.message ?? err}`,
      );
    }

    if (orgId) {
      await this.redisCache.bumpPageRevision(orgId, pageId);
    }

    return { ingested, threadIds: [...threadIds] };
  }

  /** postId đã có trong webhook — dùng khi Graph feed API trả rỗng. */
  private async listKnownCommentPostIds(
    pageId: string,
    orgId: string | null,
  ): Promise<string[]> {
    const rows = await this.prisma.webhookEvent.findMany({
      where: {
        pageId,
        eventType: 'FEED_COMMENT',
        postId: { not: null },
        OR: [{ organizationId: orgId }, { organizationId: null }],
      },
      select: { postId: true },
      distinct: ['postId'],
      take: 100,
    });

    return rows.map((r) => r.postId!).filter(Boolean);
  }

  async listRecentEvents(limit = 50, eventType?: string) {
    return this.prisma.webhookEvent.findMany({
      where: eventType ? { eventType } : undefined,
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  async getWebhookStats() {
    const [inCount, outCount, lastIn, lastAny] = await Promise.all([
      this.prisma.webhookEvent.count({ where: { direction: 'IN' } }),
      this.prisma.webhookEvent.count({ where: { direction: 'OUT' } }),
      this.prisma.webhookEvent.findFirst({
        where: { direction: 'IN' },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true, content: true, messageId: true },
      }),
      this.prisma.webhookEvent.findFirst({
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true, direction: true, content: true },
      }),
    ]);

    return { inCount, outCount, lastIn, lastAny };
  }

  async countEventsByType(
    eventType: string,
    direction?: string,
  ): Promise<number> {
    return this.prisma.webhookEvent.count({
      where: {
        eventType,
        ...(direction ? { direction } : {}),
      },
    });
  }

  async getEventById(id: string): Promise<WebhookEvent | null> {
    return this.prisma.webhookEvent.findUnique({ where: { id } });
  }

  /** Thích bình luận qua Graph API (Page like). */
  async likeCommentOnPage(
    pageId: string,
    commentId: string,
  ): Promise<{ success: boolean }> {
    if (!pageId?.trim() || !commentId?.trim()) {
      throw new BadRequestException('Thiếu pageId hoặc commentId');
    }
    if (!isValidFacebookCommentId(commentId)) {
      throw new BadRequestException('commentId không hợp lệ');
    }

    const token = await this.getPageAccessToken(pageId, null);
    if (!token) {
      throw new BadRequestException('Fanpage chưa liên kết hoặc thiếu token');
    }

    return this.facebookOAuth.likeComment(commentId, token);
  }

  /** Ẩn / hiện bình luận trên Facebook và cập nhật trạng thái local. */
  async setCommentHiddenOnPage(
    pageId: string,
    commentId: string,
    hidden: boolean,
  ): Promise<{ success: boolean }> {
    if (!pageId?.trim() || !commentId?.trim()) {
      throw new BadRequestException('Thiếu pageId hoặc commentId');
    }
    if (!isValidFacebookCommentId(commentId)) {
      throw new BadRequestException('commentId không hợp lệ');
    }

    const token = await this.getPageAccessToken(pageId, null);
    if (!token) {
      throw new BadRequestException('Fanpage chưa liên kết hoặc thiếu token');
    }

    await this.facebookOAuth.setCommentHidden(commentId, token, hidden);
    await this.markCommentVisibility(
      pageId,
      commentId,
      hidden ? EVENT_STATUS_HIDDEN : EVENT_STATUS_ACTIVE,
    );

    return { success: true };
  }
}
