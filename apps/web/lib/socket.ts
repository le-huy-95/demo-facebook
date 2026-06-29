import { io, type Socket } from 'socket.io-client';

/** Kết nối thẳng Nest — Next.js dev proxy thường làm hỏng WebSocket/Socket.IO. */
export const SOCKET_URL =
  process.env.NEXT_PUBLIC_SOCKET_URL ??
  process.env.NEXT_PUBLIC_API_URL ??
  (typeof window !== 'undefined'
    ? window.location.origin
    : 'http://localhost:3000');

let socket: Socket | null = null;
let joinedPageId: string | null = null;
let joinedThreadId: string | null = null;
let reconnectHandlerBound = false;

function bindSocketReconnect(): void {
  if (!socket || reconnectHandlerBound) return;
  reconnectHandlerBound = true;

  socket.on('connect', () => {
    if (joinedPageId) {
      socket?.emit('joinPage', { pageId: joinedPageId });
    }
    if (joinedThreadId) {
      socket?.emit('joinThread', { threadId: joinedThreadId });
    }
  });
}

export function getSocket(): Socket {
  if (!socket) {
    socket = io(SOCKET_URL, {
      path: '/socket.io/',
      // Chỉ polling — ổn định qua ngrok / proxy; websocket upgrade hay bị lỗi trong dev
      transports: ['polling'],
      upgrade: false,
      autoConnect: true,
      withCredentials: true,
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      // Ngrok free tier hiển thị trang cảnh báo nếu thiếu header
      extraHeaders: {
        'ngrok-skip-browser-warning': 'true',
      },
    });
    bindSocketReconnect();
  }
  return socket;
}

export function joinPageRoom(pageId: string): void {
  joinedPageId = pageId;
  const s = getSocket();

  const emitJoin = () => {
    if (joinedPageId) {
      s.emit('joinPage', { pageId: joinedPageId });
    }
  };

  if (s.connected) {
    emitJoin();
    return;
  }

  // Đảm bảo join room sau khi connect (tránh race autoConnect)
  s.once('connect', emitJoin);
  s.connect();
}

export function leavePageRoom(pageId: string): void {
  if (joinedPageId === pageId) joinedPageId = null;
  getSocket().emit('leavePage', { pageId });
}

export function joinThreadRoom(threadId: string): void {
  joinedThreadId = threadId;
  const s = getSocket();

  const emitJoin = () => {
    if (joinedThreadId) {
      s.emit('joinThread', { threadId: joinedThreadId });
    }
  };

  if (s.connected) {
    emitJoin();
    return;
  }

  s.once('connect', emitJoin);
  s.connect();
}

export function leaveThreadRoom(threadId: string): void {
  if (joinedThreadId === threadId) joinedThreadId = null;
  getSocket().emit('leaveThread', { threadId });
}

export interface SendMessagePayload {
  pageId: string;
  threadId: string;
  text?: string;
  clientMessageId?: string;
  commentId?: string;
  attachment?: {
    type: 'image' | 'video' | 'audio' | 'file';
    url: string;
  };
}

export interface MessageAckPayload {
  ok: boolean;
  clientMessageId: string | null;
  fbMessageId?: string | null;
  savedEventId?: string;
  error?: string;
}

export function sendMessage(
  payload: SendMessagePayload,
  onAck?: (ack: MessageAckPayload) => void,
): void {
  const s = getSocket();
  if (!s.connected) {
    s.connect();
  }

  if (onAck) {
    const handler = (ack: MessageAckPayload) => {
      if (
        ack.clientMessageId &&
        payload.clientMessageId &&
        ack.clientMessageId !== payload.clientMessageId
      ) {
        return;
      }
      s.off('message:ack', handler);
      onAck(ack);
    };
    s.on('message:ack', handler);
  }

  s.emit('message:send', payload);
}

export function onWebhookEvent(
  handler: (event: Record<string, unknown>) => void,
): () => void {
  const s = getSocket();
  s.on('webhook:event', handler);
  return () => {
    s.off('webhook:event', handler);
  };
}

export interface ContentRemovedPayload {
  pageId: string;
  threadId?: string;
  messageId?: string;
  commentId?: string;
  postId?: string;
  status: 'HIDDEN' | 'DELETED' | 'ACTIVE';
}

export function onContentRemoved(
  handler: (payload: ContentRemovedPayload) => void,
): () => void {
  const s = getSocket();
  s.on('content:removed', handler);
  return () => {
    s.off('content:removed', handler);
  };
}

export interface FeedSyncedPayload {
  pageId: string;
  ingested: number;
  threadIds: string[];
  threadId?: string;
}

export function onFeedSynced(
  handler: (payload: FeedSyncedPayload) => void,
): () => void {
  const s = getSocket();
  s.on('feed:synced', handler);
  return () => {
    s.off('feed:synced', handler);
  };
}
