import type { WebhookEvent } from '@prisma/client';
import { aggregateConversations } from './conversation-thread.util';

function makeEvent(
  overrides: Partial<WebhookEvent> & Pick<WebhookEvent, 'id' | 'direction' | 'createdAt'>,
): WebhookEvent {
  return {
    id: overrides.id,
    organizationId: 'org-1',
    pageId: 'page-1',
    eventType: 'MESSENGER',
    direction: overrides.direction,
    senderId: overrides.direction === 'OUT' ? 'page-1' : 'customer-1',
    senderName: overrides.direction === 'OUT' ? 'Page' : 'Customer One',
    recipientId: overrides.direction === 'OUT' ? 'customer-1' : 'page-1',
    messageId: overrides.id,
    postId: null,
    commentId: null,
    msgType: 'text',
    content: `Message ${overrides.id}`,
    rawPayload: '{}',
    createdAt: overrides.createdAt,
    ...overrides,
  };
}

describe('aggregateConversations', () => {
  it('counts unread inbound customer messages after the thread was read', () => {
    const threads = aggregateConversations(
      [
        makeEvent({
          id: 'old-inbound',
          direction: 'IN',
          createdAt: new Date('2026-06-26T01:00:00.000Z'),
        }),
        makeEvent({
          id: 'new-inbound-1',
          direction: 'IN',
          createdAt: new Date('2026-06-26T03:00:00.000Z'),
        }),
        makeEvent({
          id: 'outbound',
          direction: 'OUT',
          createdAt: new Date('2026-06-26T04:00:00.000Z'),
        }),
        makeEvent({
          id: 'new-inbound-2',
          direction: 'IN',
          createdAt: new Date('2026-06-26T05:00:00.000Z'),
        }),
      ],
      new Map([
        ['messenger:page-1:customer-1', new Date('2026-06-26T02:00:00.000Z')],
      ]),
    );

    expect(threads).toHaveLength(1);
    expect(threads[0]?.unreadCount).toBe(2);
  });
});
