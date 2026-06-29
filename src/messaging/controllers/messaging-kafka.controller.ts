import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { KafkaService } from '../../infrastructure/kafka/kafka.service';
import { TopicKafka } from '../../types/topic-kafka.enum';
import { FacebookMessagingService } from '../../facebook/services/facebook-messaging.service';
import type { OutboundSendPayload } from '../../types/message.types';

/**
 * Kafka consumer: xử lý FORWARD_MESSAGE_SEND từ API layer.
 * Demo: in-process bus; production: @EventPattern trên Kafka broker.
 */
@Injectable()
export class MessagingKafkaController implements OnModuleInit {
  private readonly logger = new Logger(MessagingKafkaController.name);

  constructor(
    private readonly kafka: KafkaService,
    private readonly messagingService: FacebookMessagingService,
  ) {}

  onModuleInit(): void {
    this.kafka.subscribe<OutboundSendPayload>(
      TopicKafka.FORWARD_MESSAGE_SEND,
      async (payload) => {
        await this.handleSendMessage(payload);
      },
    );
  }

  async handleSendMessage(data: OutboundSendPayload): Promise<void> {
    this.logger.log(
      `[Kafka] FORWARD_MESSAGE_SEND thread=${data.threadId} page=${data.pageId}`,
    );
    await this.messagingService.sendToThread({
      pageId: data.pageId,
      threadId: data.threadId,
      text: data.text,
      attachment: data.attachment,
      commentId: data.commentId,
      replyToMessageId: data.replyToMessageId,
      clientMessageId: data.clientMessageId,
    });
  }
}
