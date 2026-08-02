import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { HealthCheckModule } from './health-check/health-check.module';

@Module({
  imports: [
    BullModule.forRoot({
      connection: {
        host: process.env.REDIS_HOST ?? 'redis',
        port: Number(process.env.REDIS_PORT ?? 6379),
      },
    }),
    HealthCheckModule,
  ],
})
export class AppModule {}
