import { Global, Module } from '@nestjs/common';
import { AppLogger } from '../common/logger.service';
import { RedisCacheService } from './redis-cache.service';

@Global()
@Module({
  providers: [AppLogger, RedisCacheService],
  exports: [RedisCacheService],
})
export class RedisModule {}
