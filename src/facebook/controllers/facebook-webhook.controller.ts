import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Header,
  Headers,
  HttpStatus,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import * as crypto from 'crypto';
import type { Request, Response } from 'express';
import { AppLogger } from '../../common/logger.service';
import { FacebookWebhookService } from '../services/facebook-webhook.service';
import { FacebookOAuthService } from '../services/facebook-oauth.service';
import { FacebookPageService } from '../services/facebook-page.service';

@ApiTags('facebook-webhook')
@Controller('webhook/facebook')
export class FacebookWebhookController {
  private readonly verifyToken: string;
  private readonly appSecret: string;
  private readonly signatureEnabled: boolean;

  constructor(
    private readonly logger: AppLogger,
    private readonly configService: ConfigService,
    private readonly webhookService: FacebookWebhookService,
    private readonly facebookOAuthService: FacebookOAuthService,
    private readonly facebookPageService: FacebookPageService,
  ) {
    this.verifyToken = this.configService.get<string>(
      'FACEBOOK_WEBHOOK_VERIFY_TOKEN',
      'dev_verify_token',
    );
    this.appSecret = this.configService.get<string>(
      'FACEBOOK_APP_SECRET',
      'dev_secret',
    );
    this.signatureEnabled =
      this.configService.get<string>('FACEBOOK_WEBHOOK_SIGNATURE_ENABLED', 'true')
        .toLowerCase() !== 'false';
    this.logger.setContext(FacebookWebhookController.name);
    this.validateConfig();
  }

  private validateConfig(): void {
    const missingOrInvalid: string[] = [];

    if (!this.appSecret || this.appSecret === 'your_app_secret') {
      missingOrInvalid.push('Thiết lập giá trị hợp lệ cho FACEBOOK_APP_SECRET');
    }

    if (!this.verifyToken || this.verifyToken === 'your_verify_token') {
      missingOrInvalid.push(
        'Thiết lập giá trị hợp lệ cho FACEBOOK_WEBHOOK_VERIFY_TOKEN',
      );
    }

    if (missingOrInvalid.length > 0) {
      const msg =
        `[FacebookWebhookController] Thiếu hoặc sai cấu hình biến môi trường:\n` +
        missingOrInvalid.map((v) => `  ✗ ${v}`).join('\n');
      this.logger.error(msg);
      throw new Error(msg);
    }
  }

  @Get()
  @Header('Content-Type', 'text/plain; charset=utf-8')
  @ApiOperation({ summary: 'Facebook Hub Challenge verification' })
  verifyWebhook(@Req() req: Request): string {
    const q = req.query ?? {};

    const mode: string =
      (q?.hub as any)?.mode ??
      (q?.hub_mode as string) ??
      (q['hub.mode'] as string);
    const token: string =
      (q?.hub as any)?.verify_token ??
      (q?.hub_verify_token as string) ??
      (q['hub.verify_token'] as string);
    const challenge: string =
      (q?.hub as any)?.challenge ??
      (q?.hub_challenge as string) ??
      (q['hub.challenge'] as string);

    this.logger.debug(
      `[Webhook] Verification — mode=${mode}, token=${token}, url=${req?.url}`,
    );

    if (mode === 'subscribe' && token === this.verifyToken) {
      this.logger.log('Facebook webhook verified successfully');
      return challenge;
    }

    this.logger.warn(
      `Webhook verification failed. mode=${mode}, token=${token}, expectedToken=${this.verifyToken}`,
    );
    throw new ForbiddenException('Forbidden');
  }

