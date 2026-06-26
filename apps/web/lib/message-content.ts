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
  | { kind: 'receipt'; receiptType: 'read' | 'delivery' };

export function isReceiptMessage(msg: WebhookMessage): boolean {
  return msg.msgType === 'read' || msg.msgType === 'delivery';
}

function parseAttachmentJson(raw: string): ParsedAttachment | null {
  try {
    const parsed = JSON.parse(raw) as ParsedAttachment;
    if (parsed && typeof parsed === 'object' && (parsed.href || parsed.thumb)) {
      return parsed;
    }
  } catch {
    // not JSON attachment payload
  }
  return null;
}

export function parseMessageContent(msg: WebhookMessage): ParsedMessageContent {
  if (isReceiptMessage(msg)) {
    return {
      kind: 'receipt',
      receiptType: msg.msgType as 'read' | 'delivery',
    };
  }

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

  return { kind: 'text', text: msg.content ?? '' };
}
