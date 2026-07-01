function readString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function readUrlFromRecord(record: Record<string, unknown>): string | null {
  const direct = readString(record.url) ?? readString(record.file_url);
  if (direct) return direct;

  const payload = record.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return null;
  }

  const payloadRecord = payload as Record<string, unknown>;
  const payloadUrl =
    readString(payloadRecord.url) ??
    readString(payloadRecord.file_url) ??
    readString(payloadRecord.attachment_url);
  if (payloadUrl) return payloadUrl;

  const elements = payloadRecord.elements;
  if (Array.isArray(elements)) {
    for (const element of elements) {
      if (!element || typeof element !== 'object') continue;
      const el = element as Record<string, unknown>;
      const defaultAction = el.default_action;
      if (defaultAction && typeof defaultAction === 'object') {
        const url = readString((defaultAction as Record<string, unknown>).url);
        if (url) return url;
      }
      const buttons = el.buttons;
      if (Array.isArray(buttons)) {
        for (const button of buttons) {
          if (!button || typeof button !== 'object') continue;
          const url = readString((button as Record<string, unknown>).url);
          if (url) return url;
        }
      }
    }
  }

  return null;
}

export function extractAttachmentUrlFromMessengerAttachment(
  attachment: unknown,
): string | null {
  if (!attachment || typeof attachment !== 'object' || Array.isArray(attachment)) {
    return null;
  }
  return readUrlFromRecord(attachment as Record<string, unknown>);
}

export function extractAttachmentUrlFromMessengerPayload(
  payload: unknown,
): string | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return null;
  }

  const root = payload as Record<string, unknown>;

  const outboundAttachment = root.attachment;
  if (outboundAttachment && typeof outboundAttachment === 'object') {
    const url = readString((outboundAttachment as Record<string, unknown>).url);
    if (url) return url;
  }

  const message = root.message;
  if (message && typeof message === 'object' && !Array.isArray(message)) {
    const attachments = (message as Record<string, unknown>).attachments;
    if (Array.isArray(attachments)) {
      for (const item of attachments) {
        const url = extractAttachmentUrlFromMessengerAttachment(item);
        if (url) return url;
      }
    }
  }

  const graphAttachments = root.attachments;
  if (
    graphAttachments &&
    typeof graphAttachments === 'object' &&
    !Array.isArray(graphAttachments)
  ) {
    const data = (graphAttachments as Record<string, unknown>).data;
    if (Array.isArray(data)) {
      for (const item of data) {
        const url = extractAttachmentUrlFromMessengerAttachment(item);
        if (url) return url;
      }
    }
  }

  if (Array.isArray(graphAttachments)) {
    for (const item of graphAttachments) {
      const url = extractAttachmentUrlFromMessengerAttachment(item);
      if (url) return url;
    }
  }

  return null;
}

export function extractAttachmentUrlFromRawPayload(
  rawPayload: string | null | undefined,
): string | null {
  if (!rawPayload?.trim()) return null;
  try {
    return extractAttachmentUrlFromMessengerPayload(JSON.parse(rawPayload));
  } catch {
    return null;
  }
}
