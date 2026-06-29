export interface FeedEventTransform {
  eventType: string;
  msgType: string;
  content: string;
  senderId: string;
  senderName: string;
  postId: string;
  commentId: string;
  parentId: string;
  messageId: string;
  verb: string;
}

export function transformFeedChange(
  value: Record<string, unknown>,
): FeedEventTransform | null {
  const item = String(value.item ?? '');
  const verb = String(value.verb ?? '');
  const message = String(value.message ?? value.post ?? '');
  const from = (value.from ?? {}) as { id?: string; name?: string };
  const postId = extractFeedPostId(value);
  const commentId = String(value.comment_id ?? value.id ?? '');
  const parentId = String(value.parent_id ?? '');

  // remove/hide/unhide xử lý riêng ở FacebookWebhookService
  if (verb === 'remove' || verb === 'hide' || verb === 'unhide') {
    return null;
  }

  if (value.is_hidden === true) {
    return null;
  }

  if (item === 'comment' && verb !== 'add' && verb !== 'edited') {
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
    parentId,
    messageId: commentId || postId || `${item}-${Date.now()}`,
    verb,
  };
}

function extractFeedPostId(value: Record<string, unknown>): string {
  const raw = value.post_id;
  if (raw != null) {
    const postId = String(raw).trim();
    if (/^\d+_\d+$/.test(postId)) return postId;
  }

  // Một số payload comment chỉ có parent_id trỏ tới bài viết gốc
  const parentRaw = value.parent_id;
  if (parentRaw != null) {
    const parentId = String(parentRaw).trim();
    if (/^\d+_\d+$/.test(parentId)) return parentId;
  }

  return raw != null ? String(raw).trim() : '';
}

/** Lấy comment id từ payload webhook feed. */
export function extractFeedCommentKey(
  value: Record<string, unknown>,
): string | null {
  const raw = String(value.comment_id ?? value.id ?? '').trim();
  return /^\d+_\d+$/.test(raw) ? raw : null;
}

export function extractFeedPostKey(
  value: Record<string, unknown>,
): string | null {
  const postId = extractFeedPostId(value);
  return postId && /^\d+_\d+$/.test(postId) ? postId : null;
}
