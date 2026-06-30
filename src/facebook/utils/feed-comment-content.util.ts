interface FeedCommentAttachment {
  type?: string;
  url?: string;
  title?: string;
  media?: {
    image?: { src?: string; width?: number; height?: number };
    source?: string;
  };
  target?: { id?: string; url?: string };
}

const PLACEHOLDER_COMMENT_TEXT = '[Bình luận mới trên bài viết]';

const STICKER_ATTACHMENT_TYPES = new Set([
  'sticker',
  'animated_image',
  'animated_image_share',
  'gif',
]);

function isStickerAttachmentType(type?: string): boolean {
  if (!type) return false;
  const lower = type.toLowerCase();
  return (
    STICKER_ATTACHMENT_TYPES.has(lower) ||
    lower.includes('sticker') ||
    lower.includes('animated')
  );
}

function isDirectMediaUrl(url: string): boolean {
  return (
    /\.(png|jpe?g|gif|webp|mp4|webm)(\?|$)/i.test(url) ||
    url.includes('fbcdn.net') ||
    url.includes('fbsbx.com')
  );
}

function resolveAttachmentMediaUrl(att: FeedCommentAttachment): {
  imageUrl: string;
  videoUrl: string;
} {
  const imageUrl =
    att.media?.image?.src?.trim() ||
    (att.url && isDirectMediaUrl(att.url) ? att.url.trim() : '') ||
    (att.target?.url && isDirectMediaUrl(att.target.url)
      ? att.target.url.trim()
      : '');
  const videoUrl = att.media?.source?.trim() || '';
  return { imageUrl, videoUrl };
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

  const gif = payload.gif;
  if (typeof gif === 'string' && gif.trim()) {
    const url = gif.trim();
    return { type: 'animated_image', url, media: { image: { src: url } } };
  }

  const sticker = payload.sticker;
  if (typeof sticker === 'string' && sticker.trim()) {
    const url = sticker.trim();
    return { type: 'sticker', url, media: { image: { src: url } } };
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
  const { imageUrl, videoUrl } = resolveAttachmentMediaUrl(att);
  const trimmedText = text.trim();
  const isSticker =
    isStickerAttachmentType(att.type) ||
    /\.gif(\?|$)/i.test(imageUrl) ||
    (isStickerAttachmentType(att.type) && Boolean(imageUrl || att.url));
  const isVideo = Boolean(
    videoUrl && (att.type === 'video' || !imageUrl || videoUrl !== imageUrl),
  );

  if (isVideo) {
    const href = videoUrl || att.url || '';
    const payload = trimmedText
      ? { text: trimmedText, href, type: 'video', title: att.title ?? 'Video' }
      : { href, type: 'video', title: att.title ?? 'Video' };
    return {
      msgType: isReply ? 'feed.comment.reply.video' : 'feed.comment.video',
      content: JSON.stringify(payload),
    };
  }

  if (imageUrl || att.type === 'photo' || isSticker) {
    const href = imageUrl || att.url || '';
    const mediaType = isSticker ? 'sticker' : 'image';
    const suffix = isSticker ? 'sticker' : 'photo';
    const payload = trimmedText
      ? {
          text: trimmedText,
          href,
          thumb: href,
          type: mediaType,
          title: att.title ?? (isSticker ? 'Sticker' : 'Ảnh'),
        }
      : {
          href,
          thumb: href,
          type: mediaType,
          title: att.title ?? (isSticker ? 'Sticker' : 'Ảnh'),
        };
    return {
      msgType: isReply
        ? `feed.comment.reply.${suffix}`
        : `feed.comment.${suffix}`,
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
