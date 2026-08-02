import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { QUEUE_DOCUMENT_CONVERSION } from '@drm/shared';
import { ConversionProcessor } from './conversion.processor';
import { StorageModule } from '../storage/storage.module';

@Module({
  imports: [BullModule.registerQueue({ name: QUEUE_DOCUMENT_CONVERSION }), StorageModule],
  providers: [ConversionProcessor],
})
export class ConversionModule {}
