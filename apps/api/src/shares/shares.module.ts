import { Module } from '@nestjs/common';
import { SharesController } from './shares.controller';
import { SharesEditorController } from './shares-editor.controller';
import { SharesService } from './shares.service';
import { AclModule } from '../acl/acl.module';
import { StorageModule } from '../storage/storage.module';
import { AuditModule } from '../audit/audit.module';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [AclModule, StorageModule, AuditModule, UsersModule],
  controllers: [SharesController, SharesEditorController],
  providers: [SharesService],
  exports: [SharesService],
})
export class SharesModule {}
