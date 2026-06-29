import { Injectable, Inject, forwardRef } from '@nestjs/common';
import type { WebhookEvent } from '@prisma/client';
import { AppLogger } from '../../common/logger.service';
import { MessageRepository } from '../../infrastructure/persistence/repositories/message.repository';
import { BroadcastService } from '../../infrastructure/broadcast/broadcast.service';
import { RedisCacheService } from '../../redis/redis-cache.service';
import { buildThreadId } from '../utils/conversation-thread.util';
import type { MessageDeliveryStatus } from '../../types/message.types';

export interface SaveOutboundInput {
  organizationId: string;
  pageId: string;
  eventType: 'MESSENGER' | 'FEED_COMMENT';
  direction: 'OUT';
  senderId: string;
  senderName: string;
  recipientId: string;
  messageId?: string | null;
  postId?: string | null;
  commentId?: string | null;
  parentCommentId?: string | null;
  msgType: string;
  content: string;
  rawPayload: string;
  clientMessageId?: string;
}

/**
 * Lifecycle dữ liệu tin nhắn Facebook:
 * - Lưu DB (persist-first) trước khi gọi Graph API
 * - Broadcast realtime qua Kafka/Socket
 * - Cập nhật delivery status sau Graph API
 */
@Injectable()
export class FacebookDataService {
  constructor(
    private readonly messageRepo: MessageRepository,
    @Inject(forwardRef(() => BroadcastService))
    private readonly broadcast: BroadcastService,
    private readonly redisCache: RedisCacheService,
    private readonly logger: AppLogger,
  ) {
    this.logger.setContext(FacebookDataService.name);
  }

  /** Bước 1 outbound: lưu SENDING + broadcast realtime */
  async saveAndBroadcastOutbound(
    input: SaveOutboundInput,
  ): Promise<WebhookEvent> {
    const saved = await this.messageRepo.saveMessageHistory({
      ...input,
      deliveryStatus: 'SENDING' as const,
    });

    await this.invalidateCaches(saved);
    this.broadcast.broadcastMessageReceive(saved);
    return saved;
  }

  /** Bước 5 outbound: cập nhật DELIVERED/FAILED + broadcast kết quả */
  async applySendResult(
    recordId: string,
    deliveryStatus: MessageDeliveryStatus,
    messageId?: string | null,
    commentId?: string | null,
  ): Promise<WebhookEvent> {
    const updated = await this.messageRepo.updateDeliveryStatus(
      recordId,
      deliveryStatus,
      messageId,
      commentId,
    );
    await this.invalidateCaches(updated);
    this.broadcast.broadcastSendResult(updated, deliveryStatus);
    return updated;
  }

  /** Inbound webhook: lưu DB + broadcast (không gọi Graph API) */
  async saveInboundAndBroadcast(
    data: Parameters<MessageRepository['saveMessageHistory']>[0],
  ): Promise<WebhookEvent> {
    const saved = await this.messageRepo.saveMessageHistory(data);
    await this.invalidateCaches(saved);
    this.broadcast.broadcastMessageReceive(saved);
    return saved;
  }

  private async invalidateCaches(event: WebhookEvent): Promise<void> {
    if (!event.pageId) return;
    const orgId = event.organizationId ?? 'default-org';
    await this.redisCache.bumpPageRevision(orgId, event.pageId);
    const threadId = buildThreadId(event);
    if (threadId) {
      await this.redisCache.bumpThreadRevision(event.pageId, threadId);
    }
  }
}
