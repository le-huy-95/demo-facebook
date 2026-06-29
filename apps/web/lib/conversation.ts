import type { WebhookMessage } from './api';

const GENERIC_SENDER_NAMES = new Set(['Khách hàng', 'Page', 'Facebook User']);

export function isGenericSenderName(name: string | null | undefined): boolean {
  if (!name?.trim()) return true;
  return GENERIC_SENDER_NAMES.has(name.trim());
}

export function pickBetterSenderName(
  primary: string | null | undefined,
  fallback: string | null | undefined,
): string {
  if (!isGenericSenderName(primary)) return primary!.trim();
  if (!isGenericSenderName(fallback)) return fallback!.trim();
  return primary?.trim() || fallback?.trim() || 'Khách hàng';
}

export function buildThreadIdFromEvent(event: WebhookMessage): string | null {
  if (!event.pageId) return null;

  if (
    event.eventType === 'MESSENGER' ||
    event.eventType === 'MESSENGER_POSTBACK'
  ) {
    const customerId =
      event.direction === 'OUT' ? event.recipientId : event.senderId;
    if (!customerId) return null;
    return `messenger:${event.pageId}:${customerId}`;
  }

  if (event.eventType === 'FEED_COMMENT') {
    if (!event.postId) return null;

    const rootCommentId = event.parentCommentId ?? event.commentId;
    if (!rootCommentId) return null;

    let customerId: string | null;
    if (event.direction === 'OUT') {
      if (event.senderId && event.senderId !== event.pageId) {
        customerId = event.senderId;
      } else {
        customerId = event.recipientId;
      }
    } else {
      customerId = event.senderId;
    }

    if (!customerId || customerId === event.pageId) return null;
    return `comment:${event.pageId}:${event.postId}:${customerId}:${rootCommentId}`;
  }

  return null;
}

export function resolveCustomerNameFromMessages(
  messages: WebhookMessage[],
  fallback: string,
): string {
  for (const msg of messages) {
    if (msg.direction === 'IN' && msg.senderName && !isGenericSenderName(msg.senderName)) {
      return msg.senderName;
    }
  }
  return pickBetterSenderName(fallback, undefined);
}
