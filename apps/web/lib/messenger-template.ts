export interface MessengerTemplateButton {
  title: string;
  type?: string;
  url?: string;
  payload?: string;
}

export interface MessengerTemplateElement {
  title?: string;
  subtitle?: string;
  imageUrl?: string;
  buttons?: MessengerTemplateButton[];
}

export interface MessengerTemplateContent {
  templateType: string;
  text?: string;
  elements: MessengerTemplateElement[];
}

function readString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function parseButton(raw: unknown): MessengerTemplateButton | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const title = readString(record.title);
  if (!title) return null;
  return {
    title,
    type: readString(record.type) ?? undefined,
    url: readString(record.url) ?? undefined,
    payload: readString(record.payload) ?? undefined,
  };
}

function parseButtons(raw: unknown): MessengerTemplateButton[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => parseButton(item))
    .filter((item): item is MessengerTemplateButton => item !== null);
}

function parseElement(raw: unknown): MessengerTemplateElement | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const title = readString(record.title) ?? undefined;
  const subtitle =
    readString(record.subtitle) ?? readString(record.sub_title) ?? undefined;
  const imageUrl =
    readString(record.image_url) ?? readString(record.imageUrl) ?? undefined;
  const buttons = parseButtons(record.buttons);

  if (!title && !subtitle && !imageUrl && buttons.length === 0) {
    return null;
  }

  return { title, subtitle, imageUrl, buttons };
}

function parseMessengerTemplatePayload(payload: unknown): MessengerTemplateContent | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return null;
  }

  const record = payload as Record<string, unknown>;
  const templateType = readString(record.template_type) ?? 'generic';

  if (templateType === 'button') {
    const text = readString(record.text) ?? undefined;
    const buttons = parseButtons(record.buttons);
    if (!text && buttons.length === 0) return null;
    return {
      templateType,
      text,
      elements: [{ title: text, buttons }],
    };
  }

  const elements = Array.isArray(record.elements)
    ? record.elements
        .map((item) => parseElement(item))
        .filter((item): item is MessengerTemplateElement => item !== null)
    : [];

  if (elements.length === 0) return null;

  return { templateType, elements };
}

function extractMessengerTemplateFromAttachment(
  attachment: unknown,
): MessengerTemplateContent | null {
  if (!attachment || typeof attachment !== 'object' || Array.isArray(attachment)) {
    return null;
  }

  const record = attachment as Record<string, unknown>;
  if (readString(record.type) !== 'template') return null;
  return parseMessengerTemplatePayload(record.payload);
}

export function extractMessengerTemplateFromRawPayload(
  rawPayload: string | null | undefined,
): MessengerTemplateContent | null {
  if (!rawPayload?.trim()) return null;

  try {
    const root = JSON.parse(rawPayload) as Record<string, unknown>;
    const message = root.message;
    if (message && typeof message === 'object' && !Array.isArray(message)) {
      const attachments = (message as Record<string, unknown>).attachments;
      if (Array.isArray(attachments)) {
        for (const item of attachments) {
          const template = extractMessengerTemplateFromAttachment(item);
          if (template) return template;
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
          const template = extractMessengerTemplateFromAttachment(item);
          if (template) return template;
        }
      }
    }
  } catch {
    return null;
  }

  return null;
}

export function parseMessengerTemplateJson(
  content: string | null | undefined,
): MessengerTemplateContent | null {
  if (!content?.trim()) return null;
  try {
    const parsed = JSON.parse(content) as MessengerTemplateContent;
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.elements)) {
      return null;
    }
    if (parsed.elements.length === 0 && !parsed.text?.trim()) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function formatMessengerTemplatePreview(
  template: MessengerTemplateContent,
): string {
  const first = template.elements[0];
  return (
    first?.title?.trim() ||
    template.text?.trim() ||
    first?.subtitle?.trim() ||
    'Tin mẫu Messenger'
  );
}
