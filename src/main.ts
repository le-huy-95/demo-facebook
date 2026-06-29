import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import * as bodyParser from 'body-parser';
import * as express from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { AppModule } from './app.module';
import { FacebookPageService } from './facebook/services/facebook-page.service';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { rawBody: true });

  const frontendUrl = process.env.FRONTEND_URL ?? 'http://localhost:3001';
  const publicBaseUrl = process.env.PUBLIC_BASE_URL;

  app.enableCors({
    origin: (
      origin: string | undefined,
      callback: (err: Error | null, allow?: boolean) => void,
    ) => {
      const allowed = [
        frontendUrl,
        'http://localhost:3000',
        'http://localhost:3001',
        publicBaseUrl,
      ].filter(Boolean) as string[];

      if (
        !origin ||
        allowed.includes(origin) ||
        /\.kindergartenmng\.vn$/.test(origin) ||
        /\.ngrok-free\.app$/.test(origin) ||
        /\.ngrok-free\.dev$/.test(origin) ||
        /\.ngrok\.io$/.test(origin)
      ) {
        callback(null, true);
        return;
      }
      callback(null, true);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'Accept',
      'ngrok-skip-browser-warning',
    ],
  });

  app.use(
    bodyParser.json({
      verify: (req: any, _res, buf) => {
        req.rawBody = buf;
      },
    }),
  );

  const uploadsDir = path.join(process.cwd(), 'uploads');
  if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
  }
  app.use('/uploads', express.static(uploadsDir));

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  const swaggerConfig = new DocumentBuilder()
    .setTitle('Facebook Pancake Demo API')
    .setDescription(
      'OAuth Facebook Page + Webhook verify/receive + Messages SSE',
    )
    .setVersion('1.0')
    .build();

  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('api-docs', app, document);

  const httpAdapter = app.getHttpAdapter();
  const httpServer = httpAdapter.getInstance();
  httpServer.get('/health', (_req: any, res: any) =>
    res.send({
      status: 'ok',
      instance: 'local-dev',
      webhookSignatureEnabled:
        process.env.FACEBOOK_WEBHOOK_SIGNATURE_ENABLED !== 'false',
      features: ['webhook-status'],
    }),
  );

  const port = process.env.PORT ?? 3000;
  await app.listen(port, '0.0.0.0');
  console.log(`HTTP server listening on http://localhost:${port}`);
  console.log(`Swagger: http://localhost:${port}/api-docs`);

  const fbPageService = app.get(FacebookPageService);
  void fbPageService.registerWebhooksAfterStartup();
}

bootstrap();
