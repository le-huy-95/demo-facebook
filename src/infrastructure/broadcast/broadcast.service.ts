import { Injectable, Inject, forwardRef } from '@nestjs/common';
import type { WebhookEvent } from '@prisma/client';
import { KafkaService } from '../kafka/kafka.service';
import { TopicKafka } from '../../types/topic-kafka.enum';
import { EventsGateway } from '../../facebook/gateways/events.gateway';
import { EventsService } from '../../facebook/services/events.service';
import type { MessageDeliveryStatus } from '../../types/message.types';

/**
 * Centralizes realtime publishes (Kafka → Socket trong production).
 * Demo: publish in-process + emit Socket.IO trực tiếp.
 */
@Injectable()
export class BroadcastService {
  constructor(
    private readonly kafka: KafkaService,
    @Inject(forwardRef(() => EventsGateway))
    private readonly eventsGateway: EventsGateway,
    private readonly eventsService: EventsService,
  ) {}

  /** Tin nhắn mới đã lưu DB — realtime cho tất cả client trên page/thread */
  broadcastMessageReceive(event: WebhookEvent): void {
    this.kafka.publish(TopicKafka.SOCKET_MESSAGE_RECEIVE, event);
    this.eventsService.emitNewMessage(event);
    this.eventsGateway.emitWebhookEvent(event);
  }

  /** Kết quả gửi tin (SENDING → DELIVERED/FAILED) — ack cho người gửi */
  broadcastSendResult(
    event: WebhookEvent,
    deliveryStatus: MessageDeliveryStatus,
  ): void {
    const payload = { ...event, deliveryStatus };
    this.kafka.publish(TopicKafka.SOCKET_MESSAGE_SEND_RESULT, payload);
    this.eventsService.emitNewMessage(event);
    this.eventsGateway.emitWebhookEvent(event);
  }
}
