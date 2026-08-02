import { Module } from '@nestjs/common';
import { DocumentsController } from './documents.controller';
import { DocumentsService } from './documents.service';
import { VirusScanService } from './virus-scan.service';
import { AclModule } from '../acl/acl.module';
import { StorageModule } from '../storage/storage.module';
import { UsersModule } from '../users/users.module';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [AclModule, StorageModule, UsersModule, AuditModule],
  controllers: [DocumentsController],
  providers: [DocumentsService, VirusScanService],
  exports: [DocumentsService],
})
export class DocumentsModule {}
