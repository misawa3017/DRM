import axios from 'axios';
import FormData from 'form-data';
import { randomUUID } from 'crypto';
import { resolve } from 'path';
import { config } from 'dotenv';
import { S3Client } from '@aws-sdk/client-s3';
import { PDFDocument } from 'pdf-lib';
import { PrismaClient } from '@prisma/client';
import { cleanupTestFolders } from './e2e-cleanup';

config({ path: resolve(__dirname, '../../../.env') });

const KEYCLOAK_TOKEN_URL = 'https://auth.drm.apower.lan/realms/drm/protocol/openid-connect/token';
const API_BASE_URL = 'https://api.drm.apower.lan';

interface TokenResponse {
  access_token: string;
}

interface FolderResponse {
  id: string;
}

interface DocumentResponse {
  id: string;
  status: 'active' | 'expired';
  currentVersion: { id: string; objectKey: string };
}

describe('浮水印與到期控制 (e2e)', () => {
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
  let token: string;

  beforeAll(async () => {
    const tokenResponse = await axios.post<TokenResponse>(
      KEYCLOAK_TOKEN_URL,
      new URLSearchParams({
        grant_type: 'password',
        client_id: 'drm-web',
        username: 'testadmin',
        password: 'testadminpass',
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
    );
    token = tokenResponse.data.access_token;
    const folder = await axios.post<FolderResponse>(
      `${API_BASE_URL}/folders`,
      { name: `watermark-e2e-${randomUUID()}` },
      { headers: { Authorization: `Bearer ${token}` } },
    );
    folderId = folder.data.id;
  });

  afterAll(async () => {
    if (folderId) await cleanupTestFolders(prisma, storage, [folderId]);
    await prisma.$disconnect();
    storage.destroy();
  });

  it('預設下載 PDF 時加入浮水印，關閉後回傳原始位元組', async () => {
    const pdf = await PDFDocument.create();
    pdf.addPage([400, 600]);
    const original = Buffer.from(await pdf.save());
    const form = new FormData();
    form.append('folderId', folderId);
    form.append('name', 'watermark.pdf');
    form.append('file', original, { filename: 'watermark.pdf', contentType: 'application/pdf' });

    const created = await axios.post<DocumentResponse>(`${API_BASE_URL}/documents`, form, {
      headers: { Authorization: `Bearer ${token}`, ...form.getHeaders() },
    });

    const protectedDownload = await axios.get<ArrayBuffer>(
      `${API_BASE_URL}/documents/${created.data.id}/download`,
      { headers: { Authorization: `Bearer ${token}` }, responseType: 'arraybuffer' },
    );
    const protectedBytes = Buffer.from(protectedDownload.data);
    expect(protectedBytes.equals(original)).toBe(false);
    await expect(PDFDocument.load(protectedBytes)).resolves.toBeDefined();

    await axios.patch(
      `${API_BASE_URL}/documents/${created.data.id}/watermark`,
      { watermarkEnabled: false },
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const originalDownload = await axios.get<ArrayBuffer>(
      `${API_BASE_URL}/documents/${created.data.id}/download`,
      { headers: { Authorization: `Bearer ${token}` }, responseType: 'arraybuffer' },
    );
    expect(Buffer.from(originalDownload.data).equals(original)).toBe(true);

    const customPolicy = await axios.patch<{ watermarkTemplate: string }>(
      `${API_BASE_URL}/documents/${created.data.id}/watermark`,
      {
        watermarkEnabled: true,
        watermarkTemplate: '機密｜{{email}}｜{{documentName}}',
      },
      { headers: { Authorization: `Bearer ${token}` } },
    );
    expect(customPolicy.data.watermarkTemplate).toBe('機密｜{{email}}｜{{documentName}}');

    const preview = await axios.get<ArrayBuffer>(
      `${API_BASE_URL}/documents/${created.data.id}/preview`,
      { headers: { Authorization: `Bearer ${token}` }, responseType: 'arraybuffer' },
    );
    expect(preview.headers['content-type']).toContain('application/pdf');
    await expect(PDFDocument.load(Buffer.from(preview.data))).resolves.toBeDefined();
  });

  it('已到期文件回傳 410，管理者延長後可重新啟用', async () => {
    const document = await prisma.document.findFirstOrThrow({ where: { folderId: folderId! } });
    await prisma.document.update({
      where: { id: document.id },
      data: { status: 'expired', expiresAt: new Date(Date.now() - 60_000) },
    });

    await expect(
      axios.get(`${API_BASE_URL}/documents/${document.id}/download`, {
        headers: { Authorization: `Bearer ${token}` },
      }),
    ).rejects.toMatchObject({ response: { status: 410 } });

    const reactivated = await axios.patch<DocumentResponse>(
      `${API_BASE_URL}/documents/${document.id}/expiration`,
      { expiresAt: null },
      { headers: { Authorization: `Bearer ${token}` } },
    );
    expect(reactivated.data.status).toBe('active');
  });

  it('啟用浮水印的 Office preview 尚未完成時回傳 425', async () => {
    const documentId = randomUUID();
    const versionId = randomUUID();
    await prisma.document.create({
      data: { id: documentId, folderId: folderId!, name: 'pending.docx', createdBy: 'seed' },
    });
    await prisma.documentVersion.create({
      data: {
        id: versionId,
        documentId,
        versionNumber: 1,
        objectKey: `${documentId}/${versionId}`,
        sha256: '0'.repeat(64),
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        sizeBytes: 1,
        uploadedBy: 'seed',
      },
    });
    await prisma.document.update({
      where: { id: documentId },
      data: { currentVersionId: versionId },
    });

    await expect(
      axios.get(`${API_BASE_URL}/documents/${documentId}/download`, {
        headers: { Authorization: `Bearer ${token}` },
      }),
    ).rejects.toMatchObject({ response: { status: 425 } });
  });
});
