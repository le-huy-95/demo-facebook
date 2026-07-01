import { transformFeedChange } from './facebook-feed.util';

describe('transformFeedChange', () => {
  it('does not store reaction target id as commentId', () => {
    const result = transformFeedChange({
      from: { id: '110338337196945', name: 'Customer' },
      post_id: '110338337196945_132056345025144',
      comment_id: '132056345025144_1301021095448686',
      parent_id: '110338337196945_132056345025144',
      item: 'reaction',
      reaction_type: 'like',
      verb: 'add',
    });

    expect(result).toMatchObject({
      eventType: 'FEED_REACTION',
      msgType: 'feed.reaction',
      commentId: '',
      messageId: '110338337196945_132056345025144',
    });
  });

  it('keeps comment id for feed comment events', () => {
    const result = transformFeedChange({
      from: { id: '110338337196945', name: 'Customer' },
      post_id: '110338337196945_132056345025144',
      comment_id: '110338337196945_132056345025144_999',
      item: 'comment',
      verb: 'add',
      message: 'hello',
    });

    expect(result).toMatchObject({
      eventType: 'FEED_COMMENT',
      commentId: '110338337196945_132056345025144_999',
      messageId: '110338337196945_132056345025144_999',
    });
  });
});
