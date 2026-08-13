import { Module } from '@nestjs/common';
import { HealthController } from './health/health.controller';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { FoldersModule } from './folders/folders.module';
import { DocumentsModule } from './documents/documents.module';
import { PermissionsModule } from './permissions/permissions.module';
import { SearchModule } from './search/search.module';
import { AuditModule } from './audit/audit.module';
import { JobsModule } from './jobs/jobs.module';
import { ScheduleModule } from '@nestjs/schedule';
import { TrashModule } from './trash/trash.module';
import { SharesModule } from './shares/shares.module';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    PrismaModule,
    AuthModule,
    UsersModule,
    FoldersModule,
    DocumentsModule,
    PermissionsModule,
    SearchModule,
    AuditModule,
    JobsModule,
    TrashModule,
    SharesModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
