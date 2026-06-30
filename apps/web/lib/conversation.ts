import type { ConversationThread, WebhookMessage } from './api';
import { isActiveContentStatus } from '@/lib/event-status';
import { formatConversationThreadPreview } from '@/lib/message-content';

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

/** Facebook Messenger message id (mid) từ webhook — dùng cho reaction/ghim. */
export function isValidMessengerMessageId(
  messageId: string | null | undefined,
): boolean {
  const id = messageId?.trim();
  return !!id && id.startsWith('m_');
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

function parseClientMessageId(msg: WebhookMessage): string | null {
  const raw = parseRawPayload(msg.rawPayload);
  const id = raw?.clientMessageId;
  return typeof id === 'string' && id.trim() ? id.trim() : null;
}

function outboundContentMatches(a: string | null, b: string | null): boolean {
  const left = a?.trim();
  const right = b?.trim();
  if (!left || !right) return false;
  if (left === right) return true;
  return left.includes(right) || right.includes(left);
}

/** Loại bỏ trùng id (optimistic + socket + refetch). */
export function dedupeThreadMessagesById(
  messages: WebhookMessage[],
): WebhookMessage[] {
  const map = new Map<string, WebhookMessage>();
  for (const msg of messages) {
    const existing = map.get(msg.id);
    map.set(msg.id, existing ? { ...existing, ...msg } : msg);
  }
  return [...map.values()].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  );
}

/** Gộp/cập nhật 1 tin — tránh duplicate khi gửi OUT (optimistic + socket + ack). */
export function upsertThreadMessage(
  messages: WebhookMessage[],
  incoming: WebhookMessage,
): WebhookMessage[] {
  const incomingClientId = parseClientMessageId(incoming);
  const incomingCommentKey = incoming.commentId ?? incoming.messageId;

  let replaced = false;
  const next = messages.map((msg) => {
    if (msg.id === incoming.id) {
      replaced = true;
      return { ...msg, ...incoming };
    }

    const msgClientId = parseClientMessageId(msg);
    if (incomingClientId && msg.id === incomingClientId) {
      replaced = true;
      return { ...msg, ...incoming, id: incoming.id };
    }
    if (incomingClientId && msgClientId === incomingClientId) {
      replaced = true;
      return { ...msg, ...incoming, id: incoming.id };
    }

    const msgCommentKey = msg.commentId ?? msg.messageId;
    if (
      incomingCommentKey &&
      msgCommentKey &&
      incomingCommentKey === msgCommentKey
    ) {
      replaced = true;
      return { ...msg, ...incoming, id: incoming.id };
    }

    if (
      incoming.direction === 'OUT' &&
      msg.id.startsWith('client-') &&
      msg.direction === 'OUT' &&
      outboundContentMatches(msg.content, incoming.content)
    ) {
      replaced = true;
      return { ...msg, ...incoming, id: incoming.id };
    }

    return msg;
  });

  return dedupeThreadMessagesById(
    replaced ? next : [...messages, incoming],
  );
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
 * FEED_COMMENT       : `comment:{pageId}:{postId}:{customerId}`
 */
export function buildFeedCommentThreadId(
  pageId: string,
  postId: string,
  customerId: string,
): string {
  return `comment:${pageId}:${postId}:${customerId}`;
}

/** Gộp thread id cũ (có rootCommentId) về định dạng chuẩn. */
export function normalizeCommentThreadId(threadId: string): string {
  if (!threadId.startsWith('comment:')) return threadId;
  const parts = threadId.split(':');
  if (parts.length < 4) return threadId;
  const customerId = parts.length >= 5 ? parts[3]! : parts.slice(3).join(':');
  return buildFeedCommentThreadId(parts[1]!, parts[2]!, customerId);
}

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

    return buildFeedCommentThreadId(
      enriched.pageId,
      enriched.postId,
      customerId,
    );
  }

  return null;
}

export function resolveThreadIdFromEvent(event: WebhookMessage): string | null {
  return buildThreadIdFromEvent(event);
}

export function dedupeCommentThreads(
  threads: ConversationThread[],
): ConversationThread[] {
  const map = new Map<string, ConversationThread>();

  for (const thread of threads) {
    const id = normalizeCommentThreadId(thread.id);
    const existing = map.get(id);
    if (!existing) {
      map.set(id, { ...thread, id });
      continue;
    }

    const existingTs = new Date(existing.lastMessageAt).getTime();
    const threadTs = new Date(thread.lastMessageAt).getTime();
    map.set(id, {
      ...existing,
      senderName: pickBetterSenderName(existing.senderName, thread.senderName),
      senderPictureUrl: existing.senderPictureUrl ?? thread.senderPictureUrl,
      preview: threadTs >= existingTs ? thread.preview : existing.preview,
      lastMessageAt:
        threadTs >= existingTs ? thread.lastMessageAt : existing.lastMessageAt,
      messageCount: existing.messageCount + thread.messageCount,
      unreadCount: (existing.unreadCount ?? 0) + (thread.unreadCount ?? 0),
      postId: thread.postId ?? existing.postId,
      commentId: threadTs >= existingTs ? thread.commentId : existing.commentId,
    });
  }

  return [...map.values()];
}

