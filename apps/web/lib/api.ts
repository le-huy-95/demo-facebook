export const API_BASE =
  process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000';

export interface FacebookPage {
  id: string;
  pageId: string;
  name: string | null;
  category: string | null;
  pictureUrl: string | null;
  webhookSubscribed: boolean;
  isPinned?: boolean;
  platform?: 'facebook';
}

export type FacebookShop = FacebookPage;

export interface WebhookMessage {
  id: string;
  organizationId: string | null;
  pageId: string | null;
  eventType: string;
  direction: string | null;
  senderId: string | null;
  senderName: string | null;
  senderPictureUrl?: string | null;
  recipientId: string | null;
  messageId: string | null;
  postId: string | null;
  commentId: string | null;
  parentCommentId?: string | null;
  msgType: string | null;
  content: string | null;
  rawPayload: string;
  createdAt: string;
}

export async function getAuthStatus() {
  const res = await fetch(`${API_BASE}/messages/auth/status`, {
    cache: 'no-store',
  });
  if (!res.ok) throw new Error('Không kiểm tra được trạng thái đăng nhập');
  return res.json() as Promise<{
    data: { connected: boolean; pages: FacebookPage[] };
  }>;
}

export async function logout() {
  const res = await fetch(`${API_BASE}/messages/auth/logout`, {
    method: 'POST',
  });
  if (!res.ok) throw new Error('Không đăng xuất được');
  return res.json() as Promise<{
    data: { success: boolean; disconnectedPages: number };
  }>;
}

export async function getFacebookShops() {
  const res = await fetch(`${API_BASE}/facebook-page/pages`, {
    cache: 'no-store',
  });
  if (!res.ok) throw new Error('Không tải được danh sách shop');
  return res.json() as Promise<{ data: FacebookShop[] }>;
}

export async function toggleShopPin(pageId: string) {
  const res = await fetch(`${API_BASE}/facebook-page/pages/${pageId}/pin`, {
    method: 'POST',
  });
  if (!res.ok) throw new Error('Không ghim được trang');
  return res.json() as Promise<{ data: { id: string; isPinned: boolean } }>;
}

export async function unlinkShop(pageId: string) {
  const res = await fetch(`${API_BASE}/facebook-page/pages/${pageId}`, {
    method: 'DELETE',
  });
  if (!res.ok) throw new Error('Không hủy liên kết được trang');
  return res.json() as Promise<{
    data: { id: string; pageId: string; remainingPages: number };
  }>;
}

export async function initiateOAuth(friendlyName: string) {
  const res = await fetch(`${API_BASE}/facebook-page/oauth-url`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ friendlyName }),
  });
  if (!res.ok) throw new Error('Không tạo được OAuth URL');
  return res.json() as Promise<{ data: { url: string; credentialId: string } }>;
}

export type ConversationKind = 'MESSENGER' | 'FEED_COMMENT';

export interface ConversationThread {
  id: string;
  kind: ConversationKind;
  pageId: string;
  senderId: string;
  senderName: string;
  senderPictureUrl?: string | null;
  preview: string;
  lastMessageAt: string;
  postId: string | null;
  commentId: string | null;
  messageCount: number;
}

export interface FacebookPostPreview {
  id: string;
  message?: string;
  story?: string;
  permalinkUrl?: string;
  fullPicture?: string;
  createdTime?: string;
  fromName?: string;
}

export interface MessagesPaging {
  hasMore: boolean;
  nextBefore: string | null;
}

export async function getConversations(
  pageId: string,
  options?: { limit?: number; before?: string },
) {
  const qs = new URLSearchParams({ pageId });
  if (options?.limit) qs.set('limit', String(options.limit));
  if (options?.before) qs.set('before', options.before);

  const res = await fetch(`${API_BASE}/conversations?${qs}`, {
    cache: 'no-store',
  });
  if (!res.ok) throw new Error('Không tải được danh sách hội thoại');
  return res.json() as Promise<{
    data: ConversationThread[];
    paging: MessagesPaging;
  }>;
}

export async function getConversationMessages(
  pageId: string,
  threadId: string,
  options?: { limit?: number; before?: string },
) {
  const qs = new URLSearchParams({ pageId });
  if (options?.limit) qs.set('limit', String(options.limit));
  if (options?.before) qs.set('before', options.before);

  const res = await fetch(
    `${API_BASE}/conversations/${encodeURIComponent(threadId)}/messages?${qs}`,
    { cache: 'no-store' },
  );
  if (!res.ok) throw new Error('Không tải được tin nhắn');
  return res.json() as Promise<{
    data: WebhookMessage[];
    paging: MessagesPaging;
  }>;
}

export async function getPostPreview(pageId: string, postId: string) {
  const qs = new URLSearchParams({ pageId, postId });
  const res = await fetch(`${API_BASE}/conversations/post?${qs}`, {
    cache: 'no-store',
  });
  if (!res.ok) throw new Error('Không tải được bài viết');
  return res.json() as Promise<{ data: FacebookPostPreview | null }>;
}

export async function getMessages(type?: string) {
  const qs = new URLSearchParams({ limit: '100' });
  if (type) qs.set('type', type);
  const res = await fetch(`${API_BASE}/messages?${qs}`, { cache: 'no-store' });
  if (!res.ok) throw new Error('Không tải được tin nhắn');
  return res.json() as Promise<{ data: WebhookMessage[] }>;
}

export function subscribeMessages(onMessage: (msg: WebhookMessage) => void) {
  const source = new EventSource(`${API_BASE}/messages/stream`);

  source.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data) as WebhookMessage;
      onMessage(data);
    } catch {
      // ignore malformed
    }
  };

  return () => source.close();
}

export async function uploadFile(file: File) {
  const form = new FormData();
  form.set('file', file);

  const res = await fetch(`${API_BASE}/uploads`, {
    method: 'POST',
    body: form,
  });
  if (!res.ok) throw new Error('Không upload được file');
  return res.json() as Promise<{
    data: { url: string; filename: string; mimeType: string; size: number };
  }>;
}
