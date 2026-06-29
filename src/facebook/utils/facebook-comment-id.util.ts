/** Facebook comment id thường có dạng `{postStoryId}_{commentFbid}`. */
const FACEBOOK_COMMENT_ID_RE = /^\d+_\d+$/;

export function isValidFacebookCommentId(
  commentId: string | null | undefined,
): boolean {
  if (!commentId?.trim()) return false;
  return FACEBOOK_COMMENT_ID_RE.test(commentId.trim());
}
