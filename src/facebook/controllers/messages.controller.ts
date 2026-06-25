import { Controller, Get, Post, Query, Sse } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Observable, map } from 'rxjs';
import type { WebhookEvent } from '@prisma/client';
import { FacebookWebhookService } from '../services/facebook-webhook.service';
import { EventsService } from '../services/events.service';
import { FacebookPageService } from '../services/facebook-page.service';

@ApiTags('messages')
@Controller('messages')
export class MessagesController {
  constructor(
    private readonly webhookService: FacebookWebhookService,
    private readonly eventsService: EventsService,
    private readonly facebookPageService: FacebookPageService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Danh sách tin nhắn / bình luận từ webhook' })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({
    name: 'type',
    required: false,
    description: 'MESSENGER | FEED_COMMENT | FEED_POST',
  })
  async list(@Query('limit') limit?: string, @Query('type') type?: string) {
    const events = await this.webhookService.listRecentEvents(
      limit ? Number(limit) : 100,
      type || undefined,
    );

    return {
      statusCode: 200,
      data: events,
    };
  }

  @Get('auth/status')
  @ApiOperation({ summary: 'Kiểm tra đã liên kết Facebook Page chưa' })
  async authStatus() {
    const orgId = this.facebookPageService.getDefaultOrgId();
    const pages = await this.facebookPageService.listShops(orgId);

    return {
      statusCode: 200,
      data: {
        connected: pages.length > 0,
        pages,
      },
    };
  }

  @Post('auth/logout')
  @ApiOperation({ summary: 'Đăng xuất — gỡ liên kết Facebook Page' })
  async logout() {
    const orgId = this.facebookPageService.getDefaultOrgId();
    const result = await this.facebookPageService.logout(orgId);

    return {
      statusCode: 200,
      data: {
        success: true,
        disconnectedPages: result.disconnectedPages,
      },
    };
  }

  @Sse('stream')
  @ApiOperation({ summary: 'SSE stream tin nhắn mới realtime' })
  stream(): Observable<MessageEvent> {
    return new Observable<MessageEvent>((subscriber) => {
      const handler = (event: WebhookEvent) => {
        subscriber.next({
          data: JSON.stringify(event),
        } as MessageEvent);
      };

      this.eventsService.onMessage(handler);

      return () => {
        this.eventsService.offMessage(handler);
      };
    }).pipe(map((event) => event));
  }
}
