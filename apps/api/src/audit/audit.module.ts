import { Module } from '@nestjs/common';
import { AuditController } from './audit.controller';
import { AuditService } from './audit.service';
import { AclModule } from '../acl/acl.module';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [AclModule, UsersModule],
  controllers: [AuditController],
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
