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

function isGifUrl(url: string): boolean {
  return /\.gif(\?|#|$)/i.test(url);
}

function isAnimatedAttachment(att: FeedCommentAttachment): boolean {
  const type = att.type?.toLowerCase() ?? '';
  if (type.includes('animated') || type === 'gif') return true;

  const source = att.media?.source ?? '';
  const image = att.media?.image?.src ?? '';
  const url = att.url ?? '';

  if (isGifUrl(source) || isGifUrl(url) || isGifUrl(image)) return true;
  if (source && /\.(mp4|webm)(\?|$)/i.test(source)) return true;
  // FB đôi khi trả photo + media.source là bản animated (GIF dạng video)
  if (source && image && source !== image && type === 'photo') return true;

  return false;
}

function buildAttachmentPayload(
  trimmedText: string,
  payload: Record<string, unknown>,
): string {
  return JSON.stringify(
    trimmedText ? { text: trimmedText, ...payload } : payload,
  );
}

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
  const trimmedText = text.trim();
  const imageUrl = att.media?.image?.src ?? att.url;
  const videoUrl = att.media?.source;
  const directUrl = att.url ?? '';

  if (att.type === 'sticker') {
    const href = directUrl || imageUrl || '';
    return {
      msgType: isReply ? 'feed.comment.reply.sticker' : 'feed.comment.sticker',
      content: buildAttachmentPayload(trimmedText, {
        href,
        type: 'sticker',
        title: att.title ?? 'Sticker',
      }),
    };
  }

  if (isAnimatedAttachment(att)) {
    const href = videoUrl ?? directUrl ?? imageUrl ?? '';
    return {
      msgType: isReply ? 'feed.comment.reply.animated' : 'feed.comment.animated',
      content: buildAttachmentPayload(trimmedText, {
        href,
        thumb: imageUrl ?? href,
        type: 'animated',
        title: att.title ?? 'Ảnh động',
      }),
    };
  }

  if (videoUrl || att.type === 'video' || att.type?.includes('video')) {
    const href = videoUrl ?? directUrl ?? '';
    return {
      msgType: isReply ? 'feed.comment.reply.video' : 'feed.comment.video',
      content: buildAttachmentPayload(trimmedText, {
        href,
        type: 'video',
        title: att.title ?? 'Video',
      }),
    };
  }

  if (imageUrl || att.type === 'photo') {
    const href = imageUrl ?? directUrl ?? '';
    return {
      msgType: isReply ? 'feed.comment.reply.photo' : 'feed.comment.photo',
      content: buildAttachmentPayload(trimmedText, {
        href,
        type: 'image',
        title: att.title ?? 'Ảnh',
      }),
    };
  }

  return {
    msgType: isReply ? 'feed.comment.reply' : 'feed.comment',
    content: buildAttachmentPayload(trimmedText, {
      href: directUrl || undefined,
      type: att.type ?? 'file',
      title: att.title ?? 'Đính kèm',
    }),
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
