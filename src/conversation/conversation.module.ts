import { Module, forwardRef } from '@nestjs/common';
import { ConversationHttpController } from './controllers/conversation-http.controller';
import { ConversationQueryService } from './services/conversation-query.service';
import { PersistenceModule } from '../infrastructure/persistence/persistence.module';
import { FacebookModule } from '../facebook/facebook.module';

@Module({
  imports: [PersistenceModule, forwardRef(() => FacebookModule)],
  controllers: [ConversationHttpController],
  providers: [ConversationQueryService],
  exports: [ConversationQueryService],
})
export class ConversationModule {}
