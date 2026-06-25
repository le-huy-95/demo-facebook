import { Controller, Get } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

@ApiTags('config')
@Controller('config')
export class ConfigController {
  constructor(private readonly configService: ConfigService) {}

  @Get('facebook')
  @ApiOperation({
    summary: 'URL cấu hình Facebook Developer (OAuth + Webhook)',
  })
  getFacebookConfig() {
    const base = this.configService.get<string>(
      'PUBLIC_BASE_URL',
      'http://localhost:3000',
    );

    return {
      statusCode: 200,
      data: {
        publicBaseUrl: base,
        appId: this.configService.get('FACEBOOK_APP_ID'),
        oauthRedirectUri:
          this.configService.get<string>('FACEBOOK_OAUTH_REDIRECT_URI') ||
          `${base.replace(/\/$/, '')}/facebook-page/oauth/callback`,
        webhookUrl: `${base}/webhook/facebook`,
        webhookVerifyToken: this.configService.get(
          'FACEBOOK_WEBHOOK_VERIFY_TOKEN',
        ),
        healthCheck: `${base}/health`,
        facebookDeveloperSteps: [
          'Facebook App → Facebook Login → Settings → Valid OAuth Redirect URIs: thêm oauthRedirectUri',
          'Facebook App → Webhooks → Page → Callback URL: webhookUrl',
          'Verify Token: khớp với FACEBOOK_WEBHOOK_VERIFY_TOKEN trong .env',
          'Subscribe fields: messages, feed, message_echoes, messaging_postbacks, standby',
        ],
      },
    };
  }
}
