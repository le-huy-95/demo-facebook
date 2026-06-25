import { Controller, Get, Header } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiExcludeController } from '@nestjs/swagger';

@ApiExcludeController()
@Controller('setup')
export class SetupController {
  constructor(private readonly configService: ConfigService) {}

  @Get('facebook')
  @Header('Content-Type', 'text/html; charset=utf-8')
  facebookSetupPage(): string {
    const base = this.configService
      .get<string>('PUBLIC_BASE_URL', 'http://localhost:3000')
      .replace(/\/$/, '');
    const oauthRedirect =
      this.configService.get<string>('FACEBOOK_OAUTH_REDIRECT_URI') ||
      `${base}/facebook-page/oauth/callback`;
    const webhookUrl = `${base}/webhook/facebook`;
    const verifyToken = this.configService.get(
      'FACEBOOK_WEBHOOK_VERIFY_TOKEN',
      'dev_verify_token',
    );
    const appId = this.configService.get('FACEBOOK_APP_ID', '');

    return `<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="utf-8" />
  <title>Cấu hình Facebook OAuth</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 720px; margin: 40px auto; padding: 0 16px; line-height: 1.5; }
    h1 { font-size: 1.5rem; }
    code, .url { background: #f4f4f5; padding: 2px 6px; border-radius: 4px; word-break: break-all; }
    .box { border: 1px solid #e4e4e7; border-radius: 8px; padding: 12px 16px; margin: 12px 0; }
    ol li { margin: 8px 0; }
    a { color: #2563eb; }
  </style>
</head>
<body>
  <h1>Sửa lỗi &quot;URL bị chặn&quot; — Facebook Developer</h1>
  <p>App ID: <code>${appId}</code></p>
  <p>Mở <a href="https://developers.facebook.com/apps/${appId}/fb-login/settings/" target="_blank" rel="noopener">Facebook Login → Settings</a></p>

  <div class="box">
    <strong>1. Valid OAuth Redirect URIs</strong> (copy chính xác):
    <div class="url">${oauthRedirect}</div>
  </div>

  <div class="box">
    <strong>2. App Domains</strong> (Settings → Basic):
    <div class="url">${new URL(base).hostname}</div>
  </div>

  <div class="box">
    <strong>3. Site URL</strong> (Facebook Login → Settings):
    <div class="url">${base}/</div>
  </div>

  <div class="box">
    <strong>4. Webhook</strong> (Webhooks → Page):
    <div>Callback URL: <span class="url">${webhookUrl}</span></div>
    <div>Verify Token: <code>${verifyToken}</code></div>
  </div>

  <ol>
    <li>Bật <strong>Client OAuth Login</strong> và <strong>Web OAuth Login</strong></li>
    <li>Thêm URI ở mục 1 vào <strong>Valid OAuth Redirect URIs</strong> → Save</li>
    <li>Tài khoản Facebook đăng nhập phải là <strong>Admin/Developer/Tester</strong> của app (nếu app ở chế độ Development)</li>
    <li>Quay lại <a href="${base}/login">trang đăng nhập</a> và thử lại</li>
  </ol>
</body>
</html>`;
  }
}
