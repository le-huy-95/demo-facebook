import {
  BadRequestException,
  Controller,
  Get,
  Param,
  Query,
  Res,
} from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { FacebookPageService } from '../services/facebook-page.service';
import { ConversationsService } from '../services/conversations.service';

@ApiTags('conversations')
@Controller('conversations')
export class ConversationsController {
  constructor(
    private readonly facebookPageService: FacebookPageService,
    private readonly conversationsService: ConversationsService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Danh sách cuộc trò chuyện theo Fanpage' })
  @ApiQuery({ name: 'pageId', required: true })
  @ApiQuery({
    name: 'limit',
    required: false,
    description: 'Số hội thoại mỗi trang (mặc định 15)',
  })
  @ApiQuery({
    name: 'before',
    required: false,
    description: 'Cursor tải hội thoại cũ hơn',
  })
  async list(
    @Query('pageId') pageId: string,
    @Query('limit') limit?: string,
    @Query('before') before?: string,
  ) {
    if (!pageId?.trim()) {
      throw new BadRequestException('Thiếu tham số pageId');
    }

    const orgId = this.facebookPageService.getDefaultOrgId();
    const parsedLimit = limit
      ? Math.min(Math.max(Number(limit), 1), 50)
      : undefined;
    const result = await this.conversationsService.listByPage(pageId, orgId, {
      limit: parsedLimit,
      before: before || undefined,
    });

    return { statusCode: 200, data: result.threads, paging: result.paging };
  }

  @Get('post')
  @ApiOperation({ summary: 'Lấy nội dung bài viết từ Facebook Graph API' })
  @ApiQuery({ name: 'pageId', required: true })
  @ApiQuery({ name: 'postId', required: true })
  async getPost(
    @Query('pageId') pageId: string,
    @Query('postId') postId: string,
  ) {
    if (!pageId?.trim() || !postId?.trim()) {
      throw new BadRequestException('Thiếu pageId hoặc postId');
    }

    const orgId = this.facebookPageService.getDefaultOrgId();
    const data = await this.conversationsService.getPostPreview(
      pageId,
      postId,
      orgId,
    );

    return { statusCode: 200, data };
  }

  @Get('avatar')
  @ApiOperation({ summary: 'Ảnh đại diện khách hàng (cache + Graph API)' })
  @ApiQuery({ name: 'pageId', required: true })
  @ApiQuery({ name: 'psid', required: true })
  async avatar(
    @Query('pageId') pageId: string,
    @Query('psid') psid: string,
    @Res() res: Response,
  ) {
    if (!pageId?.trim() || !psid?.trim()) {
      throw new BadRequestException('Thiếu pageId hoặc psid');
    }

    const orgId = this.facebookPageService.getDefaultOrgId();
    const pictureUrl = await this.conversationsService.resolveCustomerAvatarUrl(
      pageId,
      psid,
      orgId,
    );

    if (pictureUrl) {
      return res.redirect(pictureUrl);
    }

    return res.status(404).send('No avatar');
  }

  @Get(':threadId/messages')
  @ApiOperation({
    summary: 'Tin nhắn / bình luận trong một cuộc trò chuyện (phân trang)',
  })
  @ApiQuery({ name: 'pageId', required: true })
  @ApiQuery({
    name: 'limit',
    required: false,
    description: 'Số tin nhắn mỗi trang (mặc định 15)',
  })
  @ApiQuery({
    name: 'before',
    required: false,
    description: 'Cursor tải tin nhắn cũ hơn',
  })
  async messages(
    @Param('threadId') threadId: string,
    @Query('pageId') pageId: string,
    @Query('limit') limit?: string,
    @Query('before') before?: string,
  ) {
    if (!pageId?.trim()) {
      throw new BadRequestException('Thiếu tham số pageId');
    }

    const orgId = this.facebookPageService.getDefaultOrgId();
    const parsedLimit = limit
      ? Math.min(Math.max(Number(limit), 1), 50)
      : undefined;
    const result = await this.conversationsService.getThreadMessages(
      threadId,
      pageId,
      orgId,
      {
        limit: parsedLimit,
        before: before || undefined,
      },
    );

    const data = result.messages.map((e) => ({
      ...e,
      createdAt:
        e.createdAt instanceof Date
          ? e.createdAt.toISOString()
          : String(e.createdAt),
      parentCommentId: (e as any).parentCommentId ?? null,
    }));

    return { statusCode: 200, data, paging: result.paging };
  }
}
