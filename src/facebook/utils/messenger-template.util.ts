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
