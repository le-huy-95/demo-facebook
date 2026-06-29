/** Khóa thread Messenger khi không gắn bài/quảng cáo cụ thể. */
export const MESSENGER_DIRECT_THREAD_KEY = 'direct';

export function buildMessengerThreadId(
  pageId: string,
  customerId: string,
  postId?: string | null,
): string {
  const trimmed = postId?.trim();
  if (!trimmed) {
    return `messenger:${pageId}:${customerId}`;
  }
  return `messenger:${pageId}:${customerId}:${trimmed}`;
}

export function extractPostIdFromMessengerPayload(
  payload: unknown,
): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const event = payload as Record<string, unknown>;

  const referral =
    event.referral ??
    (event.message as Record<string, unknown> | undefined)?.referral ??
    (event.postback as Record<string, unknown> | undefined)?.referral;

  if (referral && typeof referral === 'object') {
    const ref = referral as Record<string, unknown>;
    const adsPostId = (ref.ads_context_data as Record<string, unknown> | undefined)
      ?.post_id;
    if (typeof adsPostId === 'string' && adsPostId.trim()) {
      const normalized = normalizePostId(adsPostId.trim());
      if (normalized) return normalized;
    }

    const rawRef = ref.ref ?? ref.ad_id ?? null;
    if (typeof rawRef === 'string' && rawRef.trim()) {
      const normalized = normalizePostId(rawRef.trim());
      if (normalized) return normalized;
    }
  }

  const attachments = (event.message as Record<string, unknown> | undefined)
    ?.attachments;
  if (Array.isArray(attachments) && attachments[0]) {
    const att = attachments[0] as Record<string, unknown>;
    const url =
      (att.payload as Record<string, unknown> | undefined)?.url ?? att.url;
    if (typeof url === 'string' && url) {
      try {
        const u = new URL(url);
        const storyFbid = u.searchParams.get('story_fbid');
        const id = u.searchParams.get('id');
        if (storyFbid && id) return `${id}_${storyFbid}`;
      } catch {
        // ignore
      }
    }
  }

  return null;
}

function normalizePostId(raw: string): string | null {
  if (/^\d+_\d+$/.test(raw)) return raw;
  const m = raw.match(/(\d+_\d+)/);
  return m?.[1] ?? (/^\d+$/.test(raw) ? raw : null);
}

export function parseMessengerThreadParts(parts: string[]): {
  pageId: string;
  senderId: string;
  postId?: string;
} | null {
  if (parts[0] !== 'messenger' || parts.length < 3) return null;

  const pageId = parts[1];
  if (parts.length === 3) {
    return { pageId, senderId: parts[2] };
  }

  if (parts.length >= 4) {
    const postKey = parts[3];
    return {
      pageId,
      senderId: parts[2],
      postId:
        postKey === MESSENGER_DIRECT_THREAD_KEY ? undefined : postKey,
    };
  }

  return null;
}
