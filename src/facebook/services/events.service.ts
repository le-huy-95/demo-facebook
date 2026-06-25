import { Injectable } from '@nestjs/common';
import { EventEmitter } from 'events';
import type { WebhookEvent } from '@prisma/client';

@Injectable()
export class EventsService {
  private readonly emitter = new EventEmitter();

  emitNewMessage(event: WebhookEvent): void {
    this.emitter.emit('message', event);
  }

  onMessage(handler: (event: WebhookEvent) => void): void {
    this.emitter.on('message', handler);
  }

  offMessage(handler: (event: WebhookEvent) => void): void {
    this.emitter.off('message', handler);
  }
}
