export interface FormatThreadPreviewInput {
  content?: string | null;
  msgType?: string | null;
  eventType?: string | null;
  direction?: string | null;
  senderName?: string | null;
}

function parseAttachmentPayload(
  content: string,
): { type?: string; href?: string; thumb?: string } | null {
  if (!content.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(content) as {
      type?: string;
      href?: string;
      thumb?: string;
    };
    if (parsed && typeof parsed === 'object' && (parsed.href || parsed.thumb)) {
      return parsed;
    }
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

  if (content.startsWith('{')) {
    const attachment = parseAttachmentPayload(content);
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
