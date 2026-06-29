import type { WebhookEvent } from '@prisma/client';

export type EventVisibilityStatus = 'ACTIVE' | 'HIDDEN' | 'DELETED';

export const EVENT_STATUS_ACTIVE: EventVisibilityStatus = 'ACTIVE';
export const EVENT_STATUS_HIDDEN: EventVisibilityStatus = 'HIDDEN';
export const EVENT_STATUS_DELETED: EventVisibilityStatus = 'DELETED';

/** Chỉ event ACTIVE mới tính unread / dùng làm target reply mặc định. */
export function isVisibleEvent(
  event: Pick<WebhookEvent, 'status'> | { status?: string | null },
): boolean {
  const status = event.status ?? EVENT_STATUS_ACTIVE;
  return status === EVENT_STATUS_ACTIVE;
}

export const VISIBLE_EVENT_STATUS_FILTER = {
  status: EVENT_STATUS_ACTIVE,
} as const;
