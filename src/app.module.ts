import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { FacebookModule } from './facebook/facebook.module';
import { PrismaModule } from './prisma/prisma.module';
import { AppConfigModule } from './config/app-config.module';
import { RedisModule } from './redis/redis.module';
import { UploadsModule } from './uploads/uploads.module';
import { KafkaModule } from './infrastructure/kafka/kafka.module';
import { PersistenceModule } from './infrastructure/persistence/persistence.module';
import { MessagingModule } from './messaging/messaging.module';
import { ConversationModule } from './conversation/conversation.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env'],
    }),
    PrismaModule,
    RedisModule,
    KafkaModule,
    PersistenceModule,
    FacebookModule,
    MessagingModule,
    ConversationModule,
    AppConfigModule,
    UploadsModule,
  ],
})
export class AppModule {}
