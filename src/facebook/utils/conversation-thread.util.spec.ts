import type { WebhookEvent } from '@prisma/client';
import {
  aggregateConversations,
  buildFeedCommentThreadId,
  resolveRootCommentId,
} from './conversation-thread.util';

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
    status: 'ACTIVE',
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

  it('still lists thread when latest event is deleted but keeps unread for active only', () => {
    const threads = aggregateConversations([
      makeEvent({
        id: 'visible',
        direction: 'IN',
        createdAt: new Date('2026-06-26T05:00:00.000Z'),
      }),
      makeEvent({
        id: 'deleted',
        direction: 'IN',
        status: 'DELETED',
        createdAt: new Date('2026-06-26T06:00:00.000Z'),
      }),
    ]);

    expect(threads).toHaveLength(1);
    expect(threads[0]?.preview).toBe('Message deleted');
    expect(threads[0]?.messageCount).toBe(2);
    expect(threads[0]?.unreadCount).toBe(1);
  });

  it('groups root comment and its replies into one thread per root', () => {
    const rootComment = '111_222';
    const replyComment = '111_333';
    const threads = aggregateConversations([
      makeEvent({
        id: 'root-comment',
        eventType: 'FEED_COMMENT',
        direction: 'IN',
        senderId: 'customer-9',
        postId: 'page-1_999',
        commentId: rootComment,
        parentCommentId: null,
        msgType: 'feed.comment',
        createdAt: new Date('2026-06-26T01:00:00.000Z'),
      }),
      makeEvent({
        id: 'reply-comment',
        eventType: 'FEED_COMMENT',
        direction: 'IN',
        senderId: 'customer-9',
        postId: 'page-1_999',
        commentId: replyComment,
        parentCommentId: rootComment,
        msgType: 'feed.comment',
        createdAt: new Date('2026-06-26T02:00:00.000Z'),
      }),
    ]);

    expect(threads).toHaveLength(1);
    expect(threads[0]?.id).toBe(
      buildFeedCommentThreadId('page-1', 'page-1_999', 'customer-9', rootComment),
    );
    expect(threads[0]?.messageCount).toBe(2);
  });

  it('creates separate threads for multiple root comments from the same customer', () => {
    const rootA = '111_100';
    const rootB = '111_200';
    const threads = aggregateConversations([
      makeEvent({
        id: 'root-a',
        eventType: 'FEED_COMMENT',
        direction: 'IN',
        senderId: 'customer-9',
        postId: 'page-1_999',
        commentId: rootA,
        parentCommentId: null,
        msgType: 'feed.comment',
        createdAt: new Date('2026-06-26T01:00:00.000Z'),
      }),
      makeEvent({
        id: 'root-b',
        eventType: 'FEED_COMMENT',
        direction: 'IN',
        senderId: 'customer-9',
        postId: 'page-1_999',
        commentId: rootB,
        parentCommentId: null,
        msgType: 'feed.comment',
        createdAt: new Date('2026-06-26T02:00:00.000Z'),
      }),
    ]);

    expect(threads).toHaveLength(2);
    expect(threads.map((t) => t.id).sort()).toEqual(
      [
        buildFeedCommentThreadId('page-1', 'page-1_999', 'customer-9', rootA),
        buildFeedCommentThreadId('page-1', 'page-1_999', 'customer-9', rootB),
      ].sort(),
    );
  });

  it('resolveRootCommentId returns commentId for top-level comments', () => {
    expect(
      resolveRootCommentId({
        commentId: '111_1',
        parentCommentId: null,
        postId: 'page-1_999',
      }),
    ).toBe('111_1');
    expect(
      resolveRootCommentId({
        commentId: '111_2',
        parentCommentId: '111_1',
        postId: 'page-1_999',
      }),
    ).toBe('111_1');
  });
});
