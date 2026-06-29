import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import type { WebhookEvent } from '@prisma/client';
import { buildThreadId } from '../utils/conversation-thread.util';
import { FacebookMessagingService } from '../services/facebook-messaging.service';
import { EventsService } from '../services/events.service';

@WebSocketGateway({
  cors: {
    origin: true,
    credentials: true,
  },
  path: '/socket.io',
  transports: ['websocket', 'polling'],
})
export class EventsGateway {
  constructor(
    private readonly facebookMessaging: FacebookMessagingService,
    private readonly eventsService: EventsService,
  ) {}

  @WebSocketServer()
  server!: Server;

  @SubscribeMessage('joinThread')
  handleJoinThread(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { threadId: string },
  ): void {
    if (data?.threadId) {
      void client.join(`thread:${data.threadId}`);
    }
  }

  @SubscribeMessage('leaveThread')
  handleLeaveThread(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { threadId: string },
  ): void {
    if (data?.threadId) {
      void client.leave(`thread:${data.threadId}`);
    }
  }

  @SubscribeMessage('joinPage')
  handleJoinPage(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { pageId: string },
  ): void {
    if (data?.pageId) {
      void client.join(`page:${data.pageId}`);
    }
  }

  @SubscribeMessage('leavePage')
  handleLeavePage(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { pageId: string },
  ): void {
    if (data?.pageId) {
      void client.leave(`page:${data.pageId}`);
    }
  }

  @SubscribeMessage('message:send')
  async handleSendMessage(
    @ConnectedSocket() client: Socket,
    @MessageBody()
    data: {
      pageId: string;
      threadId: string;
      text?: string;
      clientMessageId?: string;
      replyToMessageId?: string;
      attachment?: {
        type: 'image' | 'video' | 'audio' | 'file';
        url: string;
      };
      commentId?: string;
    },
  ) {
    try {
      const result = await this.facebookMessaging.sendToThread({
        pageId: data?.pageId,
        threadId: data?.threadId,
        text: data?.text,
        attachment: data?.attachment,
        commentId: data?.commentId,
        replyToMessageId: data?.replyToMessageId,
        clientMessageId: data?.clientMessageId,
      });

      // Ack back to the sender.
      client.emit('message:ack', {
        ok: true,
        clientMessageId: data?.clientMessageId ?? null,
        fbMessageId: result.fb.messageId ?? null,
        savedEventId: result.savedEvent.id,
      });

      // Broadcast the same payload shape as inbound webhook events.
      this.emitWebhookEvent(result.savedEvent);
      this.eventsService.emitNewMessage(result.savedEvent);
    } catch (err: any) {
      const message = err instanceof Error ? err.message : 'Send failed';
      client.emit('message:ack', {
        ok: false,
        clientMessageId: data?.clientMessageId ?? null,
        error: message,
      });
    }
  }

  emitWebhookEvent(event: WebhookEvent): void {
    if (!this.server) return;

    if (!event.pageId) return;

    const payload = {
      ...event,
      createdAt:
        event.createdAt instanceof Date
          ? event.createdAt.toISOString()
          : event.createdAt,
    };

    this.server.to(`page:${event.pageId}`).emit('webhook:event', payload);

    const threadId = buildThreadId(event);
    if (threadId) {
      this.server.to(`thread:${threadId}`).emit('webhook:event', payload);
    }
  }

  emitContentRemoved(payload: {
    pageId: string;
    threadId?: string;
    messageId?: string;
    commentId?: string;
    postId?: string;
    status: 'HIDDEN' | 'DELETED' | 'ACTIVE';
  }): void {
    if (!this.server || !payload.pageId) return;

    this.server.to(`page:${payload.pageId}`).emit('content:removed', payload);

    if (payload.threadId) {
      this.server
        .to(`thread:${payload.threadId}`)
        .emit('content:removed', payload);
    }
  }

  /** Báo client reload danh sách / tin nhắn sau khi đồng bộ comment từ Graph. */
  emitFeedSynced(
    pageId: string,
    payload: { ingested: number; threadIds: string[] },
  ): void {
    if (!pageId) return;

    const body = {
      pageId,
      ingested: payload.ingested,
      threadIds: payload.threadIds,
    };

    this.eventsService.emitFeedSynced(body);

    if (!this.server) return;

    this.server.to(`page:${pageId}`).emit('feed:synced', body);

    for (const threadId of payload.threadIds) {
      this.server.to(`thread:${threadId}`).emit('feed:synced', {
        ...body,
        threadId,
      });
    }
  }
}
