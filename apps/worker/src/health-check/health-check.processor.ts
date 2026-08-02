import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import * as os from 'os';

@Processor('health-check')
export class HealthCheckProcessor extends WorkerHost {
  async process(job: Job): Promise<{ pong: true; processedAt: string; workerHostname: string }> {
    return {
      pong: true,
      processedAt: new Date().toISOString(),
      workerHostname: os.hostname(),
    };
  }
}
