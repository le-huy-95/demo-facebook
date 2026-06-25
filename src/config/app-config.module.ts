import { Module } from '@nestjs/common';
import { ConfigController } from './config.controller';
import { SetupController } from './setup.controller';

@Module({
  controllers: [ConfigController, SetupController],
})
export class AppConfigModule {}
