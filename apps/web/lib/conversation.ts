import type { ConversationThread, WebhookMessage } from './api';
import { isActiveContentStatus } from '@/lib/event-status';

const GENERIC_SENDER_NAMES = new Set(['Khách hàng', 'Page', 'Facebook User']);

export function isGenericSenderName(name: string | null | undefined): boolean {
  if (!name?.trim()) return true;
  return GENERIC_SENDER_NAMES.has(name.trim());
}

/** Facebook comment id: `{postStoryId}_{commentFbid}` */
export function isValidFacebookCommentId(
  commentId: string | null | undefined,
): boolean {
  if (!commentId?.trim()) return false;
  return /^\d+(?:_\d+)+$/.test(commentId.trim());
}

export function pickBetterSenderName(
  primary: string | null | undefined,
  fallback: string | null | undefined,
): string {
  if (!isGenericSenderName(primary)) return primary!.trim();
  if (!isGenericSenderName(fallback)) return fallback!.trim();
  return primary?.trim() || fallback?.trim() || 'Khách hàng';
}

function parseRawPayload(
  raw: string | null | undefined,
): Record<string, unknown> | null {
  if (!raw?.trim()) return null;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function normalizeFbPostId(raw: string): string | null {
  if (/^\d+_\d+$/.test(raw)) return raw;
  const m = raw.match(/(\d+_\d+)/);
  return m?.[1] ?? (/^\d+$/.test(raw) ? raw : null);
}

/** Trích postId quảng cáo từ rawPayload Messenger (referral). */
export function extractMessengerPostIdFromRaw(
  raw: Record<string, unknown>,
): string | null {
  const referral =
    raw.referral ??
    (raw.message as Record<string, unknown> | undefined)?.referral ??
    (raw.postback as Record<string, unknown> | undefined)?.referral;

  if (referral && typeof referral === 'object') {
    const ref = referral as Record<string, unknown>;
    const adsPostId = (ref.ads_context_data as Record<string, unknown> | undefined)
      ?.post_id;
    if (typeof adsPostId === 'string' && adsPostId.trim()) {
      const normalized = normalizeFbPostId(adsPostId.trim());
      if (normalized) return normalized;
    }
    const rawRef = ref.ref ?? ref.ad_id;
    if (typeof rawRef === 'string' && rawRef.trim()) {
      const normalized = normalizeFbPostId(rawRef.trim());
      if (normalized) return normalized;
    }
  }
  return null;
}

export function getRealtimeEventKey(event: WebhookMessage): string {
  if (event.messageId) return `mid:${event.messageId}`;
  if (event.commentId) return `cid:${event.commentId}`;
  return `id:${event.id}`;
}

/** Bổ sung postId/senderId/parentCommentId từ rawPayload webhook khi DB thiếu field. */
export function enrichEventForThread(event: WebhookMessage): WebhookMessage {
  const raw = parseRawPayload(event.rawPayload);

  if (
    event.eventType === 'MESSENGER' ||
    event.eventType === 'MESSENGER_POSTBACK'
  ) {
    if (event.postId) return event;
    const postFromRaw = raw ? extractMessengerPostIdFromRaw(raw) : null;
    if (!postFromRaw) return event;
    return { ...event, postId: postFromRaw };
  }

  if (event.eventType !== 'FEED_COMMENT') return event;

  const alreadyFull =
    event.postId &&
    event.senderId &&
    (event.parentCommentId !== undefined || event.commentId);
  if (alreadyFull) return event;

  if (!raw) return event;

  const from = (raw.from ?? {}) as { id?: string; name?: string };

  const postId =
    event.postId ??
    (typeof raw.post_id === 'string' ? raw.post_id : null) ??
    (typeof raw.parent_id === 'string' && /^\d+_\d+$/.test(raw.parent_id)
      ? raw.parent_id
      : null);

  const senderId = event.senderId ?? from.id ?? null;
  const resolvedPostId = postId ?? event.postId ?? null;

  const parentIdRaw =
    typeof raw.parent_id === 'string' && /^\d+_\d+$/.test(raw.parent_id)
      ? raw.parent_id
      : null;
  const parentCommentId =
    event.parentCommentId !== undefined
      ? event.parentCommentId
      : parentIdRaw && parentIdRaw !== resolvedPostId
        ? parentIdRaw
        : null;

  if (!postId && !senderId && parentCommentId === event.parentCommentId) {
    return event;
  }
  return {
    ...event,
    postId: postId ?? event.postId,
    senderId: senderId ?? event.senderId,
    senderName: event.senderName ?? from.name ?? event.senderName,
    parentCommentId: parentCommentId ?? event.parentCommentId,
  };
}

/**
 * Tính threadId từ event — mirror CHÍNH XÁC logic backend `buildThreadId`.
 *
 * MESSENGER/POSTBACK : `messenger:{pageId}:{customerId}` hoặc `...:{postId}` (quảng cáo)
 * FEED_COMMENT       : `comment:{pageId}:{postId}:{customerId}:{rootCommentId}`
 */
export function buildThreadIdFromEvent(event: WebhookMessage): string | null {
  const enriched = enrichEventForThread(event);
  if (!enriched.pageId) return null;

  if (
    enriched.eventType === 'MESSENGER' ||
    enriched.eventType === 'MESSENGER_POSTBACK'
  ) {
    const customerId =
      enriched.direction === 'OUT'
        ? enriched.recipientId
        : enriched.senderId;
    if (!customerId) return null;
    const postId = enriched.postId?.trim();
    if (postId) {
      return `messenger:${enriched.pageId}:${customerId}:${postId}`;
    }
    return `messenger:${enriched.pageId}:${customerId}`;
  }

  if (enriched.eventType === 'FEED_COMMENT') {
    if (!enriched.postId) return null;

    // rootCommentId: parentCommentId nếu là reply, commentId nếu là root comment
    const rootCommentId = enriched.parentCommentId ?? enriched.commentId;
    if (!rootCommentId) return null;

    // customerId: bên gửi là khách (không phải page)
    let customerId: string | null;
    if (enriched.direction === 'OUT') {
      customerId =
        enriched.senderId && enriched.senderId !== enriched.pageId
          ? enriched.senderId
          : enriched.recipientId;
    } else {
      customerId = enriched.senderId;
    }
    if (!customerId || customerId === enriched.pageId) return null;

    return `comment:${enriched.pageId}:${enriched.postId}:${customerId}:${rootCommentId}`;
  }

  return null;
}

export function resolveThreadIdFromEvent(event: WebhookMessage): string | null {
  return buildThreadIdFromEvent(event);
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

export function buildMessengerThreadId(pageId: string, senderId: string): string {
  return `messenger:${pageId}:${senderId}`;
}

/** Id bình luận Facebook dùng để so khớp / scroll. */
export function getMessageCommentKey(
  msg: WebhookMessage,
): string | null {
  const id = msg.commentId ?? msg.messageId;
  return isValidFacebookCommentId(id) ? id! : null;
}

/** Lấy id bình luận cha từ rawPayload Graph/webhook. */
export function extractParentCommentId(msg: WebhookMessage): string | null {
  const raw = parseRawPayload(msg.rawPayload);
  if (!raw) return null;

  const parent = raw.parent as { id?: string } | undefined;
  const parentId =
    parent?.id ??
    (typeof raw.parent_id === 'string' ? raw.parent_id : null);
  return isValidFacebookCommentId(parentId) ? parentId : null;
}

export function findCommentMessageById(
  messages: WebhookMessage[],
  commentId: string,
): WebhookMessage | undefined {
  return messages.find((msg) => getMessageCommentKey(msg) === commentId);
}

/** rootCommentId nhúng trong threadId FEED_COMMENT. */
export function parseRootCommentIdFromThreadId(
  threadId: string | null | undefined,
): string | null {
  if (!threadId?.startsWith('comment:')) return null;
  const parts = threadId.split(':');
  if (parts.length < 5) return null;
  const rootId = parts.slice(4).join(':');
  return isValidFacebookCommentId(rootId) ? rootId : null;
}

/** Mặc định reply vào bình luận IN mới nhất của khách (không dùng comment OUT của Page). */
export function pickDefaultReplyComment(
  messages: WebhookMessage[],
  pageId: string,
): { commentId: string | null; preview: string | null } {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (
      msg.eventType !== 'FEED_COMMENT' ||
      msg.direction !== 'IN' ||
      msg.senderId === pageId ||
      !isActiveContentStatus(msg.status)
    ) {
      continue;
    }

    const id = msg.commentId ?? msg.messageId;
    if (isValidFacebookCommentId(id)) {
      return { commentId: id!, preview: msg.content ?? null };
    }
  }

  return { commentId: null, preview: null };
}

/** Target reply comment — ưu tiên IN mới nhất, fallback rootCommentId từ threadId. */
export function resolveFeedCommentReplyTarget(
  threadId: string,
  messages: WebhookMessage[],
  pageId: string,
): { commentId: string | null; preview: string | null } {
  const fromMessages = pickDefaultReplyComment(messages, pageId);
  if (fromMessages.commentId) return fromMessages;

  const rootId = parseRootCommentIdFromThreadId(threadId);
  if (!rootId) return { commentId: null, preview: null };

  const target = findCommentMessageById(messages, rootId);
  return {
    commentId: rootId,
    preview: target?.content ?? null,
  };
}

/** URL xem bình luận trên Facebook. */
export function buildFacebookCommentUrl(
  commentId: string,
  postPermalinkUrl?: string | null,
): string {
  const fbid = commentId.split('_').at(-1);
  if (postPermalinkUrl && fbid) {
    const base = postPermalinkUrl.split('?')[0];
    return `${base}?comment_id=${fbid}`;
  }
  return `https://www.facebook.com/${commentId}`;
}

/** Tag @tên khi trả lời bình luận. */
export function formatReplyMention(senderName: string | null | undefined): string {
  const name = senderName?.trim();
  if (!name) return '';
  return `@${name} `;
}

/** Gộp tin nhắn theo messageId/id, giữ optimistic chưa có trên server. */
export function mergeThreadMessages(
  prev: WebhookMessage[],
  incoming: WebhookMessage[],
): WebhookMessage[] {
  const map = new Map<string, WebhookMessage>();

  for (const msg of prev) {
    map.set(msg.messageId ?? msg.id, msg);
  }
  for (const msg of incoming) {
    const key = msg.messageId ?? msg.id;
    const existing = map.get(key);
    map.set(key, existing ? { ...existing, ...msg } : msg);
  }

  return [...map.values()].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  );
}

export function buildThreadFromEvent(
  event: WebhookMessage,
  threadId: string,
): ConversationThread | null {
  if (!event.pageId) return null;

  const kind =
    event.eventType === 'FEED_COMMENT' ? 'FEED_COMMENT' : 'MESSENGER';
  const customerId =
    kind === 'FEED_COMMENT'
      ? event.senderId
      : event.direction === 'OUT'
        ? event.recipientId
        : event.senderId;

  if (!customerId) return null;

  return {
    id: threadId,
    kind,
    pageId: event.pageId,
    senderId: customerId,
    senderName: pickBetterSenderName(event.senderName, 'Khách hàng'),
    preview: event.content ?? '',
    lastMessageAt: event.createdAt,
    postId: event.postId,
    commentId: event.commentId,
    messageCount: 1,
    unreadCount: event.direction === 'IN' ? 1 : 0,
  };
}
