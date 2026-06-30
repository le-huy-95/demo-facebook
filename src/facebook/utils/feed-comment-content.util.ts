interface FeedCommentAttachment {
  type?: string;
  url?: string;
  title?: string;
  media?: {
    image?: { src?: string; width?: number; height?: number };
    source?: string;
  };
  target?: { url?: string };
}

const PLACEHOLDER_COMMENT_TEXT = '[Bình luận mới trên bài viết]';

export function feedCommentContentHasMedia(
  content: string | null | undefined,
): boolean {
  if (!content?.trim()) return false;
  if (!content.trim().startsWith('{')) return false;
  try {
    const parsed = JSON.parse(content) as { href?: string; thumb?: string };
    return Boolean(parsed.href || parsed.thumb);
  } catch {
    return false;
  }
}

function extractAttachmentFromPayload(
  payload: Record<string, unknown>,
): FeedCommentAttachment | null {
  const direct = payload.attachment;
  if (direct && typeof direct === 'object') {
    return direct as FeedCommentAttachment;
  }

  const photo = payload.photo;
  if (typeof photo === 'string' && photo.trim()) {
    const url = photo.trim();
    return { type: 'photo', url, media: { image: { src: url } } };
  }

  const link = payload.link;
  if (typeof link === 'string' && link.trim()) {
    const url = link.trim();
    if (/\.(png|jpe?g|gif|webp)(\?|$)/i.test(url) || url.includes('fbcdn.net')) {
      return { type: 'photo', url, media: { image: { src: url } } };
    }
  }

  return null;
}

function serializeGraphAttachment(
  att: FeedCommentAttachment,
  text: string,
  isReply: boolean,
): { content: string; msgType: string } {
  const imageUrl = att.media?.image?.src ?? att.url;
  const videoUrl = att.media?.source;
  const trimmedText = text.trim();

  if (imageUrl || att.type === 'photo' || att.type === 'sticker') {
    const href = imageUrl ?? att.url ?? '';
    const payload = trimmedText
      ? { text: trimmedText, href, type: 'image', title: att.title ?? 'Ảnh' }
      : { href, type: 'image', title: att.title ?? 'Ảnh' };
    return {
      msgType: isReply ? 'feed.comment.reply.photo' : 'feed.comment.photo',
      content: JSON.stringify(payload),
    };
  }

  if (videoUrl || att.type === 'video') {
    const href = videoUrl ?? att.url ?? '';
    const payload = trimmedText
      ? { text: trimmedText, href, type: 'video', title: att.title ?? 'Video' }
      : { href, type: 'video', title: att.title ?? 'Video' };
    return {
      msgType: isReply ? 'feed.comment.reply.video' : 'feed.comment.video',
      content: JSON.stringify(payload),
    };
  }

  const payload = trimmedText
    ? {
        text: trimmedText,
        href: att.url,
        type: att.type ?? 'file',
        title: att.title ?? 'Đính kèm',
      }
    : {
        href: att.url,
        type: att.type ?? 'file',
        title: att.title ?? 'Đính kèm',
      };
  return {
    msgType: isReply ? 'feed.comment.reply' : 'feed.comment',
    content: JSON.stringify(payload),
  };
}

export function serializeFeedCommentContent(
  input: {
    message?: string | null;
    attachment?: FeedCommentAttachment | null;
  },
  options?: { isReply?: boolean },
): { content: string; msgType: string } {
  const isReply = options?.isReply === true;
  const text = input.message?.trim() ?? '';

  if (input.attachment) {
    return serializeGraphAttachment(input.attachment, text, isReply);
  }

  return {
    msgType: isReply ? 'feed.comment.reply' : 'feed.comment',
    content: text || PLACEHOLDER_COMMENT_TEXT,
  };
}

export function serializeFeedCommentFromRawPayload(
  rawPayload: string | null | undefined,
  fallback?: {
    content?: string | null;
    msgType?: string | null;
    isReply?: boolean;
  },
): { content: string; msgType: string } | null {
  if (!rawPayload?.trim()) return null;

  try {
    const payload = JSON.parse(rawPayload) as Record<string, unknown>;
    const commentNode =
      payload.comment && typeof payload.comment === 'object'
        ? (payload.comment as Record<string, unknown>)
        : payload;

    const att =
      (commentNode.attachment as FeedCommentAttachment | undefined) ??
      (payload.attachment as FeedCommentAttachment | undefined) ??
      extractAttachmentFromPayload(payload);

    const textFromPayload =
      (typeof commentNode.message === 'string' ? commentNode.message : '') ||
      (typeof payload.message === 'string' ? payload.message : '') ||
      '';

    const existing = fallback?.content?.trim();
    const text =
      !existing || existing === PLACEHOLDER_COMMENT_TEXT
        ? textFromPayload.trim()
        : existing;

    const isReply =
      fallback?.isReply === true ||
      fallback?.msgType?.includes('reply') === true;

    if (att) {
      return serializeGraphAttachment(att, text, isReply);
    }

    if (text) {
      return {
        msgType: isReply ? 'feed.comment.reply' : 'feed.comment',
        content: text,
      };
    }
  } catch {
    return null;
  }

  return null;
}
