import { io, type Socket } from 'socket.io-client';

export const SOCKET_URL =
  process.env.NEXT_PUBLIC_SOCKET_URL ??
  process.env.NEXT_PUBLIC_API_URL ??
  'http://localhost:3000';

let socket: Socket | null = null;

export function getSocket(): Socket {
  if (!socket) {
    socket = io(SOCKET_URL, {
      transports: ['websocket', 'polling'],
      autoConnect: true,
    });
  }
  return socket;
}

export function joinPageRoom(pageId: string): void {
  const s = getSocket();
  if (!s.connected) {
    s.connect();
  }
  s.emit('joinPage', { pageId });
}

export function leavePageRoom(pageId: string): void {
  getSocket().emit('leavePage', { pageId });
}

export function joinThreadRoom(threadId: string): void {
  const s = getSocket();
  if (!s.connected) {
    s.connect();
  }
  s.emit('joinThread', { threadId });
}

export function leaveThreadRoom(threadId: string): void {
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
