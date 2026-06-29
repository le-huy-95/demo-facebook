import { io, type Socket } from 'socket.io-client';

function resolveSocketConfig(): { url: string; transports: ('websocket' | 'polling')[] } {
  const explicitUrl =
    process.env.NEXT_PUBLIC_SOCKET_URL ?? process.env.NEXT_PUBLIC_API_URL ?? null;

  if (typeof window !== 'undefined') {
    if (explicitUrl) {
      return { url: explicitUrl, transports: ['websocket', 'polling'] };
    }
    if (window.location.hostname === 'localhost') {
      return { url: 'http://localhost:3000', transports: ['websocket', 'polling'] };
    }
    return { url: window.location.origin, transports: ['websocket', 'polling'] };
  }

  return {
    url: explicitUrl ?? 'http://localhost:3000',
    transports: ['websocket', 'polling'],
  };
}

let socket: Socket | null = null;
const joinedPageRooms = new Set<string>();
const joinedThreadRooms = new Set<string>();

function replayJoinedRooms(s: Socket): void {
  for (const pageId of joinedPageRooms) {
    s.emit('joinPage', { pageId });
  }
  for (const threadId of joinedThreadRooms) {
    s.emit('joinThread', { threadId });
  }
}

export function getSocket(): Socket {
  if (!socket) {
    const config = resolveSocketConfig();
    socket = io(config.url, {
      transports: config.transports,
      autoConnect: true,
      extraHeaders: {
        'ngrok-skip-browser-warning': 'true',
      },
    });
    socket.on('connect', () => {
      replayJoinedRooms(socket!);
    });
  }
  return socket;
}

export function joinPageRoom(pageId: string): void {
  joinedPageRooms.add(pageId);
  const s = getSocket();
  if (!s.connected) {
    s.connect();
  }
  s.emit('joinPage', { pageId });
}

export function leavePageRoom(pageId: string): void {
  joinedPageRooms.delete(pageId);
  getSocket().emit('leavePage', { pageId });
}

export function joinThreadRoom(threadId: string): void {
  joinedThreadRooms.add(threadId);
  const s = getSocket();
  if (!s.connected) {
    s.connect();
  }
  s.emit('joinThread', { threadId });
}

export function leaveThreadRoom(threadId: string): void {
  joinedThreadRooms.delete(threadId);
  getSocket().emit('leaveThread', { threadId });
}

export interface SendMessagePayload {
  pageId: string;
  threadId: string;
  text?: string;
  clientMessageId?: string;
  commentId?: string;
  replyToMessageId?: string;
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
