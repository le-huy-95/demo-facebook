import type { WebhookMessage } from './api';
import {
  buildFacebookCommentUrl,
  getMessageCommentKey,
  isGenericSenderName,
  pickBetterSenderName,
} from './conversation';

export interface MentionTarget {
  name: string;
  facebookUrl: string;
  /** comment_id URL ưu tiên hơn profile khi khớp @tên. */
  kind?: 'comment' | 'profile';
}

export type MentionSegment =
  | { type: 'text'; value: string }
  | { type: 'mention'; value: string; facebookUrl: string; kind?: 'comment' | 'profile' };

function normalizeMentionName(name: string): string {
  return name.trim().toLowerCase();
}

/** URL Facebook cho user/page theo id số. */
export function buildFacebookProfileUrl(
  facebookId: string | null | undefined,
): string | null {
  const id = facebookId?.trim();
  if (!id || !/^\d+$/.test(id)) return null;
  return `https://www.facebook.com/profile.php?id=${id}`;
}

/** URL fanpage theo page id. */
export function buildFacebookPageUrl(
  pageId: string | null | undefined,
): string | null {
  const id = pageId?.trim();
  if (!id || !/^\d+$/.test(id)) return null;
  return `https://www.facebook.com/${id}`;
}

type TargetPriority = 1 | 2;

interface CollectedTarget extends MentionTarget {
  priority: TargetPriority;
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

/** Tác giả thật từ rawPayload Graph/webhook (senderId DB có thể là PSID khách). */
function extractMessageAuthor(
  msg: WebhookMessage,
  pageId?: string,
): { authorId: string | null; authorName: string | null; isFromPage: boolean } {
  const raw = parseRawPayload(msg.rawPayload);
  const from = (raw?.from ?? {}) as { id?: string; name?: string };
  const authorId = (from.id ?? msg.senderId ?? '').trim() || null;
  const authorName = (from.name ?? msg.senderName ?? '').trim() || null;
  const isFromPage =
    !!pageId &&
    (authorId === pageId ||
      (msg.eventType === 'FEED_COMMENT' && msg.direction === 'OUT'));
  return { authorId, authorName, isFromPage };
}

/** Gom danh sách @tên có thể link tới Facebook trong thread. */
export function collectMentionTargets(input: {
  pageId?: string;
  pageName?: string;
  customerName?: string;
  customerSenderId?: string;
  postPermalinkUrl?: string | null;
  messages?: WebhookMessage[];
}): MentionTarget[] {
  const map = new Map<string, CollectedTarget>();

  const add = (
    name: string | null | undefined,
    url: string | null | undefined,
    kind: MentionTarget['kind'],
    priority: TargetPriority,
  ) => {
    const trimmed = name?.trim();
    if (!trimmed || !url || isGenericSenderName(trimmed)) return;

    const key = normalizeMentionName(trimmed);
    const existing = map.get(key);
    if (
      !existing ||
      priority > existing.priority ||
      (priority === existing.priority && trimmed.length > existing.name.length)
    ) {
      map.set(key, {
        name: trimmed,
        facebookUrl: url,
        kind,
        priority,
      });
    }
  };

  add(
    input.pageName,
    buildFacebookPageUrl(input.pageId) ?? buildFacebookProfileUrl(input.pageId),
    'profile',
    1,
  );
  add(input.customerName, buildFacebookProfileUrl(input.customerSenderId), 'profile', 1);

  for (const msg of input.messages ?? []) {
    const { authorId, authorName, isFromPage } = extractMessageAuthor(
      msg,
      input.pageId,
    );
    const name = pickBetterSenderName(authorName, msg.senderName);
    const commentKey = getMessageCommentKey(msg);

    if (
      msg.eventType === 'FEED_COMMENT' &&
      commentKey &&
      input.postPermalinkUrl
    ) {
      add(
        name,
        buildFacebookCommentUrl(commentKey, input.postPermalinkUrl),
        'comment',
        2,
      );
    }

    const profileUrl = isFromPage
      ? buildFacebookPageUrl(input.pageId)
      : buildFacebookProfileUrl(authorId ?? msg.senderId);
    add(name, profileUrl, 'profile', 1);
  }

  return [...map.values()]
    .sort((a, b) => b.name.length - a.name.length)
    .map(({ priority: _priority, ...target }) => target);
}

const MENTION_SPLIT_RE = /(@[^\s@]+(?:\s+[^\s@]+)*)/g;

function pickMentionTarget(
  rawName: string,
  targets: Array<MentionTarget & { key: string }>,
): (MentionTarget & { key: string }) | undefined {
  const normalizedRaw = normalizeMentionName(rawName);

  const exact = targets.filter((t) => normalizedRaw === t.key);
  if (exact.length > 0) {
    return exact.find((t) => t.kind === 'comment') ?? exact[0];
  }

  const prefixHits = targets.filter(
    (t) =>
      normalizedRaw.startsWith(`${t.key} `) || t.key.startsWith(normalizedRaw),
  );
  if (prefixHits.length === 0) return undefined;

  return (
    prefixHits.find((t) => t.kind === 'comment') ??
    prefixHits.sort((a, b) => b.name.length - a.name.length)[0]
  );
}

/** Tách chuỗi thành text + @mention (khớp tên đã biết, ưu tiên link comment_id). */
export function parseMentionSegments(
  text: string,
  targets: MentionTarget[],
): MentionSegment[] {
  if (!text) return [];
  if (!targets.length) return [{ type: 'text', value: text }];

  const normalizedTargets = targets.map((t) => ({
    ...t,
    key: normalizeMentionName(t.name),
  }));

  const parts = text.split(MENTION_SPLIT_RE);
  const segments: MentionSegment[] = [];

  for (const part of parts) {
    if (!part) continue;
    if (!part.startsWith('@')) {
      segments.push({ type: 'text', value: part });
      continue;
    }

    const rawName = part.slice(1).trim();
    if (!rawName) {
      segments.push({ type: 'text', value: part });
      continue;
    }

    const hit = pickMentionTarget(rawName, normalizedTargets);

    if (hit) {
      segments.push({
        type: 'mention',
        value: `@${hit.name}`,
        facebookUrl: hit.facebookUrl,
        kind: hit.kind,
      });
      const remainder = rawName.slice(hit.name.length).trimStart();
      if (remainder) {
        segments.push({ type: 'text', value: remainder });
      }
    } else {
      segments.push({ type: 'text', value: part });
    }
  }

  return segments;
}
