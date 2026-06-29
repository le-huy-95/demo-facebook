import { Injectable } from '@nestjs/common';
import { EventEmitter } from 'events';
import { TopicKafka } from '../../types/topic-kafka.enum';

type TopicHandler<T = unknown> = (payload: T) => void | Promise<void>;

/**
 * In-process event bus mô phỏng Kafka topics.
 * Production: thay bằng @nestjs/microservices + Kafka broker.
 */
@Injectable()
export class KafkaService {
  private readonly emitter = new EventEmitter();

  publish<T>(topic: TopicKafka, payload: T): void {
    this.emitter.emit(topic, payload);
  }

  subscribe<T>(topic: TopicKafka, handler: TopicHandler<T>): void {
    this.emitter.on(topic, (payload: T) => {
      void Promise.resolve(handler(payload)).catch(() => {
        // Handler lỗi — consumer tự log
      });
    });
  }
}
