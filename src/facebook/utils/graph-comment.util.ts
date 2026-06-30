/** Node tối thiểu để làm phẳng cây comment Graph API. */
export interface GraphCommentNode {
  id?: string;
  comments?: {
    data?: GraphCommentNode[];
  };
}

const GRAPH_COMMENT_ATTACHMENT_FIELDS =
  'attachment{type,url,title,media{image{src,width,height},source},target}';

const GRAPH_COMMENT_CORE_FIELDS = `id,message,from{id,name,picture},created_time,parent{id},is_hidden,${GRAPH_COMMENT_ATTACHMENT_FIELDS}`;

/** Gồm reply — Graph mặc định chỉ trả ~2 comment con nếu không set comments.limit. */
export const GRAPH_COMMENT_FIELDS_WITH_REPLIES = `${GRAPH_COMMENT_CORE_FIELDS},comments.limit(100){${GRAPH_COMMENT_CORE_FIELDS}}`;

/** Làm phẳng comment lồng nhau từ Graph API (post → reply → …). */
export function flattenGraphComments<T extends GraphCommentNode>(
  comments: T[],
): T[] {
  const flat: T[] = [];
  const stack = [...comments];

  while (stack.length > 0) {
    const current = stack.shift();
    if (!current?.id) continue;
    flat.push(current);

    const children = current.comments?.data ?? [];
    if (children.length > 0) {
      stack.push(...(children as T[]));
    }
  }

  return flat;
}
