import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import * as os from 'os';

@Processor('health-check')
export class HealthCheckProcessor extends WorkerHost {
  private readonly logger = new Logger(HealthCheckProcessor.name);

  async process(job: Job): Promise<{ pong: true; processedAt: string; workerHostname: string }> {
    this.logger.log(`Processing job ${job.id} (${job.name})`);
    return {
      pong: true,
      processedAt: new Date().toISOString(),
      workerHostname: os.hostname(),
    };
  }
}
