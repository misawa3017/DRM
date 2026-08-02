import { Queue, QueueEvents } from 'bullmq';

const REDIS_CONNECTION = { host: '127.0.0.1', port: 6380 };

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

    const result = await job.waitUntilFinished(queueEvents, 15000);

    expect(result).toMatchObject({ pong: true });
    expect(typeof result.workerHostname).toBe('string');
    expect(result.workerHostname.length).toBeGreaterThan(0);
  });
});
