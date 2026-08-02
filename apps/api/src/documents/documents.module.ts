import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { QUEUE_DOCUMENT_CONVERSION } from '@drm/shared';
import { DocumentsController } from './documents.controller';
import { DocumentsService } from './documents.service';
import { VirusScanService } from './virus-scan.service';
import { ConversionEventsListener } from './conversion-events.listener';
import { AclModule } from '../acl/acl.module';
import { StorageModule } from '../storage/storage.module';
import { UsersModule } from '../users/users.module';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [
    AclModule,
    StorageModule,
    UsersModule,
    AuditModule,
    // No connection options here: JobsModule's BullModule.forRoot (see
    // apps/api/src/jobs/jobs.module.ts) registers the shared Redis
    // connection config as a `global: true` Nest module (confirmed by
    // reading @nestjs/bullmq's dist/bull.module.js), so registerQueue here
    // picks it up automatically -- same pattern JobsModule itself uses for
    // its own 'health-check' queue.
    BullModule.registerQueue({ name: QUEUE_DOCUMENT_CONVERSION }),
  ],
  controllers: [DocumentsController],
  providers: [DocumentsService, VirusScanService, ConversionEventsListener],
  exports: [DocumentsService],
})
export class DocumentsModule {}