  @Post()
  @ApiOperation({ summary: 'Nhận sự kiện Messenger từ Facebook' })
  async handleWebhookEvent(
    @Req() req: Request & { rawBody?: Buffer },
    @Body() body: any,
    @Headers('x-hub-signature-256') signature: string,
    @Res() res: Response,
  ) {
    const rawBody = req?.rawBody
      ? req.rawBody.toString('utf8')
      : JSON.stringify(body);
    const clientIp =
      (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
      req.socket?.remoteAddress ||
      'unknown';

    this.logger.log(
      `[Webhook] POST from ${clientIp} len=${rawBody.length} hasSignature=${!!signature} object=${body?.object ?? 'n/a'}`,
    );
    this.logger.debug(
      '[FacebookWebhookController] Received webhook rawBody',
      rawBody,
    );

    if (!this.validateSignature(rawBody, signature)) {
      this.logger.warn(
        `[Webhook] Rejected POST from ${clientIp} — invalid signature (signatureEnabled=${this.signatureEnabled})`,
      );
      return res.status(HttpStatus.UNAUTHORIZED).send('Invalid signature');
    }

    if (body.object !== 'page') {
      this.logger.debug('[FacebookWebhookController] Not a page subscription');
      return res.status(HttpStatus.NOT_FOUND).send('Not Found');
    }

    res.status(HttpStatus.OK).send('EVENT_RECEIVED');

    const entryCount = body.entry?.length ?? 0;
    const feedChanges = (body.entry ?? []).reduce(
      (n: number, e: any) =>
        n + (e.changes ?? []).filter((c: any) => c.field === 'feed').length,
      0,
    );
    const messagingCount = (body.entry ?? []).reduce(
      (n: number, e: any) => n + (e.messaging?.length ?? 0) + (e.standby?.length ?? 0),
      0,
    );
    this.logger.log(
      `[Webhook] Processing ${entryCount} entry(ies): ${feedChanges} feed change(s), ${messagingCount} messaging event(s)`,
    );

    try {
      await this.webhookService.processWebhookBody(body);
    } catch (err) {
      this.logger.error('Error processing webhook event', err);
    }
  }

  @Get('events')
  @ApiOperation({ summary: 'Xem các webhook event gần đây (demo)' })
  async listEvents() {
    const events = await this.webhookService.listRecentEvents();
    return {
      statusCode: HttpStatus.OK,
      data: events,
    };
  }

  @Get('status')
  @ApiOperation({ summary: 'Trạng thái webhook — dùng để debug inbound Facebook' })
  async webhookStatus() {
    const base = this.configService
      .get<string>('PUBLIC_BASE_URL', 'http://localhost:3000')
      .replace(/\/$/, '');
    const stats = await this.webhookService.getWebhookStats();

    return {
      statusCode: HttpStatus.OK,
      data: {
        webhookUrl: `${base}/webhook/facebook`,
        verifyToken: this.verifyToken,
        signatureEnabled: this.signatureEnabled,
        stats,
        hint:
          stats.inCount === 0
            ? 'Chưa có tin IN từ Facebook. Kiểm tra Callback URL trên Facebook Developer và tunnel forward → localhost:3000'
            : 'Webhook inbound đã nhận tin nhắn trước đó',
      },
    };
  }

  @Post('subscribe')
  @ApiOperation({ summary: 'Đăng ký app-level webhook callback URL với Facebook và re-subscribe tất cả pages' })
  async subscribeWebhook() {
    const appResult = await this.facebookOAuthService.subscribeAppWebhook();

    const base = this.configService
      .get<string>('PUBLIC_BASE_URL', 'http://localhost:3000')
      .replace(/\/$/, '');

    const pageResults = await this.facebookPageService.resubscribeAllPages();

    return {
      statusCode: HttpStatus.OK,
      data: {
        appWebhookRegistered: appResult,
        callbackUrl: `${base}/webhook/facebook`,
        pageSubscriptions: pageResults,
        hint: appResult
          ? 'App-level webhook registered successfully. Facebook sẽ gửi feed events tới callback URL.'
          : 'Không thể đăng ký webhook. Kiểm tra FACEBOOK_APP_ID, FACEBOOK_APP_SECRET và PUBLIC_BASE_URL.',
      },
    };
  }

  @Get('subscriptions')
  @ApiOperation({ summary: 'Kiểm tra trạng thái đăng ký webhook hiện tại với Facebook' })
  async checkSubscriptions() {
    const appSubs = await this.facebookOAuthService.getAppSubscriptions();
    const pageSubs = await this.facebookPageService.getPageSubscriptions();

    return {
      statusCode: HttpStatus.OK,
      data: {
        appSubscriptions: appSubs,
        pageSubscriptions: pageSubs,
      },
    };
  }

  private validateSignature(rawBody: string, signature: string): boolean {
    if (!this.signatureEnabled) {
      this.logger.warn(
        '[Webhook] Signature validation disabled (FACEBOOK_WEBHOOK_SIGNATURE_ENABLED=false)',
      );
      return true;
    }
    if (!signature || !this.appSecret) return false;

    const expected = `sha256=${crypto.createHmac('sha256', this.appSecret).update(rawBody).digest('hex')}`;

    const sigBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expected);
    if (sigBuffer.length !== expectedBuffer.length) return false;

    return crypto.timingSafeEqual(sigBuffer, expectedBuffer);
  }
}
