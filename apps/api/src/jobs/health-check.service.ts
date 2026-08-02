import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';

@Injectable()
export class HealthCheckService {
  constructor(@InjectQueue('health-check') private readonly queue: Queue) {}

  async enqueuePing(): Promise<string> {
    const job = await this.queue.add('ping', { requestedAt: new Date().toISOString() });
    return job.id!;
  }
}
