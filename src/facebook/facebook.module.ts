import { Module, forwardRef } from '@nestjs/common';
import { AppLogger } from '../common/logger.service';
import { FacebookOAuthController } from './controllers/facebook-oauth.controller';
import { FacebookWebhookController } from './controllers/facebook-webhook.controller';
import { MessagesController } from './controllers/messages.controller';
import { ConversationsController } from './controllers/conversations.controller';
import { FacebookOAuthService } from './services/facebook-oauth.service';
import { FacebookGraphApiService } from './services/facebook-graph-api.service';
import { FacebookDataService } from './services/facebook-data.service';
import { FacebookPageService } from './services/facebook-page.service';
import { FacebookRepoService } from './services/facebook-repo.service';
import { FacebookWebhookService } from './services/facebook-webhook.service';
import { ConversationsService } from './services/conversations.service';
import { PageMapService } from './services/page-map.service';
import { EventsService } from './services/events.service';
import { EventsGateway } from './gateways/events.gateway';
import { FacebookMessagingService } from './services/facebook-messaging.service';
import { BroadcastService } from '../infrastructure/broadcast/broadcast.service';
import { PersistenceModule } from '../infrastructure/persistence/persistence.module';
import { KafkaModule } from '../infrastructure/kafka/kafka.module';

@Module({
  imports: [PersistenceModule, KafkaModule],
  controllers: [
    FacebookOAuthController,
    FacebookWebhookController,
    MessagesController,
    ConversationsController,
  ],
  providers: [
    AppLogger,
    FacebookOAuthService,
    FacebookGraphApiService,
    FacebookDataService,
    BroadcastService,
    FacebookPageService,
    FacebookRepoService,
    FacebookWebhookService,
    ConversationsService,
    FacebookMessagingService,
    PageMapService,
    EventsService,
    EventsGateway,
  ],
  exports: [
    AppLogger,
    FacebookPageService,
    PageMapService,
    EventsService,
    EventsGateway,
    FacebookMessagingService,
    ConversationsService,
    FacebookDataService,
    FacebookRepoService,
    BroadcastService,
  ],
})
export class FacebookModule {}
