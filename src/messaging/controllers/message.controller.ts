import {
  BadRequestException,
  Body,
  Controller,
  Post,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { KafkaService } from '../../infrastructure/kafka/kafka.service';
import { TopicKafka } from '../../types/topic-kafka.enum';
import type { OutboundSendPayload } from '../../types/message.types';
import { FacebookPageService } from '../../facebook/services/facebook-page.service';

@ApiTags('message')
@Controller('message')
export class MessageController {
  constructor(
    private readonly kafka: KafkaService,
    private readonly facebookPageService: FacebookPageService,
  ) {}

  @Post('text')
  @ApiOperation({
    summary:
      'Gửi tin nhắn text — enqueue Kafka FORWARD_MESSAGE_SEND (persist-first tại forward)',
  })
  async sendText(
    @Body()
    body: {
      pageId: string;
      threadId: string;
      text: string;
      replyToMessageId?: string;
      clientMessageId?: string;
    },
  ) {
    if (!body.pageId?.trim() || !body.threadId?.trim()) {
      throw new BadRequestException('Thiếu pageId hoặc threadId');
    }
    if (!body.text?.trim()) {
      throw new BadRequestException('Thiếu nội dung tin nhắn');
    }

    const orgId = this.facebookPageService.getDefaultOrgId();
    const payload: OutboundSendPayload = {
      pageId: body.pageId,
      threadId: body.threadId,
      text: body.text,
      replyToMessageId: body.replyToMessageId,
      clientMessageId: body.clientMessageId,
      orgId,
    };

    this.kafka.publish(TopicKafka.FORWARD_MESSAGE_SEND, payload);

    return {
      statusCode: 200,
      data: {
        ok: true,
        queued: true,
        clientMessageId: body.clientMessageId ?? null,
      },
    };
  }
}
