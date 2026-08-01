import { Module } from '@nestjs/common';
import { HealthController } from './health/health.controller';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { FoldersModule } from './folders/folders.module';
import { DocumentsModule } from './documents/documents.module';

@Module({
  imports: [PrismaModule, AuthModule, UsersModule, FoldersModule, DocumentsModule],
  controllers: [HealthController],
})
export class AppModule {}
