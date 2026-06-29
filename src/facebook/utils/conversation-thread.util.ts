import type { Prisma, WebhookEvent } from '@prisma/client';
import { isMessagingReceiptMsgType } from './facebook-payload.util';
import { isVisibleEvent } from './event-visibility.util';

export type ConversationKind = 'MESSENGER' | 'FEED_COMMENT';

export interface ConversationThread {
  id: string;
  kind: ConversationKind;
  pageId: string;
  senderId: string;
  senderName: string;
  senderPictureUrl?: string | null;
  preview: string;
  lastMessageAt: string;
  postId: string | null;
  commentId: string | null;
  messageCount: number;
  unreadCount: number;
}

const GENERIC_SENDER_NAMES = new Set([
  'Khách hàng',
  'Page',
  'Facebook User',
]);

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

/**
 * Resolves the root comment ID for a FEED_COMMENT event.
 * Facebook only supports 1 level of nesting, so parentCommentId IS the root.
 */
export function resolveRootCommentId(event: WebhookEvent): string | null {
  return event.parentCommentId ?? event.commentId ?? null;
}

export function buildThreadId(event: WebhookEvent): string | null {
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

    const rootCommentId = resolveRootCommentId(event);
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

export function parseThreadId(threadId: string): {
  kind: ConversationKind;
  pageId: string;
  senderId: string;
  postId?: string;
  commentId?: string;
} | null {
  const parts = threadId.split(':');
  if (parts[0] === 'messenger' && parts.length >= 3) {
    return {
      kind: 'MESSENGER',
      pageId: parts[1],
      senderId: parts.slice(2).join(':'),
    };
  }
  if (parts[0] === 'comment' && parts.length >= 5) {
    return {
      kind: 'FEED_COMMENT',
      pageId: parts[1],
      postId: parts[2],
      senderId: parts[3],
      commentId: parts.slice(4).join(':'),
    };
  }
  if (parts[0] === 'comment' && parts.length >= 4) {
    return {
      kind: 'FEED_COMMENT',
      pageId: parts[1],
      postId: parts[2],
      senderId: parts.slice(3).join(':'),
    };
  }
  return null;
}

export function eventBelongsToThread(
  event: WebhookEvent,
  threadId: string,
): boolean {
  return buildThreadId(event) === threadId;
}

export function buildThreadEventWhere(
  threadId: string,
  pageId: string,
  orgId: string,
): Prisma.WebhookEventWhereInput | null {
  const parsed = parseThreadId(threadId);
  if (!parsed || parsed.pageId !== pageId) return null;

  const base: Prisma.WebhookEventWhereInput = {
    pageId,
    OR: [{ organizationId: orgId }, { organizationId: null }],
  };

  if (parsed.kind === 'MESSENGER') {
    return {
      ...base,
      eventType: { in: ['MESSENGER', 'MESSENGER_POSTBACK'] },
      OR: [{ senderId: parsed.senderId }, { recipientId: parsed.senderId }],
    };
  }

  if (parsed.commentId) {
    return {
      pageId,
      eventType: 'FEED_COMMENT',
      postId: parsed.postId,
      AND: [
        { OR: [{ organizationId: orgId }, { organizationId: null }] },
        {
          OR: [
            { commentId: parsed.commentId },
            { parentCommentId: parsed.commentId },
          ],
        },
      ],
    };
  }

  // Legacy fallback: old thread IDs without rootCommentId
  return {
    pageId,
    eventType: 'FEED_COMMENT',
    postId: parsed.postId,
    AND: [
      { OR: [{ organizationId: orgId }, { organizationId: null }] },
      {
        OR: [
          { senderId: parsed.senderId },
          { senderId: parsed.pageId, direction: 'OUT', recipientId: parsed.senderId },
          { senderId: parsed.pageId, direction: 'OUT', recipientId: null },
        ],
      },
    ],
  };
}

export function resolveCustomerId(event: WebhookEvent): string {
  if (event.eventType === 'FEED_COMMENT') {
    if (event.direction === 'OUT') {
      if (event.recipientId && event.recipientId !== event.pageId) {
        return event.recipientId;
      }
      if (event.senderId && event.senderId !== event.pageId) {
        return event.senderId;
      }
      return event.recipientId ?? '';
    }
    return event.senderId ?? '';
  }

  if (event.direction === 'OUT') {
    return event.recipientId ?? '';
  }

  return event.senderId ?? '';
}

export function aggregateConversations(
  events: WebhookEvent[],
  readAtByThread: ReadonlyMap<string, Date> = new Map(),
): ConversationThread[] {
  const map = new Map<string, ConversationThread & { _latest: number }>();
  const latestOutboundByThread = new Map<string, number>();

  for (const event of events) {
    if (isMessagingReceiptMsgType(event.msgType)) continue;
    if (event.direction !== 'OUT') continue;

    const threadId = buildThreadId(event);
    if (!threadId) continue;

    const ts = new Date(event.createdAt).getTime();
    const current = latestOutboundByThread.get(threadId) ?? 0;
    if (ts > current) latestOutboundByThread.set(threadId, ts);
  }

  for (const event of events) {
    if (isMessagingReceiptMsgType(event.msgType)) continue;

    const threadId = buildThreadId(event);
    if (!threadId) continue;

    const ts = new Date(event.createdAt).getTime();
    const kind: ConversationKind =
      event.eventType === 'FEED_COMMENT' ? 'FEED_COMMENT' : 'MESSENGER';

    const existing = map.get(threadId);
    const customerId = resolveCustomerId(event);
    const readAt = readAtByThread.get(threadId)?.getTime();
    const unreadCutoff = readAt ?? latestOutboundByThread.get(threadId) ?? 0;
    const isUnreadInbound =
      isVisibleEvent(event) && event.direction === 'IN' && ts > unreadCutoff;

    if (!existing) {
      const inboundName =
        event.direction === 'IN' &&
        event.senderName &&
        !isGenericSenderName(event.senderName)
          ? event.senderName
          : 'Khách hàng';

      map.set(threadId, {
        id: threadId,
        kind,
        pageId: event.pageId!,
        senderId: customerId,
        senderName: inboundName,
        preview: event.content ?? '',
        lastMessageAt: event.createdAt.toISOString(),
        postId: event.postId,
        commentId: rootCommentId ?? event.commentId,
        messageCount: 1,
        unreadCount: isUnreadInbound ? 1 : 0,
        _latest: ts,
      });
      continue;
    }

    existing.messageCount += 1;
    if (isUnreadInbound) {
      existing.unreadCount += 1;
    }
    if (ts >= existing._latest) {
      existing._latest = ts;
      existing.lastMessageAt = event.createdAt.toISOString();
      existing.preview = event.content ?? existing.preview;
      if (
        event.direction === 'IN' &&
        event.senderName &&
        !isGenericSenderName(event.senderName)
      ) {
        existing.senderName = event.senderName;
      }
    }
  }

  return [...map.values()]
    .sort((a, b) => b._latest - a._latest)
    .map(({ _latest, ...thread }) => thread);
}
