import { Module } from '@nestjs/common';
import { AppLogger } from '../common/logger.service';
import { FacebookOAuthController } from './controllers/facebook-oauth.controller';
import { FacebookWebhookController } from './controllers/facebook-webhook.controller';
import { MessagesController } from './controllers/messages.controller';
import { ConversationsController } from './controllers/conversations.controller';
import { FacebookOAuthService } from './services/facebook-oauth.service';
import { FacebookPageService } from './services/facebook-page.service';
import { FacebookRepoService } from './services/facebook-repo.service';
import { FacebookWebhookService } from './services/facebook-webhook.service';
import { ConversationsService } from './services/conversations.service';
import { PageMapService } from './services/page-map.service';
import { EventsService } from './services/events.service';
import { EventsGateway } from './gateways/events.gateway';
import { FacebookMessagingService } from './services/facebook-messaging.service';

@Module({
  controllers: [
    FacebookOAuthController,
    FacebookWebhookController,
    MessagesController,
    ConversationsController,
  ],
  providers: [
    AppLogger,
    FacebookOAuthService,
    FacebookPageService,
    FacebookRepoService,
    FacebookWebhookService,
    ConversationsService,
    FacebookMessagingService,
    PageMapService,
    EventsService,
    EventsGateway,
  ],
  exports: [FacebookPageService, PageMapService, EventsService, EventsGateway],
})
export class FacebookModule {}
