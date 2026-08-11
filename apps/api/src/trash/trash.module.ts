import { Module } from '@nestjs/common';
import { TrashController } from './trash.controller';
import { TrashService } from './trash.service';
import { StorageModule } from '../storage/storage.module';
import { UsersModule } from '../users/users.module';
import { AuditModule } from '../audit/audit.module';

@Module({ imports: [StorageModule, UsersModule, AuditModule], controllers: [TrashController], providers: [TrashService] })
export class TrashModule {}
