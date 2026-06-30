/** Facebook comment id: `{postId}_{fbid}` hoặc `{pageId}_{postFbid}_{commentFbid}`. */
const FACEBOOK_COMMENT_ID_RE = /^\d+(?:_\d+)+$/;

/** Chuẩn hóa post id Graph (`pageId_postFbid` hoặc số thuần). */
export function normalizeFacebookPostId(
  raw: string | null | undefined,
): string | null {
  if (!raw?.trim()) return null;
  const value = raw.trim();
  if (/^\d+_\d+$/.test(value)) return value;
  const match = value.match(/(\d+_\d+)/);
  if (match?.[1]) return match[1];
  return /^\d+$/.test(value) ? value : null;
}

export function isValidFacebookCommentId(
  commentId: string | null | undefined,
): boolean {
  if (!commentId?.trim()) return false;
  return FACEBOOK_COMMENT_ID_RE.test(commentId.trim());
}

/** Phần fbid cuối của comment id (dùng đối chiếu khi id bị cắt/thiếu segment). */
export function facebookCommentIdSuffix(
  commentId: string | null | undefined,
): string | null {
  if (!commentId?.trim()) return null;
  const parts = commentId.trim().split('_');
  return parts.length >= 2 ? (parts.at(-1) ?? null) : null;
}

/** Khớp comment id đầy đủ hoặc cùng fbid suffix (Graph vs webhook đôi khi khác format). */
export function facebookCommentIdsMatch(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  const left = a?.trim();
  const right = b?.trim();
  if (!left || !right) return false;
  if (left === right) return true;
  const suffixA = facebookCommentIdSuffix(left);
  const suffixB = facebookCommentIdSuffix(right);
  return Boolean(suffixA && suffixB && suffixA === suffixB);
}

/** Các biến thể id để gọi Graph (webhook vs Graph API đôi khi khác format). */
export function buildFacebookCommentIdCandidates(
  commentId: string | null | undefined,
  postId?: string | null,
): string[] {
  const trimmed = commentId?.trim();
  if (!trimmed) return [];

  const candidates = new Set<string>([trimmed]);
  const suffix = facebookCommentIdSuffix(trimmed);
  if (suffix) candidates.add(suffix);

  const normalizedPostId = normalizeFacebookPostId(postId);
  if (normalizedPostId) {
    const idForPost = suffix ?? (/^\d+$/.test(trimmed) ? trimmed : null);
    if (idForPost) {
      candidates.add(`${normalizedPostId}_${idForPost}`);
    }
  }

  const parts = trimmed.split('_');
  if (parts.length >= 3) {
    candidates.add(`${parts.at(-2)}_${parts.at(-1)}`);
  }

  return [...candidates];
}

/** Chỉ id đủ segment — bỏ suffix số thuần (Graph API không chấp nhận). */
export function buildGraphCommentIdCandidates(
  commentId: string | null | undefined,
  postId?: string | null,
): string[] {
  return buildFacebookCommentIdCandidates(commentId, postId).filter(
    isValidFacebookCommentId,
  );
}
