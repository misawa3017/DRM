import { config } from 'dotenv';
import * as path from 'path';

// Plain 'dotenv/config' resolves .env relative to process.cwd(), which is
// apps/api when this suite runs via `pnpm test:e2e` from that directory --
// but the project's .env lives at the repo root, two levels up. Point
// dotenv at it explicitly rather than relying on cwd.
config({ path: path.resolve(__dirname, '../../../.env') });

process.env.MINIO_ENDPOINT = 'http://127.0.0.1:9000';
// .env holds the credential under its provisioning name (MINIO_API_*, see
// docker-compose.yml's api service: MINIO_ACCESS_KEY: ${MINIO_API_ACCESS_KEY}).
// StorageService reads MINIO_ACCESS_KEY/MINIO_SECRET_KEY (the names it's
// wired with inside the container), so map them here for this host-run test.
process.env.MINIO_ACCESS_KEY = process.env.MINIO_API_ACCESS_KEY;
process.env.MINIO_SECRET_KEY = process.env.MINIO_API_SECRET_KEY;

import { StorageService } from '../src/storage/storage.service';
import { randomUUID } from 'crypto';

describe('StorageService (e2e, live MinIO)', () => {
  let storage: StorageService;

  beforeAll(() => {
    storage = new StorageService();
  });

  it('round-trips an object through real SSE-KMS encrypted storage', async () => {
    const key = `${randomUUID()}/verify-storage-service.txt`;
    const content = Buffer.from(`storage service e2e check ${new Date().toISOString()}`);

    await storage.putObject(key, content, 'text/plain');

    const stream = await storage.getObjectStream(key);
    const chunks: Buffer[] = [];
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      chunks.push(Buffer.from(chunk));
    }
    const downloaded = Buffer.concat(chunks);

    expect(downloaded.equals(content)).toBe(true);
  });

  it('rejects a get for a key that does not exist', async () => {
    await expect(storage.getObjectStream(`${randomUUID()}/does-not-exist.txt`)).rejects.toThrow();
  });
});
