import {
  formatMessengerTemplatePreview,
  parseMessengerTemplateJson,
} from './messenger-template.util';

export interface FormatThreadPreviewInput {
  content?: string | null;
  msgType?: string | null;
  eventType?: string | null;
  direction?: string | null;
  senderName?: string | null;
}

function humanizeBracketLabel(value: string | undefined): string {
  const trimmed = value?.trim() ?? '';
  if (!trimmed) return '';
  const match = trimmed.match(/^\[(.+)\]$/);
  return match ? match[1] : trimmed;
}

function parseAttachmentPayload(
  content: string,
): { type?: string; href?: string; thumb?: string; title?: string; preview?: string } | null {
  if (!content.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(content) as {
      type?: string;
      href?: string;
      thumb?: string;
      title?: string;
      preview?: string;
      params?: string;
    };
    if (!parsed || typeof parsed !== 'object') return null;

    if (parsed.href || parsed.thumb) {
      return parsed;
    }

    const isFileObject =
      'params' in parsed ||
      /^\[.+\]$/.test(parsed.title ?? '') ||
      /^\[.+\]$/.test(parsed.preview ?? '');

    if (!isFileObject) return null;

    let mediaType = parsed.type;
    if (parsed.params) {
      try {
        const params = JSON.parse(parsed.params) as {
          fileExt?: string;
          fType?: number;
        };
        if (params.fType === 1) mediaType = 'image';
        else if (params.fType === 3) mediaType = 'video';
        else if (params.fType === 2) mediaType = 'file';
      } catch {
        // ignore
      }
    }

    return {
      type: mediaType ?? 'file',
      title:
        humanizeBracketLabel(parsed.title || parsed.preview) || 'Tệp đính kèm',
      preview: parsed.preview,
    };
  } catch {
    // not JSON attachment payload
  }
  return null;
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

export function formatConversationThreadPreview(
  input: FormatThreadPreviewInput,
): string {
  const content = input.content?.trim() ?? '';
  const isFeedComment =
    input.eventType === 'FEED_COMMENT' || input.msgType?.startsWith('feed.');

  if (input.msgType === 'chat.template' && content.startsWith('{')) {
    const template = parseMessengerTemplateJson(content);
    if (template) return formatMessengerTemplatePreview(template);
  }

  if (content.startsWith('{')) {
    const template = parseMessengerTemplateJson(content);
    if (template) return formatMessengerTemplatePreview(template);

    const attachment = parseAttachmentPayload(content);
    if (attachment) {
      if (attachment.href || attachment.thumb) {
        return formatMediaThreadPreview(
          attachment.type,
          input.direction,
          input.senderName,
        );
      }
      const who =
        input.direction === 'OUT'
          ? 'Bạn'
          : input.senderName?.trim() || 'Khách hàng';
      if (attachment.type === 'file' || attachment.type === 'template') {
        return `${who}: ${attachment.title ?? 'Tệp đính kèm'}`;
      }
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
