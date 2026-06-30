import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { FacebookPageService } from '../services/facebook-page.service';
import { ConversationsService } from '../services/conversations.service';
import { FacebookWebhookService } from '../services/facebook-webhook.service';
import { FacebookMessagingService } from '../services/facebook-messaging.service';

@ApiTags('conversations')
@Controller('conversations')
export class ConversationsController {
  constructor(
    private readonly facebookPageService: FacebookPageService,
    private readonly conversationsService: ConversationsService,
    private readonly webhookService: FacebookWebhookService,
    private readonly facebookMessaging: FacebookMessagingService,
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

    if (!before && result.threads.length === 0) {
      void this.webhookService
        .syncCommentsForPage(pageId, true)
        .then(() =>
          this.conversationsService.invalidatePageCache(pageId, orgId),
        )
        .catch(() => undefined);
    }

    return { statusCode: 200, data: result.threads, paging: result.paging };
  }

  @Post('sync-comments')
  @ApiOperation({
    summary:
      'Đồng bộ bình luận từ Facebook Graph API vào DB (dùng khi DB trống hoặc thiếu webhook)',
  })
  @ApiQuery({ name: 'pageId', required: true })
  @ApiQuery({ name: 'force', required: false })
  async syncComments(
    @Query('pageId') pageId: string,
    @Query('force') force?: string,
  ) {
    if (!pageId?.trim()) {
      throw new BadRequestException('Thiếu tham số pageId');
    }

    const orgId = this.facebookPageService.getDefaultOrgId();
    const result = await this.webhookService.syncCommentsForPage(
      pageId,
      force === 'true' || force === '1',
    );
    await this.conversationsService.invalidatePageCache(pageId, orgId);

    return {
      statusCode: 200,
      data: result,
    };
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

  @Get('resolve-messenger-psid')
  @ApiOperation({
    summary:
      'Tìm PSID Messenger từ người bình luận (khi chuyển từ tab bình luận sang nhắn tin)',
  })
  @ApiQuery({ name: 'pageId', required: true })
  @ApiQuery({ name: 'commentAuthorId', required: false })
  @ApiQuery({ name: 'senderName', required: false })
  async resolveMessengerPsid(
    @Query('pageId') pageId: string,
    @Query('commentAuthorId') commentAuthorId?: string,
    @Query('senderName') senderName?: string,
  ) {
    if (!pageId?.trim()) {
      throw new BadRequestException('Thiếu pageId');
    }

    const orgId = this.facebookPageService.getDefaultOrgId();
    const data = await this.conversationsService.resolveMessengerPsid(
      pageId,
      orgId,
      { commentAuthorId, senderName },
    );

    return { statusCode: 200, data };
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

    return { statusCode: 200, data, paging: result.paging, meta: result.meta };
  }

  @Post('messages/:messageId/reaction')
  @ApiOperation({ summary: 'Thả emoji reaction lên tin nhắn Messenger của khách' })
  @ApiQuery({ name: 'pageId', required: true })
  @ApiQuery({ name: 'threadId', required: true })
  @ApiQuery({ name: 'emoji', required: true })
  async reactToMessage(
    @Param('messageId') messageId: string,
    @Query('pageId') pageId: string,
    @Query('threadId') threadId: string,
    @Query('emoji') emoji: string,
  ) {
    if (!pageId?.trim() || !threadId?.trim() || !messageId?.trim()) {
      throw new BadRequestException('Thiếu pageId, threadId hoặc messageId');
    }

    const orgId = this.facebookPageService.getDefaultOrgId();
    const data = await this.conversationsService.reactToMessengerMessage({
      pageId,
      threadId,
      messageId,
      emoji,
      orgId,
    });
    return { statusCode: 200, data };
  }

  @Post('messages/:messageId/unreact')
  @ApiOperation({ summary: 'Bỏ emoji reaction trên tin nhắn Messenger' })
  @ApiQuery({ name: 'pageId', required: true })
  @ApiQuery({ name: 'threadId', required: true })
  async unreactToMessage(
    @Param('messageId') messageId: string,
    @Query('pageId') pageId: string,
    @Query('threadId') threadId: string,
  ) {
    if (!pageId?.trim() || !threadId?.trim() || !messageId?.trim()) {
      throw new BadRequestException('Thiếu pageId, threadId hoặc messageId');
    }

    const orgId = this.facebookPageService.getDefaultOrgId();
    const data = await this.conversationsService.unreactToMessengerMessage({
      pageId,
      threadId,
      messageId,
      orgId,
    });
    return { statusCode: 200, data };
  }

  @Post('messages/:messageId/pin')
  @ApiOperation({ summary: 'Ghim tin nhắn Messenger lên đầu cuộc trò chuyện' })
  @ApiQuery({ name: 'pageId', required: true })
  @ApiQuery({ name: 'threadId', required: true })
  async pinMessage(
    @Param('messageId') messageId: string,
    @Query('pageId') pageId: string,
    @Query('threadId') threadId: string,
  ) {
    if (!pageId?.trim() || !threadId?.trim() || !messageId?.trim()) {
      throw new BadRequestException('Thiếu pageId, threadId hoặc messageId');
    }

    const orgId = this.facebookPageService.getDefaultOrgId();
    const data = await this.conversationsService.pinMessengerMessage({
      pageId,
      threadId,
      messageId,
      orgId,
    });
    return { statusCode: 200, data };
  }

  @Post('messages/:messageId/unpin')
  @ApiOperation({ summary: 'Bỏ ghim tin nhắn Messenger' })
  @ApiQuery({ name: 'pageId', required: true })
  @ApiQuery({ name: 'threadId', required: true })
  async unpinMessage(
    @Param('messageId') messageId: string,
    @Query('pageId') pageId: string,
    @Query('threadId') threadId: string,
  ) {
    if (!pageId?.trim() || !threadId?.trim() || !messageId?.trim()) {
      throw new BadRequestException('Thiếu pageId, threadId hoặc messageId');
    }

    const orgId = this.facebookPageService.getDefaultOrgId();
    const data = await this.conversationsService.unpinMessengerMessage({
      pageId,
      threadId,
      messageId,
      orgId,
    });
    return { statusCode: 200, data };
  }

  @Post(':threadId/send')
  @ApiOperation({
    summary:
      'Gửi tin nhắn Messenger, bình luận mới trên bài viết, hoặc trả lời bình luận (có commentId)',
  })
  async sendInThread(
    @Param('threadId') threadId: string,
    @Body()
    body: {
      pageId: string;
      text?: string;
      commentId?: string;
      replyToMessageId?: string;
      clientMessageId?: string;
      attachment?: {
        type: 'image' | 'video' | 'audio' | 'file';
        url: string;
      };
    },
  ) {
    if (!body.pageId?.trim()) {
      throw new BadRequestException('Thiếu pageId');
    }

    try {
      const result = await this.facebookMessaging.sendToThread({
        pageId: body.pageId,
        threadId,
        text: body.text,
        attachment: body.attachment,
        commentId: body.commentId,
        replyToMessageId: body.replyToMessageId,
        clientMessageId: body.clientMessageId,
      });

      return {
        statusCode: 200,
        data: {
          ok: true,
          clientMessageId: body.clientMessageId ?? null,
          fbMessageId: result.fb.messageId ?? null,
          savedEventId: result.savedEvent.id,
        },
      };
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : 'Gửi tin nhắn thất bại';
      throw new BadRequestException(message);
    }
  }

  @Post('comments/:commentId/action')
  @ApiOperation({
    summary: 'Thực hiện hành động trên bình luận (thích / ẩn / hiện)',
  })
  @ApiQuery({ name: 'pageId', required: true })
  @ApiQuery({
    name: 'action',
    required: true,
    description: 'like | unlike | hide | unhide',
  })
  async commentAction(
    @Param('commentId') commentId: string,
    @Query('pageId') pageId: string,
    @Query('action') action: string,
  ) {
    if (!pageId?.trim() || !commentId?.trim()) {
      throw new BadRequestException('Thiếu pageId hoặc commentId');
    }

    const normalized = action?.trim().toLowerCase();
    if (normalized === 'like') {
      const data = await this.webhookService.likeCommentOnPage(
        pageId,
        commentId,
      );
      return { statusCode: 200, data };
    }

    if (normalized === 'unlike') {
      const data = await this.webhookService.unlikeCommentOnPage(
        pageId,
        commentId,
      );
      return { statusCode: 200, data };
    }

    if (normalized === 'hide') {
      const data = await this.webhookService.setCommentHiddenOnPage(
        pageId,
        commentId,
        true,
      );
      return { statusCode: 200, data };
    }

    if (normalized === 'unhide') {
      const data = await this.webhookService.setCommentHiddenOnPage(
        pageId,
        commentId,
        false,
      );
      return { statusCode: 200, data };
    }

    throw new BadRequestException(
      'action không hợp lệ — dùng like, unlike, hide hoặc unhide',
    );
  }
}
