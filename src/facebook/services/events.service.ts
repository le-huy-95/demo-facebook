import { Injectable } from '@nestjs/common';
import { EventEmitter } from 'events';
import type { WebhookEvent } from '@prisma/client';

export interface FeedSyncedEvent {
  pageId: string;
  ingested: number;
  threadIds: string[];
}

@Injectable()
export class EventsService {
  private readonly emitter = new EventEmitter();
  private readonly feedSyncedEmitter = new EventEmitter();

  emitNewMessage(event: WebhookEvent): void {
    this.emitter.emit('message', event);
  }

  onMessage(handler: (event: WebhookEvent) => void): void {
    this.emitter.on('message', handler);
  }

  offMessage(handler: (event: WebhookEvent) => void): void {
    this.emitter.off('message', handler);
  }

  emitFeedSynced(payload: FeedSyncedEvent): void {
    this.feedSyncedEmitter.emit('feed:synced', payload);
  }

  onFeedSynced(handler: (payload: FeedSyncedEvent) => void): void {
    this.feedSyncedEmitter.on('feed:synced', handler);
  }

  offFeedSynced(handler: (payload: FeedSyncedEvent) => void): void {
    this.feedSyncedEmitter.off('feed:synced', handler);
  }
}
