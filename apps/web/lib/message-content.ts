import type { WebhookMessage } from './api';

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

function extractFeedCommentFromRaw(
  msg: WebhookMessage,
): { text: string; attachment?: ParsedAttachment } | null {
  if (!msg.rawPayload) return null;

  try {
    const payload = JSON.parse(msg.rawPayload) as {
      message?: string;
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

    const comment = payload.comment ?? payload;
    const att = comment.attachment ?? payload.attachment;
    const text =
      msg.content?.trim() ||
      comment.message?.trim() ||
      payload.message?.trim() ||
      '';

    if (att) {
      const imageUrl = att.media?.image?.src;
      const videoUrl = att.media?.source;
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
      if (att.type === 'sticker' && att.url) {
        return {
          text,
          attachment: {
            href: att.url,
            thumb: att.url,
            type: 'sticker',
            title: 'Sticker',
          },
        };
      }
      if (videoUrl || att.type === 'video') {
        return {
          text,
          attachment: {
            href: videoUrl ?? att.url,
            type: 'video',
            title: att.title ?? 'Video',
          },
        };
      }
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
  return (
    msg.eventType === 'FEED_COMMENT' &&
    (msg.direction === 'OUT' || msg.msgType?.includes('reply') === true)
  );
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
