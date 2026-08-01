import { Module } from '@nestjs/common';
import { PermissionsController } from './permissions.controller';
import { PermissionsService } from './permissions.service';
import { AclModule } from '../acl/acl.module';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [AclModule, UsersModule],
  controllers: [PermissionsController],
  providers: [PermissionsService],
})
export class PermissionsModule {}
