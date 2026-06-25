export interface FeedEventTransform {
  eventType: string;
  msgType: string;
  content: string;
  senderId: string;
  senderName: string;
  postId: string;
  commentId: string;
  messageId: string;
}

export function transformFeedChange(
  value: Record<string, unknown>,
): FeedEventTransform | null {
  const item = String(value.item ?? '');
  const verb = String(value.verb ?? '');
  const message = String(value.message ?? value.post ?? '');
  const from = (value.from ?? {}) as { id?: string; name?: string };
  const postId = String(value.post_id ?? value.parent_id ?? '');
  const commentId = String(value.comment_id ?? '');

  if (verb === 'remove') {
    return null;
  }

  let eventType = 'FEED';
  let msgType = item || 'feed';

  if (item === 'comment') {
    eventType = 'FEED_COMMENT';
    msgType = 'feed.comment';
  } else if (
    item === 'post' ||
    item === 'status' ||
    item === 'photo' ||
    item === 'video'
  ) {
    eventType = 'FEED_POST';
    msgType = `feed.${item}`;
  } else if (item === 'reaction') {
    eventType = 'FEED_REACTION';
    msgType = 'feed.reaction';
  }

  const preview =
    message ||
    (item === 'comment'
      ? '[Bình luận mới trên bài viết]'
      : `[Cập nhật feed: ${item}]`);

  return {
    eventType,
    msgType,
    content: preview,
    senderId: from.id ?? '',
    senderName: from.name ?? 'Facebook User',
    postId,
    commentId,
    messageId: commentId || postId || `${item}-${Date.now()}`,
  };
}
