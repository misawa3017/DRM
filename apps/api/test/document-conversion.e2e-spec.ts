import { config } from 'dotenv';
import * as path from 'path';

// Plain 'dotenv/config' resolves .env relative to process.cwd(), which is
// apps/api when this suite runs via `pnpm test:e2e` from that directory --
// but the project's .env lives at the repo root, two levels up. Point
// dotenv at it explicitly, same as apps/api/test/storage.e2e-spec.ts.
config({ path: path.resolve(__dirname, '../../../.env') });

process.env.MINIO_ENDPOINT = 'http://127.0.0.1:9000';
// .env holds the credential under its provisioning name (MINIO_API_*, see
// docker-compose.yml's api service: MINIO_ACCESS_KEY: ${MINIO_API_ACCESS_KEY}).
// StorageService reads MINIO_ACCESS_KEY/MINIO_SECRET_KEY (the names it's
// wired with inside the container), so map them here for this host-run test.
process.env.MINIO_ACCESS_KEY = process.env.MINIO_API_ACCESS_KEY;
process.env.MINIO_SECRET_KEY = process.env.MINIO_API_SECRET_KEY;

import axios from 'axios';
import FormData from 'form-data';
import { PrismaClient } from '@prisma/client';
import { StorageService } from '../src/storage/storage.service';

const KEYCLOAK_TOKEN_URL = 'http://auth.drm.localhost/realms/drm/protocol/openid-connect/token';
const API_BASE_URL = 'http://api.drm.localhost';

interface TokenResponse {
  access_token: string;
}
interface FolderResponse {
  id: string;
}
interface DocumentResponse {
  id: string;
  currentVersion: { id: string; objectKey: string };
}

async function getToken(username: string, password: string): Promise<string> {
  const response = await axios.post<TokenResponse>(
    KEYCLOAK_TOKEN_URL,
    new URLSearchParams({ grant_type: 'password', client_id: 'drm-web', username, password }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
  );
  return response.data.access_token;
}

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

describe('Document conversion pipeline (e2e)', () => {
  const prisma = new PrismaClient({
    datasources: { db: { url: 'postgresql://drm:drm_dev_password@localhost:5433/drm' } },
  });
  const storage = new StorageService();

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('enqueues and completes a conversion for an Office-mimetype upload, populating previewObjectKey with a real PDF', async () => {
    const adminToken = await getToken('testadmin', 'testadminpass');
    const authHeader = { Authorization: `Bearer ${adminToken}` };

    const folderRes = await axios.post<FolderResponse>(
      `${API_BASE_URL}/folders`,
      { name: `conversion-test-${Date.now()}` },
      { headers: authHeader },
    );

    const form = new FormData();
    form.append('folderId', folderRes.data.id);
    form.append('name', 'test.docx');
    form.append(
      'file',
      Buffer.from('plain text content, declared as a Word document for this test'),
      {
        filename: 'test.docx',
        contentType:
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      },
    );

    const createRes = await axios.post<DocumentResponse>(`${API_BASE_URL}/documents`, form, {
      headers: { ...authHeader, ...form.getHeaders() },
    });
    const versionId = createRes.data.currentVersion.id;

    let previewObjectKey: string | null = null;
    for (let i = 0; i < 30; i++) {
      const version = await prisma.documentVersion.findUniqueOrThrow({ where: { id: versionId } });
      if (version.previewObjectKey) {
        previewObjectKey = version.previewObjectKey;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    expect(previewObjectKey).not.toBeNull();

    // Beyond the DB column: fetch the actual object the worker wrote to
    // MinIO and confirm it's a genuine PDF (magic bytes), the same style of
    // proof Phase 4A's scripts/verify-gotenberg.sh uses for the Gotenberg
    // service directly. This is what actually proves the full real
    // pipeline (enqueue -> worker pickup -> MinIO fetch -> Gotenberg
    // conversion -> MinIO store -> QueueEvents completion -> Prisma update)
    // ran end-to-end, not merely that some string landed in a column.
    const previewStream = await storage.getObjectStream(previewObjectKey as string);
    const previewBuffer = await streamToBuffer(previewStream as NodeJS.ReadableStream);
    expect(previewBuffer.subarray(0, 4).toString('ascii')).toBe('%PDF');
    expect(previewBuffer.length).toBeGreaterThan(0);
  }, 40000);

  it('does not enqueue a conversion for a non-Office upload', async () => {
    const adminToken = await getToken('testadmin', 'testadminpass');
    const authHeader = { Authorization: `Bearer ${adminToken}` };

    const folderRes = await axios.post<FolderResponse>(
      `${API_BASE_URL}/folders`,
      { name: `no-conversion-test-${Date.now()}` },
      { headers: authHeader },
    );

    const form = new FormData();
    form.append('folderId', folderRes.data.id);
    form.append('name', 'plain.txt');
    form.append('file', Buffer.from('just a plain text file'), {
      filename: 'plain.txt',
      contentType: 'text/plain',
    });

    const createRes = await axios.post<DocumentResponse>(`${API_BASE_URL}/documents`, form, {
      headers: { ...authHeader, ...form.getHeaders() },
    });
    const versionId = createRes.data.currentVersion.id;

    await new Promise((resolve) => setTimeout(resolve, 3000));
    const version = await prisma.documentVersion.findUniqueOrThrow({ where: { id: versionId } });
    expect(version.previewObjectKey).toBeNull();
  }, 15000);
});
