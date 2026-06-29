export type ContentVisibilityStatus = 'ACTIVE' | 'HIDDEN' | 'DELETED';

export function normalizeContentStatus(
  status: string | null | undefined,
): ContentVisibilityStatus {
  if (status === 'HIDDEN' || status === 'DELETED') return status;
  return 'ACTIVE';
}

export function isActiveContentStatus(status: string | null | undefined): boolean {
  return normalizeContentStatus(status) === 'ACTIVE';
}

/** Nhãn hiển thị dưới tin nhắn/bình luận không còn trạng thái hoạt động. */
export function formatContentStatusLabel(
  status: string | null | undefined,
  eventType?: string | null,
): string | null {
  const normalized = normalizeContentStatus(status);
  if (normalized === 'ACTIVE') return null;

  const isComment =
    eventType === 'FEED_COMMENT' || eventType?.startsWith('FEED');

  if (normalized === 'HIDDEN') {
    return isComment ? 'Bình luận đã bị ẩn' : 'Tin nhắn đã bị ẩn';
  }

  return isComment ? 'Bình luận đã bị xóa' : 'Tin nhắn đã bị xóa';
}
