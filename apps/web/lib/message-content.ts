import type { WebhookMessage } from './api';
import { extractParentCommentId } from './conversation';

export interface ParsedAttachment {
  title?: string;
  href?: string;
  thumb?: string;
  type?: string;
  preview?: string;
}

export type ParsedMessageContent =
  | { kind: 'text'; text: string }
  | { kind: 'attachment'; attachment: ParsedAttachment }
  | { kind: 'attachments'; attachments: ParsedAttachment[] }
  | { kind: 'feed'; text: string; attachment?: ParsedAttachment }
  | { kind: 'receipt'; receiptType: 'read' | 'delivery' };

export function isReceiptMessage(msg: WebhookMessage): boolean {
  return msg.msgType === 'read' || msg.msgType === 'delivery';
}

function parseAttachmentJson(raw: string): ParsedAttachment | null {
  try {
    const parsed = JSON.parse(raw) as ParsedAttachment & { text?: string };
    if (parsed && typeof parsed === 'object' && (parsed.href || parsed.thumb)) {
      return parsed;
    }
  } catch {
    // not JSON attachment payload
  }
  return null;
}

const PLACEHOLDER_COMMENT_TEXT = '[Bình luận mới trên bài viết]';

function isPlaceholderCommentText(text: string | null | undefined): boolean {
  const trimmed = text?.trim();
  return !trimmed || trimmed === PLACEHOLDER_COMMENT_TEXT;
}

