import { Global, Module } from '@nestjs/common';
import { MessageRepository } from './repositories/message.repository';
import { ConversationRepository } from './repositories/conversation.repository';

@Global()
@Module({
  providers: [MessageRepository, ConversationRepository],
  exports: [MessageRepository, ConversationRepository],
})
export class PersistenceModule {}
