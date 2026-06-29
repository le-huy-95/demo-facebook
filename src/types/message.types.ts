import type { WebhookEvent } from '@prisma/client';

/** Trạng thái gửi tin đi (OUT) — persist-first trước khi gọi Graph API */
export type MessageDeliveryStatus = 'SENDING' | 'DELIVERED' | 'FAILED';

/** Bản ghi message_history (Prisma webhook_events trong demo, Cassandra trong production) */
export type MessageHistoryRecord = WebhookEvent;

export interface OutboundSendPayload {
  pageId: string;
  threadId: string;
  text?: string;
  attachment?: {
    type: 'image' | 'video' | 'audio' | 'file';
    url: string;
  };
  commentId?: string;
  replyToMessageId?: string;
  clientMessageId?: string;
  orgId: string;
  userId?: string;
}