function extractAttachmentFromPayload(
  payload: Record<string, unknown>,
): {
  type?: string;
  url?: string;
  title?: string;
  media?: { image?: { src?: string }; source?: string };
} | null {
  const direct = payload.attachment;
  if (direct && typeof direct === 'object') {
    return direct as {
      type?: string;
      url?: string;
      title?: string;
      media?: { image?: { src?: string }; source?: string };
    };
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

function serializeAttachment(
  att: NonNullable<ReturnType<typeof extractAttachmentFromPayload>>,
  text: string,
): { text: string; attachment: ParsedAttachment } {
  const imageUrl = att.media?.image?.src ?? att.url;
  const videoUrl = att.media?.source;
  const directUrl = att.url ?? '';
  const type = att.type?.toLowerCase() ?? '';

  if (type === 'sticker' && (directUrl || imageUrl)) {
    const href = directUrl || imageUrl || '';
    return {
      text,
      attachment: {
        href,
        thumb: href,
        type: 'sticker',
        title: 'Sticker',
      },
    };
  }

  const isAnimated =
    type.includes('animated') ||
    type === 'gif' ||
    (videoUrl && /\.(mp4|webm|gif)(\?|$)/i.test(videoUrl)) ||
    (directUrl && /\.gif(\?|$)/i.test(directUrl)) ||
    (videoUrl && imageUrl && videoUrl !== imageUrl && type === 'photo');

  if (isAnimated) {
    const href = videoUrl ?? directUrl ?? imageUrl ?? '';
    return {
      text,
      attachment: {
        href,
        thumb: imageUrl ?? href,
        type: 'animated',
        title: att.title ?? 'Ảnh động',
      },
    };
  }

  if (imageUrl) {
    return {
      text,
      attachment: {
        href: imageUrl,
        thumb: imageUrl,
        type: 'image',
        title: att.title ?? 'Ảnh',
      },
    };
  }

  if (videoUrl || type === 'video' || type.includes('video')) {
    return {
      text,
      attachment: {
        href: videoUrl ?? directUrl,
        type: 'video',
        title: att.title ?? 'Video',
      },
    };
  }

  return { text, attachment: { href: directUrl, type: att.type, title: att.title } };
}

function extractFeedCommentFromRaw(
  msg: WebhookMessage,
): { text: string; attachment?: ParsedAttachment } | null {
  if (!msg.rawPayload) return null;

  try {
    const payload = JSON.parse(msg.rawPayload) as {
      source?: string;
      message?: string;
      photo?: string;
      link?: string;
      comment?: {
        message?: string;
        attachment?: {
          type?: string;
          url?: string;
          title?: string;
          media?: { image?: { src?: string }; source?: string };
        };
      };
      attachment?: {
        type?: string;
        url?: string;
        title?: string;
        media?: { image?: { src?: string }; source?: string };
      };
    };

    const commentNode =
      payload.comment && typeof payload.comment === 'object'
        ? payload.comment
        : payload;
    const att =
      commentNode.attachment ??
      payload.attachment ??
      extractAttachmentFromPayload(payload);
    const textFromPayload =
      commentNode.message?.trim() ||
      payload.message?.trim() ||
      '';
    const text = isPlaceholderCommentText(msg.content)
      ? textFromPayload
      : msg.content?.trim() || textFromPayload;

    if (att) {
      return serializeAttachment(att, text);
    }

    if (text) return { text };
  } catch {
    // payload không phải JSON
  }

  return null;
}

function extractFeedCommentText(msg: WebhookMessage): string | null {
  const fromRaw = extractFeedCommentFromRaw(msg);
  if (fromRaw?.text) return fromRaw.text;
  if (msg.content?.trim()) return msg.content.trim();
  return null;
}

function parseFeedCommentContent(msg: WebhookMessage): ParsedMessageContent | null {
  const isFeed =
    msg.eventType === 'FEED_COMMENT' || msg.msgType?.startsWith('feed.comment');
  if (!isFeed) return null;

  const feedTypes = new Set([
    'feed.comment.photo',
    'feed.comment.reply.photo',
    'feed.comment.sticker',
    'feed.comment.reply.sticker',
    'feed.comment.animated',
    'feed.comment.reply.animated',
    'feed.comment.video',
    'feed.comment.reply.video',
  ]);

  if (msg.content && msg.msgType && feedTypes.has(msg.msgType)) {
    const parsed = parseAttachmentJson(msg.content);
    if (parsed) {
      const text =
        (parsed as ParsedAttachment & { text?: string }).text?.trim() ?? '';
      return { kind: 'feed', text, attachment: parsed };
    }
  }

  const fromRaw = extractFeedCommentFromRaw(msg);
  if (fromRaw) {
    return {
      kind: 'feed',
      text: fromRaw.text,
      attachment: fromRaw.attachment,
    };
  }

  const text = extractFeedCommentText(msg);
  if (text) return { kind: 'feed', text };

  return null;
}

export function parseMessageContent(msg: WebhookMessage): ParsedMessageContent {
  if (isReceiptMessage(msg)) {
    return {
      kind: 'receipt',
      receiptType: msg.msgType as 'read' | 'delivery',
    };
  }

  const feedParsed = parseFeedCommentContent(msg);
  if (feedParsed) return feedParsed;

  if (msg.msgType === 'chat.attachments' && msg.content) {
    try {
      const attachments = JSON.parse(msg.content) as ParsedAttachment[];
      if (Array.isArray(attachments) && attachments.length > 0) {
        return { kind: 'attachments', attachments };
      }
    } catch {
      // fall through
    }
  }

  const attachmentTypes = new Set([
    'chat.photo',
    'sticker',
    'share.file',
    'chat.video.msg',
  ]);

  if (msg.content && msg.msgType && attachmentTypes.has(msg.msgType)) {
    const attachment = parseAttachmentJson(msg.content);
    if (attachment) {
      return { kind: 'attachment', attachment };
    }
  }

  return {
    kind: 'text',
    text: msg.content ?? '',
  };
}

export function isFeedCommentReply(msg: WebhookMessage): boolean {
  if (msg.eventType !== 'FEED_COMMENT') return false;
  if (msg.msgType?.includes('reply')) return true;
  if (msg.parentCommentId?.trim()) return true;
  return !!extractParentCommentId(msg);
}

export interface ThreadPreviewInput {
  content?: string | null;
  msgType?: string | null;
  eventType?: string | null;
  direction?: string | null;
  senderName?: string | null;
}

function formatMediaThreadPreview(
  mediaType: string | undefined,
  direction: string | null | undefined,
  senderName: string | null | undefined,
): string {
  const who =
    direction === 'OUT' ? 'Bạn' : senderName?.trim() || 'Khách hàng';
  if (mediaType?.includes('sticker')) return `${who} đã gửi 1 sticker`;
  if (mediaType?.includes('animated') || mediaType?.includes('gif')) {
    return `${who} đã gửi 1 ảnh động`;
  }
  if (mediaType?.includes('video')) return `${who} đã gửi 1 video`;
  return `${who} đã gửi 1 hình ảnh`;
}

function isFeedCommentMediaMsgType(msgType?: string | null): boolean {
  if (!msgType) return false;
  return (
    msgType.includes('photo') ||
    msgType.includes('video') ||
    msgType.includes('sticker') ||
    msgType.includes('animated')
  );
}

/** Rút gọn nội dung cuối để hiển thị trên sidebar hội thoại. */
export function formatConversationThreadPreview(
  input: ThreadPreviewInput,
): string {
  const content = input.content?.trim() ?? '';
  const isFeedComment =
    input.eventType === 'FEED_COMMENT' || input.msgType?.startsWith('feed.');

  if (content.startsWith('{')) {
    const attachment = parseAttachmentJson(content);
    if (attachment?.href || attachment?.thumb) {
      return formatMediaThreadPreview(
        attachment.type,
        input.direction,
        input.senderName,
      );
    }
    if (isFeedComment) return 'Bình luận';
  }

  if (isFeedCommentMediaMsgType(input.msgType)) {
    const mediaType = input.msgType!.includes('video')
      ? 'video'
      : input.msgType!.includes('sticker')
        ? 'sticker'
        : input.msgType!.includes('animated')
          ? 'animated'
          : 'image';
    return formatMediaThreadPreview(
      mediaType,
      input.direction,
      input.senderName,
    );
  }

  if (!content) {
    return isFeedComment ? 'Bình luận' : '';
  }

  return content.length > 120 ? `${content.slice(0, 120)}…` : content;
}

/** Rút gọn nội dung bình luận để hiển thị preview trả lời. */
export function getCommentPreviewText(msg: WebhookMessage): string {
  const parsed = parseMessageContent(msg);

  if (parsed.kind === 'feed') {
    if (parsed.text?.trim()) return parsed.text.trim();
    if (parsed.attachment) {
      const type = parsed.attachment.type ?? '';
      if (type.includes('sticker')) return 'Sticker';
      if (type.includes('video')) return 'Video';
      return 'Ảnh';
    }
  }

  if (parsed.kind === 'text' && parsed.text?.trim()) {
    return parsed.text.trim();
  }

  if (parsed.kind === 'attachment' || parsed.kind === 'attachments') {
    return 'Ảnh/Video';
  }

  const fallback = msg.content?.trim();
  if (fallback && !fallback.startsWith('{')) {
    return fallback.length > 120 ? `${fallback.slice(0, 120)}…` : fallback;
  }

  return 'Bình luận';
}
