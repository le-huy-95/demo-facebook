import { Module, forwardRef } from '@nestjs/common';
import { MessageController } from './controllers/message.controller';
import { MessagingKafkaController } from './controllers/messaging-kafka.controller';
import { KafkaModule } from '../infrastructure/kafka/kafka.module';
import { FacebookModule } from '../facebook/facebook.module';

@Module({
  imports: [KafkaModule, forwardRef(() => FacebookModule)],
  controllers: [MessageController],
  providers: [MessagingKafkaController],
})
export class MessagingModule {}
