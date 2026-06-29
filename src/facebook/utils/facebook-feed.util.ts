export interface FeedEventTransform {
  eventType: string;
  msgType: string;
  content: string;
  senderId: string;
  senderName: string;
  postId: string;
  commentId: string;
  messageId: string;
  parentCommentId: string | null;
}

export function transformFeedChange(
  value: Record<string, unknown>,
): FeedEventTransform | null {
  const item = String(value.item ?? '');
  const verb = String(value.verb ?? '');
  const rawMessage = value.message ?? value.post ?? '';
  const message =
    typeof rawMessage === 'string'
      ? rawMessage
      : typeof rawMessage === 'object' && rawMessage && 'message' in rawMessage
        ? String((rawMessage as { message?: unknown }).message ?? '')
        : '';
  const from = (value.from ?? {}) as { id?: string; name?: string };
  let postId = String(value.post_id ?? '');
  const commentId = String(value.comment_id ?? '');

  if (!postId && typeof value.post === 'string' && /^\d+_\d+$/.test(value.post)) {
    postId = value.post;
  }
  if (
    !postId &&
    typeof value.post === 'object' &&
    value.post &&
    'id' in value.post
  ) {
    const objectPostId = String((value.post as { id?: unknown }).id ?? '');
    if (/^\d+_\d+$/.test(objectPostId)) {
      postId = objectPostId;
    }
  }
  if (!postId && /^\d+_\d+(?:_\d+)*$/.test(commentId)) {
    const parts = commentId.split('_');
    if (parts.length >= 2) {
      postId = `${parts[0]}_${parts[1]}`;
    }
  }

  // Reply comments may omit post_id; parent_id is the post id for top-level comments.
  if (item === 'comment' && !postId && value.parent_id) {
    const parentId = String(value.parent_id);
    if (/^\d+_\d+$/.test(parentId)) {
      postId = parentId;
    }
  }

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

  // For reply comments, parent_id is the comment being replied to (not the post)
  let parentCommentId: string | null = null;
  if (item === 'comment' && value.parent_id) {
    const pid = String(value.parent_id);
    // If parent_id looks like a comment ID (not a post ID with underscore pattern)
    if (pid && pid !== postId) {
      parentCommentId = pid;
    }
  }

  return {
    eventType,
    msgType,
    content: preview,
    senderId: from.id ?? '',
    senderName: from.name ?? 'Facebook User',
    postId,
    commentId,
    messageId: commentId || postId || `${item}-${Date.now()}`,
    parentCommentId,
  };
}
