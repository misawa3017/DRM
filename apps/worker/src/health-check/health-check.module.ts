import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { HealthCheckProcessor } from './health-check.processor';

@Module({
  imports: [BullModule.registerQueue({ name: 'health-check' })],
  providers: [HealthCheckProcessor],
})
export class HealthCheckModule {}