export function isSameConversationThread(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  if (!left || !right) return false;
  return normalizeCommentThreadId(left) === normalizeCommentThreadId(right);
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

/** Tìm hội thoại Messenger đã có của khách (theo PSID hoặc tên). */
export function findMessengerThreadForCustomer(
  conversations: ConversationThread[],
  input: { senderId?: string; senderName?: string },
): ConversationThread | undefined {
  const senderId = input.senderId?.trim();
  if (senderId) {
    const byId = conversations.find(
      (c) => c.kind === 'MESSENGER' && c.senderId === senderId,
    );
    if (byId) return byId;
  }

  const normalizedName = input.senderName?.trim().toLowerCase();
  if (!normalizedName) return undefined;

  return conversations.find(
    (c) =>
      c.kind === 'MESSENGER' &&
      c.senderName.trim().toLowerCase() === normalizedName,
  );
}

/** Id bình luận Facebook dùng để so khớp / scroll. */
export function getMessageCommentKey(
  msg: WebhookMessage,
): string | null {
  const id = msg.commentId ?? msg.messageId;
  return isValidFacebookCommentId(id) ? id! : null;
}

/** Lấy id bình luận cha từ DB hoặc rawPayload Graph/webhook. */
export function extractParentCommentId(msg: WebhookMessage): string | null {
  if (isValidFacebookCommentId(msg.parentCommentId)) {
    return msg.parentCommentId!.trim();
  }

  const raw = parseRawPayload(msg.rawPayload);
  if (!raw) return null;

  const parent = raw.parent as { id?: string } | undefined;
  const parentId =
    parent?.id ??
    (typeof raw.parent_id === 'string' ? raw.parent_id : null);
  return isValidFacebookCommentId(parentId) ? parentId : null;
}

function commentIdsMatch(a: string, b: string): boolean {
  if (a === b) return true;
  const suffixA = a.split('_').at(-1);
  const suffixB = b.split('_').at(-1);
  return Boolean(suffixA && suffixB && suffixA === suffixB);
}

export function facebookCommentIdsMatch(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  const left = a?.trim();
  const right = b?.trim();
  if (!left || !right) return false;
  return commentIdsMatch(left, right);
}

export function findCommentMessageById(
  messages: WebhookMessage[],
  commentId: string,
): WebhookMessage | undefined {
  const direct = messages.find(
    (msg) => getMessageCommentKey(msg) === commentId,
  );
  if (direct) return direct;

  return messages.find((msg) => {
    const key = getMessageCommentKey(msg);
    return key ? commentIdsMatch(key, commentId) : false;
  });
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

function readReplyToMid(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const mid = (value as { mid?: unknown }).mid;
  return typeof mid === 'string' && mid.trim() ? mid.trim() : null;
}

/** mid tin nhắn gốc khi reply Messenger (IN từ webhook hoặc OUT từ app). */
export function extractMessengerReplyToMid(
  msg: WebhookMessage,
): string | null {
  const raw = parseRawPayload(msg.rawPayload);
  if (!raw) return null;

  const fromApp = raw.replyToMessageId;
  if (typeof fromApp === 'string' && fromApp.trim()) return fromApp.trim();

  const fromTopLevel = readReplyToMid(raw.reply_to);
  if (fromTopLevel) return fromTopLevel;

  const message = raw.message;
  if (message && typeof message === 'object') {
    const fromMessage = readReplyToMid(
      (message as { reply_to?: unknown }).reply_to,
    );
    if (fromMessage) return fromMessage;
  }

  if (typeof raw.quote === 'string' && raw.quote.trim()) {
    try {
      const quoted = JSON.parse(raw.quote) as { mid?: unknown };
      const fromQuote = readReplyToMid(quoted);
      if (fromQuote) return fromQuote;
    } catch {
      // quote không phải JSON hợp lệ
    }
  }

  return null;
}

export function findMessageByMid(
  messages: WebhookMessage[],
  mid: string,
): WebhookMessage | undefined {
  const needle = mid.trim();
  if (!needle) return undefined;

  return messages.find((msg) => msg.messageId?.trim() === needle);
}

/** Tin nhắn gốc khi hiển thị quote reply Messenger. */
export function resolveMessengerReplyTarget(
  messages: WebhookMessage[],
  msg: WebhookMessage,
): { mid: string | null; target?: WebhookMessage } {
  const mid = extractMessengerReplyToMid(msg);
  if (!mid) return { mid: null };

  const target = findMessageByMid(messages, mid);
  return target ? { mid, target } : { mid };
}

/** Gộp tin nhắn theo messageId/id, giữ optimistic chưa có trên server. */
export function mergeThreadMessages(
  prev: WebhookMessage[],
  incoming: WebhookMessage[],
): WebhookMessage[] {
  let merged = prev;
  for (const msg of incoming) {
    merged = upsertThreadMessage(merged, msg);
  }
  return merged;
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
    preview: formatConversationThreadPreview({
      content: event.content,
      msgType: event.msgType,
      eventType: event.eventType,
      direction: event.direction,
      senderName:
        event.direction === 'OUT'
          ? null
          : pickBetterSenderName(event.senderName, 'Khách hàng'),
    }),
    lastMessageAt: event.createdAt,
    postId: event.postId,
    commentId: event.commentId,
    messageCount: 1,
    unreadCount: event.direction === 'IN' ? 1 : 0,
  };
}
