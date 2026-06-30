export interface InboundSocialMsgTransform {
  msgType: string;
  content: string;
  contentRaw: string;
  filename: string;
  quote: string;
  lastMessagePreview: string;
}

export interface MessagingReceiptTransform {
  msgType: 'read' | 'delivery';
  content: string;
  messageId: string | null;
  direction: 'IN' | 'OUT';
  senderId: string;
  recipientId: string;
}

interface AttachmentInput {
  type?: string;
  url?: string;
  payload?: { url?: string; sticker_id?: number };
}

function attachmentUrl(attachment: AttachmentInput): string {
  return (
    attachment.url ||
    attachment.payload?.url ||
    attachment.payload?.sticker_id?.toString() ||
    ''
  );
}

function buildFileObject(
  attachType: string,
  url: string,
  filename: string,
): Record<string, unknown> {
  const fileExt = filename ? (filename.split('.').pop() ?? '') : attachType;

  let fType: number;
  let preview: string;

  switch (attachType) {
    case 'image':
    case 'sticker':
      fType = 1;
      preview = attachType === 'sticker' ? '[Sticker]' : '[Hình ảnh]';
      break;
    case 'video':
    case 'audio':
      fType = 3;
      preview = attachType === 'video' ? '[Video]' : '[Audio]';
      break;
    default:
      fType = 2;
      preview = filename ? `[File] ${filename}` : '[Tệp đính kèm]';
      break;
  }

  return {
    title: filename || preview,
    description: '',
    href: url,
    thumb: attachType === 'image' || attachType === 'sticker' ? url : '',
    childnumber: 0,
    action: '',
    params: JSON.stringify({
      fileSize: '0',
      fileExt,
      checksum: '',
      fType,
    }),
    type: attachType,
    preview,
  };
}

function transformSingleAttachment(
  attachment: AttachmentInput,
  messageText: string,
): { msgType: string; content: string; preview: string; filename: string } {
  const attachType: string = attachment.type ?? 'attachment';
  const url = attachmentUrl(attachment);

  if (attachType === 'fallback' && url) {
    return {
      msgType: 'webchat',
      content: messageText || '',
      preview: messageText?.substring(0, 200) || '',
      filename: '',
    };
  }

  const filename =
    attachType === 'file' && url
      ? decodeURIComponent(url.split('/').pop()?.split('?')[0] ?? '')
      : '';

  let msgType: string;

  switch (attachType) {
    case 'image':
      msgType = 'chat.photo';
      break;
    case 'sticker':
      msgType = 'sticker';
      break;
    case 'video':
    case 'audio':
      msgType = 'chat.video.msg';
      break;
    default:
      msgType = 'share.file';
      break;
  }

  const fileObj = buildFileObject(attachType, url, filename);

  return {
    msgType,
    content: JSON.stringify(fileObj),
    preview: messageText || (fileObj.preview as string),
    filename,
  };
}

export function transformInboundMessage(event: any): InboundSocialMsgTransform {
  const message = event.message ?? {};
  const attachments: AttachmentInput[] = message.attachments ?? [];
  const quote = message.reply_to ? JSON.stringify(message.reply_to) : '';
  const contentRaw = JSON.stringify(event);
  const text = message.text ?? '';

  if (attachments.length === 0) {
    return {
      msgType: 'webchat',
      content: text,
      // Giữ full webhook event để FE đọc message.reply_to (phản hồi tin Page).
      contentRaw,
      filename: '',
      quote,
      lastMessagePreview: text.substring(0, 200),
    };
  }

  if (attachments.length === 1) {
    const single = transformSingleAttachment(attachments[0], text);
    return {
      msgType: single.msgType,
      content: single.content,
      contentRaw,
      filename: single.filename,
      quote,
      lastMessagePreview: single.preview.substring(0, 200),
    };
  }

  const fileObjs = attachments.map((att) => {
    const attachType = att.type ?? 'attachment';
    const url = attachmentUrl(att);
    const filename =
      attachType === 'file' && url
        ? decodeURIComponent(url.split('/').pop()?.split('?')[0] ?? '')
        : '';
    return buildFileObject(attachType, url, filename);
  });

  return {
    msgType: 'chat.attachments',
    content: JSON.stringify(fileObjs),
    contentRaw,
    filename: '',
    quote,
    lastMessagePreview: `[${attachments.length} tệp đính kèm]`,
  };
}

export function transformMessagingReceipt(
  pageId: string,
  event: any,
): MessagingReceiptTransform | null {
  if (event.read) {
    const senderId: string = event.sender?.id ?? '';
    const recipientId: string = event.recipient?.id ?? '';
    const watermark = event.read.watermark ?? event.timestamp ?? null;
    const customerId = senderId === pageId ? recipientId : senderId;

    return {
      msgType: 'read',
      content: JSON.stringify({
        watermark,
        customerId,
        timestamp: event.timestamp ?? null,
      }),
      messageId: watermark
        ? `read:${customerId}:${watermark}`
        : `read:${customerId}:${event.timestamp ?? Date.now()}`,
      direction: senderId === pageId ? 'OUT' : 'IN',
      senderId,
      recipientId,
    };
  }

  if (event.delivery) {
    const senderId: string = event.sender?.id ?? '';
    const recipientId: string = event.recipient?.id ?? '';
    const mids: string[] = event.delivery.mids ?? [];
    const watermark = event.delivery.watermark ?? null;
    const customerId = senderId === pageId ? recipientId : senderId;
    const primaryMid = mids[0] ?? null;

    return {
      msgType: 'delivery',
      content: JSON.stringify({
        mids,
        watermark,
        customerId,
        timestamp: event.timestamp ?? null,
      }),
      messageId:
        primaryMid ??
        (watermark
          ? `delivery:${customerId}:${watermark}`
          : `delivery:${customerId}:${event.timestamp ?? Date.now()}`),
      direction: senderId === pageId ? 'OUT' : 'IN',
      senderId,
      recipientId,
    };
  }

  return null;
}

export function isMessagingReceiptMsgType(msgType: string | null | undefined): boolean {
  return msgType === 'read' || msgType === 'delivery';
}
