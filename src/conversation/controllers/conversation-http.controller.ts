import {
  BadRequestException,
  Controller,
  Get,
  Param,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { ConversationQueryService } from '../services/conversation-query.service';
import { FacebookPageService } from '../../facebook/services/facebook-page.service';

@ApiTags('conversation')
@Controller('conversation')
export class ConversationHttpController {
  constructor(
    private readonly queryService: ConversationQueryService,
    private readonly facebookPageService: FacebookPageService,
  ) {}

  @Get('history')
  @ApiOperation({
    summary:
      'Lịch sử tin nhắn từ DB (message_history) — không gọi Facebook Graph API',
  })
  @ApiQuery({ name: 'pageId', required: true })
  @ApiQuery({ name: 'threadId', required: true })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'before', required: false })
  async history(
    @Query('pageId') pageId: string,
    @Query('threadId') threadId: string,
    @Query('limit') limit?: string,
    @Query('before') before?: string,
  ) {
    if (!pageId?.trim() || !threadId?.trim()) {
      throw new BadRequestException('Thiếu pageId hoặc threadId');
    }

    const orgId = this.facebookPageService.getDefaultOrgId();
    const parsedLimit = limit
      ? Math.min(Math.max(Number(limit), 1), 50)
      : undefined;

    const data = await this.queryService.getMessageHistory(
      pageId,
      orgId,
      threadId,
      { limit: parsedLimit, before: before || undefined },
    );

    return { statusCode: 200, data };
  }

  @Get('list')
  @ApiOperation({ summary: 'Danh sách hội thoại từ DB (webhook + outbound)' })
  @ApiQuery({ name: 'pageId', required: true })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'before', required: false })
  async list(
    @Query('pageId') pageId: string,
    @Query('limit') limit?: string,
    @Query('before') before?: string,
  ) {
    if (!pageId?.trim()) {
      throw new BadRequestException('Thiếu pageId');
    }

    const orgId = this.facebookPageService.getDefaultOrgId();
    const parsedLimit = limit
      ? Math.min(Math.max(Number(limit), 1), 50)
      : undefined;

    const result = await this.queryService.listConversations(pageId, orgId, {
      limit: parsedLimit,
      before: before || undefined,
    });

    return { statusCode: 200, data: result.threads, paging: result.paging };
  }
}
