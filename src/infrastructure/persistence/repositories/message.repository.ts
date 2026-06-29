import { Injectable } from '@nestjs/common';
import type { WebhookEvent, Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import type { MessageDeliveryStatus } from '../../../types/message.types';
import { buildThreadEventWhere } from '../../../facebook/utils/conversation-thread.util';

type WebhookEventCreateData = Prisma.WebhookEventCreateInput & {
  /** Chỉ dùng trong rawPayload — không có cột DB */
  clientMessageId?: string;
};

function toPersistData(data: WebhookEventCreateData): Prisma.WebhookEventCreateInput {
  const { clientMessageId: _omit, ...persist } = data;
  return persist;
}

/**
 * Repository message_history — demo dùng Prisma/SQLite, production = Cassandra.
 * Chỉ đọc/ghi DB, không gọi Facebook Graph API.
 */
@Injectable()
export class MessageRepository {
  constructor(private readonly prisma: PrismaService) {}

  async saveMessageHistory(data: WebhookEventCreateData): Promise<WebhookEvent> {
    return this.prisma.webhookEvent.create({ data: toPersistData(data) });
  }

  async updateDeliveryStatus(
    id: string,
    deliveryStatus: MessageDeliveryStatus,
    messageId?: string | null,
    commentId?: string | null,
  ): Promise<WebhookEvent> {
    return this.prisma.webhookEvent.update({
      where: { id },
      data: {
        deliveryStatus,
        ...(messageId !== undefined ? { messageId } : {}),
        ...(commentId !== undefined ? { commentId } : {}),
      },
    });
  }

  async findByMessageId(
    pageId: string,
    messageId: string,
  ): Promise<WebhookEvent | null> {
    return this.prisma.webhookEvent.findFirst({
      where: {
        pageId,
        messageId,
        eventType: { in: ['MESSENGER', 'MESSENGER_POSTBACK'] },
      },
    });
  }

  async getMessageHistory(
    threadId: string,
    pageId: string,
    orgId: string,
    options?: { limit?: number; before?: Date },
  ): Promise<{ messages: WebhookEvent[]; hasMore: boolean }> {
    const threadWhere = buildThreadEventWhere(threadId, pageId, orgId);
    if (!threadWhere) {
      return { messages: [], hasMore: false };
    }

    const limit = options?.limit ?? 15;
    const where = {
      ...threadWhere,
      ...(options?.before ? { createdAt: { lt: options.before } } : {}),
    };

    const events = await this.prisma.webhookEvent.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
    });

    const hasMore = events.length > limit;
    const pageEvents = hasMore ? events.slice(0, limit) : events;
    return {
      messages: [...pageEvents].reverse(),
      hasMore,
    };
  }

  async listEventsForPage(
    pageId: string,
    orgId: string,
    take = 2000,
  ): Promise<WebhookEvent[]> {
    return this.prisma.webhookEvent.findMany({
      where: {
        pageId,
        OR: [{ organizationId: orgId }, { organizationId: null }],
        eventType: { in: ['MESSENGER', 'MESSENGER_POSTBACK', 'FEED_COMMENT'] },
        status: { not: 'DELETED' },
      },
      orderBy: { createdAt: 'desc' },
      take,
    });
  }
}
