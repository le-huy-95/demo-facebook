import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { renderOAuthCallbackPage } from '../../utils/oauth-popup.util';
import { AppLogger } from '../../common/logger.service';
import { FacebookOAuthCallbackDto } from '../dto/callback.dto';
import { InitiateFacebookOAuthDto } from '../dto/initiate-oauth.dto';
import { FacebookPageService } from '../services/facebook-page.service';

@ApiTags('facebook-oauth')
@Controller()
export class FacebookOAuthController {
  constructor(
    private readonly logger: AppLogger,
    private readonly facebookPageService: FacebookPageService,
  ) {
    this.logger.setContext(FacebookOAuthController.name);
  }

  @Post('facebook-page/oauth-url')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Khởi tạo OAuth URL để liên kết Facebook Page' })
  async initiateOAuth(@Body() dto: InitiateFacebookOAuthDto) {
    const orgId = this.facebookPageService.getDefaultOrgId();
    const result = await this.facebookPageService.initiateOAuth(orgId, dto);

    return {
      statusCode: HttpStatus.OK,
      message: 'Tạo OAuth URL thành công.',
      data: result,
    };
  }

  @Get('facebook-page/pages')
  @ApiOperation({ summary: 'Danh sách shop (Facebook Page) đã liên kết' })
  async listPages() {
    const orgId = this.facebookPageService.getDefaultOrgId();
    const shops = await this.facebookPageService.listShops(orgId);

    return {
      statusCode: HttpStatus.OK,
      message: 'Lấy danh sách shop thành công.',
      data: shops,
    };
  }

  @Post('facebook-page/pages/:id/pin')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Ghim / bỏ ghim Facebook Page' })
  async togglePin(@Param('id') id: string) {
    const orgId = this.facebookPageService.getDefaultOrgId();
    const result = await this.facebookPageService.togglePin(orgId, id);

    return {
      statusCode: HttpStatus.OK,
      message: result.isPinned ? 'Đã ghim trang.' : 'Đã bỏ ghim trang.',
      data: result,
    };
  }

  @Delete('facebook-page/pages/:id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Hủy liên kết một Facebook Page' })
  async unlinkPage(@Param('id') id: string) {
    const orgId = this.facebookPageService.getDefaultOrgId();
    const result = await this.facebookPageService.unlinkPage(orgId, id);

    return {
      statusCode: HttpStatus.OK,
      message: 'Huỷ kích hoạt trang thành công.',
      data: result,
    };
  }

  @Post('facebook-page/pages/:id/resubscribe-webhook')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Đăng ký lại webhook Facebook cho Page (sau khi đổi Callback URL)',
  })
  async resubscribeWebhook(@Param('id') id: string) {
    const orgId = this.facebookPageService.getDefaultOrgId();
    const result = await this.facebookPageService.resubscribeWebhook(
      orgId,
      id,
    );

    return {
      statusCode: HttpStatus.OK,
      message: result.subscribed
        ? 'Đăng ký webhook Page thành công.'
        : 'Đăng ký webhook Page thất bại — kiểm tra Facebook App Webhooks.',
      data: result,
    };
  }

  @Get('facebook-page/oauth/callback')
  @ApiOperation({ summary: 'Xử lý callback của Facebook OAuth' })
  async handleFacebookCallback(
    @Query() query: FacebookOAuthCallbackDto,
    @Res() res: Response,
  ) {
    if (query.error) {
      const message =
        query.error_description ??
        (query.error_code ? `[${query.error_code}] ` : '') +
          (query.error_reason ?? query.error);
      this.logger.warn(
        `OAuth cancelled: error=${query.error}, code=${query.error_code ?? 'n/a'}, action=${query.action ?? 'n/a'}, reason=${query.error_reason ?? 'n/a'}`,
      );
      return res
        .status(HttpStatus.OK)
        .type('text/html')
        .send(
          renderOAuthCallbackPage(
            'error',
            `Xác thực Facebook thất bại: ${message}`,
          ),
        );
    }

    if (!query.code || !query.state) {
      return res
        .status(HttpStatus.BAD_REQUEST)
        .type('text/html')
        .send(
          renderOAuthCallbackPage(
            'error',
            'Thiếu tham số code hoặc state từ Facebook.',
          ),
        );
    }

    try {
      const result = await this.facebookPageService.handleOAuthCallback(
        query.code,
        query.state,
      );
      this.logger.log(
        `OAuth callback success: linked ${result.savedPages} page(s)`,
      );
      return res
        .status(HttpStatus.OK)
        .type('text/html')
        .send(
          renderOAuthCallbackPage(
            'success',
            `Liên kết thành công ${result.savedPages} Facebook Page!`,
          ),
        );
    } catch (err: any) {
      this.logger.error('OAuth callback failed', err);
      return res
        .status(HttpStatus.BAD_REQUEST)
        .type('text/html')
        .send(
          renderOAuthCallbackPage(
            'error',
            err?.message ?? 'OAuth callback failed',
          ),
        );
    }
  }
}
