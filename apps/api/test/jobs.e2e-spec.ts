import { Queue, QueueEvents } from 'bullmq';

const REDIS_CONNECTION = { host: '127.0.0.1', port: 6380 };

// Mirrors apps/worker/src/health-check/health-check.processor.ts's return
// type. job.waitUntilFinished() is typed `any` by BullMQ (it can't know
// the processor's return shape from the queue side), which trips
// @typescript-eslint/no-unsafe-assignment / no-unsafe-member-access on
// direct use -- asserting to this explicit shape keeps the check honest
// (still enforces workerHostname exists as a string) without disabling
// the lint rule.
interface HealthCheckResult {
  pong: true;
  processedAt: string;
  workerHostname: string;
}

describe('Background job processing (e2e, real worker)', () => {
  let queue: Queue;
  let queueEvents: QueueEvents;

  beforeAll(() => {
    queue = new Queue('health-check', { connection: REDIS_CONNECTION });
    queueEvents = new QueueEvents('health-check', { connection: REDIS_CONNECTION });
  });

  afterAll(async () => {
    await queue.close();
    await queueEvents.close();
  });

  it('a job enqueued from the host is picked up and processed by the real worker container', async () => {
    const job = await queue.add('ping', { source: 'e2e-test', requestedAt: new Date().toISOString() });

    const result = (await job.waitUntilFinished(queueEvents, 15000)) as HealthCheckResult;

    expect(result).toMatchObject({ pong: true });
    expect(typeof result.workerHostname).toBe('string');
    expect(result.workerHostname.length).toBeGreaterThan(0);
  });
});
