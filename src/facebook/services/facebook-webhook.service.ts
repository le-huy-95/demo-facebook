import { Injectable } from '@nestjs/common';
import type { WebhookEvent } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AppLogger } from '../../common/logger.service';
import { PageMapService } from '../services/page-map.service';
import { EventsService } from '../services/events.service';
import { EventsGateway } from '../gateways/events.gateway';
import { ConversationsService } from '../services/conversations.service';
import {
  transformInboundMessage,
  transformMessagingReceipt,
} from '../utils/facebook-payload.util';
import { transformFeedChange } from '../utils/facebook-feed.util';
import { buildThreadId } from '../utils/conversation-thread.util';
import { RedisCacheService } from '../../redis/redis-cache.service';

type WebhookEventCreateData = Parameters<
  PrismaService['webhookEvent']['create']
>[0]['data'];

@Injectable()
export class FacebookWebhookService {
  constructor(
    private readonly logger: AppLogger,
    private readonly prisma: PrismaService,
    private readonly pageMapService: PageMapService,
    private readonly eventsService: EventsService,
    private readonly eventsGateway: EventsGateway,
    private readonly conversationsService: ConversationsService,
    private readonly redisCache: RedisCacheService,
  ) {
    this.logger.setContext(FacebookWebhookService.name);
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

      for (const change of entry.changes ?? []) {
        if (change.field === 'feed') {
          await this.processFeedChange(pageId, change.value);
        }
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
    if (!data.pageId || !data.messageId) return null;

    return this.prisma.webhookEvent.findFirst({
      where: {
        pageId: data.pageId,
        messageId: data.messageId,
        msgType: data.msgType ?? undefined,
      },
    });
  }

  private async saveAndBroadcast(data: WebhookEventCreateData) {
    const duplicate = await this.findDuplicateEvent(data);
    if (duplicate) {
      this.logger.debug(
        `[Webhook] Duplicate skipped pageId=${data.pageId} messageId=${data.messageId} msgType=${data.msgType}`,
      );
      return duplicate;
    }

    const saved = await this.prisma.webhookEvent.create({ data });
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

  private async processMessagingEvent(
    pageId: string,
    event: any,
  ): Promise<void> {
    if (event.read || event.delivery) {
      await this.processMessagingReceipt(pageId, event);
      return;
    }

    if (!event.message && !event.postback) return;

    const postId = this.extractPostIdFromMessagingEvent(event);
    const resolvedOrgId = await this.resolveOrgId(pageId);

    if (event.postback) {
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
    const referral =
      event?.referral ?? event?.message?.referral ?? event?.postback?.referral;
    const rawRef: unknown = referral?.ref ?? referral?.ad_id ?? null;

    if (typeof rawRef === 'string' && rawRef) {
      if (/^\d+_\d+$/.test(rawRef)) return rawRef;

      const m = rawRef.match(/(\d+_\d+)/);
      if (m?.[1]) return m[1];
    }

    const url: unknown =
      event?.message?.attachments?.[0]?.payload?.url ??
      event?.message?.attachments?.[0]?.url ??
      null;

    if (typeof url === 'string' && url) {
      try {
        const u = new URL(url);
        const storyFbid = u.searchParams.get('story_fbid');
        const id = u.searchParams.get('id');
        if (storyFbid && id) {
          return `${id}_${storyFbid}`;
        }
      } catch {
        // ignore invalid URL
      }
    }

    return null;
  }

  private async processFeedChange(
    pageId: string,
    value: Record<string, unknown>,
  ): Promise<void> {
    const parsed = transformFeedChange(value);
    if (!parsed) return;

    const orgId = await this.resolveOrgId(pageId);

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

    if (parsed.eventType === 'FEED_COMMENT' && parsed.senderId) {
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
    }

    this.logger.log(
      `[Webhook] ${parsed.eventType} pageId=${pageId} postId=${parsed.postId}`,
    );
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

  async getEventById(id: string): Promise<WebhookEvent | null> {
    return this.prisma.webhookEvent.findUnique({ where: { id } });
  }
}
