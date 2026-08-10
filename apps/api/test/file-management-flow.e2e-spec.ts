import axios from 'axios';
import FormData from 'form-data';
import { DeleteObjectsCommand, S3Client } from '@aws-sdk/client-s3';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';
import { config } from 'dotenv';
import { resolve } from 'path';

config({ path: resolve(__dirname, '../../../.env') });

const KEYCLOAK_TOKEN_URL = 'https://auth.drm.apower.lan/realms/drm/protocol/openid-connect/token';
const API_BASE_URL = 'https://api.drm.apower.lan';

interface TokenResponse {
  access_token: string;
}

interface FolderResponse {
  id: string;
  name: string;
  documents?: Array<{
    id: string;
    uploader: { displayName: string; email: string } | null;
  }>;
}

interface DocumentVersionResponse {
  id: string;
  versionNumber: number;
  uploader?: {
    id: string;
    displayName: string;
    email: string;
  } | null;
}

interface DocumentResponse {
  id: string;
  name: string;
  currentVersion: DocumentVersionResponse;
}

async function getToken(username: string, password: string): Promise<string> {
  const response = await axios.post<TokenResponse>(
    KEYCLOAK_TOKEN_URL,
    new URLSearchParams({ grant_type: 'password', client_id: 'drm-web', username, password }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
  );
  return response.data.access_token;
}

describe('File management full flow (e2e)', () => {
  const prisma = new PrismaClient({
    datasources: { db: { url: 'postgresql://drm:drm_dev_password@localhost:5433/drm' } },
  });
  const storage = new S3Client({
    endpoint: 'http://127.0.0.1:9000',
    region: 'us-east-1',
    forcePathStyle: true,
    credentials: {
      accessKeyId: process.env.MINIO_API_ACCESS_KEY ?? '',
      secretAccessKey: process.env.MINIO_API_SECRET_KEY ?? '',
    },
  });
  let folderId: string | undefined;

  afterAll(async () => {
    if (folderId) {
      const documents = await prisma.document.findMany({
        where: { folderId },
        include: { versions: true },
      });
      const documentIds = documents.map((document) => document.id);
      const objectKeys = documents.flatMap((document) =>
        document.versions.flatMap((version) =>
          version.previewObjectKey
            ? [version.objectKey, version.previewObjectKey]
            : [version.objectKey],
        ),
      );
      await prisma.$transaction([
        prisma.permission.deleteMany({
          where: {
            OR: [
              { resourceType: 'folder', resourceId: folderId },
              { resourceType: 'document', resourceId: { in: documentIds } },
            ],
          },
        }),
        prisma.document.updateMany({
          where: { id: { in: documentIds } },
          data: { currentVersionId: null },
        }),
        prisma.documentVersion.deleteMany({ where: { documentId: { in: documentIds } } }),
        prisma.document.deleteMany({ where: { id: { in: documentIds } } }),
        prisma.folder.delete({ where: { id: folderId } }),
      ]);
      if (objectKeys.length > 0) {
        await storage.send(
          new DeleteObjectsCommand({
            Bucket: 'documents',
            Delete: { Objects: objectKeys.map((Key) => ({ Key })) },
          }),
        );
      }
    }
    await prisma.$disconnect();
    storage.destroy();
  });

  it('an admin can list root folders, create a folder, upload a document, view it, and download the exact bytes back', async () => {
    const token = await getToken('testadmin', 'testadminpass');
    const authHeader = { Authorization: `Bearer ${token}` };

    const folderRes = await axios.post<FolderResponse>(
      `${API_BASE_URL}/folders`,
      { name: `flow-test-${randomUUID()}` },
      { headers: authHeader },
    );
    folderId = folderRes.data.id;

    const rootRes = await axios.get<FolderResponse[]>(`${API_BASE_URL}/folders`, {
      headers: authHeader,
    });
    expect(rootRes.data.map((f) => f.id)).toContain(folderId);

    const content = `flow test content ${Date.now()}`;
    const form = new FormData();
    form.append('folderId', folderId);
    form.append('name', 'flow-test.txt');
    form.append('file', Buffer.from(content), { filename: 'flow-test.txt' });

    const createRes = await axios.post<DocumentResponse>(`${API_BASE_URL}/documents`, form, {
      headers: { ...authHeader, ...form.getHeaders() },
    });
    expect(createRes.status).toBe(201);
    const documentId = createRes.data.id;

    const folderContents = await axios.get<FolderResponse>(
      `${API_BASE_URL}/folders/${folderId}`,
      { headers: authHeader },
    );
    expect(folderContents.data.documents?.[0].uploader?.displayName.length).toBeGreaterThan(0);
    expect(folderContents.data.documents?.[0].uploader?.email).toContain('@');

    const metadataRes = await axios.get<DocumentResponse>(`${API_BASE_URL}/documents/${documentId}`, {
      headers: authHeader,
    });
    expect(metadataRes.data.name).toBe('flow-test.txt');

    const versionsRes = await axios.get<DocumentVersionResponse[]>(
      `${API_BASE_URL}/documents/${documentId}/versions`,
      { headers: authHeader },
    );
    expect(versionsRes.data).toHaveLength(1);
    expect(versionsRes.data[0].uploader?.displayName.length).toBeGreaterThan(0);
    expect(versionsRes.data[0].uploader?.email).toContain('@');

    const downloadRes = await axios.get<string>(`${API_BASE_URL}/documents/${documentId}/download`, {
      headers: authHeader,
      responseType: 'text',
    });
    expect(downloadRes.data).toBe(content);
  });
});
