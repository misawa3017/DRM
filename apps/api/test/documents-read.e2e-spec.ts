import axios from 'axios';
import FormData from 'form-data';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';

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
  canManage?: boolean;
  canEdit?: boolean;
}

async function getToken(username: string, password: string): Promise<string> {
  const response = await axios.post<TokenResponse>(
    KEYCLOAK_TOKEN_URL,
    new URLSearchParams({ grant_type: 'password', client_id: 'drm-web', username, password }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
  );
  return response.data.access_token;
}

describe('Documents read path (e2e)', () => {
  const prisma = new PrismaClient({
    datasources: { db: { url: 'postgresql://drm:drm_dev_password@localhost:5433/drm' } },
  });

  let testUserId: string;

  beforeAll(async () => {
    const token = await getToken('testuser', 'testpass');
    const res = await axios.get<{ id: string }>(`${API_BASE_URL}/whoami`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    testUserId = res.data.id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('GET /documents/:id reports canManage=false for a caller who only has download access', async () => {
    const folder = await prisma.folder.create({
      data: { name: `doc-canmanage-${randomUUID()}`, parentId: null, createdBy: 'seed' },
    });
    const document = await prisma.document.create({
      data: { name: 'readme.txt', folderId: folder.id, createdBy: 'seed' },
    });
    await prisma.permission.create({
      data: {
        resourceType: 'document',
        resourceId: document.id,
        principalType: 'user',
        principalId: testUserId,
        permissionLevel: 'download',
        grantedBy: 'seed',
      },
    });

    const token = await getToken('testuser', 'testpass');
    const res = await axios.get<DocumentResponse>(`${API_BASE_URL}/documents/${document.id}`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.data.canManage).toBe(false);
  });

  it('GET /documents/:id reports canManage=true for a caller with manage access', async () => {
    const folder = await prisma.folder.create({
      data: { name: `doc-canmanage-${randomUUID()}`, parentId: null, createdBy: 'seed' },
    });
    const document = await prisma.document.create({
      data: { name: 'readme.txt', folderId: folder.id, createdBy: 'seed' },
    });
    await prisma.permission.create({
      data: {
        resourceType: 'document',
        resourceId: document.id,
        principalType: 'user',
        principalId: testUserId,
        permissionLevel: 'manage',
        grantedBy: 'seed',
      },
    });

    const token = await getToken('testuser', 'testpass');
    const res = await axios.get<DocumentResponse>(`${API_BASE_URL}/documents/${document.id}`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.data.canManage).toBe(true);
  });

  it('GET /documents/:id reports canEdit=false for a caller who only has download access', async () => {
    const folder = await prisma.folder.create({
      data: { name: `doc-canedit-${randomUUID()}`, parentId: null, createdBy: 'seed' },
    });
    const document = await prisma.document.create({
      data: { name: 'readme.txt', folderId: folder.id, createdBy: 'seed' },
    });
    await prisma.permission.create({
      data: {
        resourceType: 'document',
        resourceId: document.id,
        principalType: 'user',
        principalId: testUserId,
        permissionLevel: 'download',
        grantedBy: 'seed',
      },
    });

    const token = await getToken('testuser', 'testpass');
    const res = await axios.get<DocumentResponse>(`${API_BASE_URL}/documents/${document.id}`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.data.canEdit).toBe(false);
  });

  it('GET /documents/:id reports canEdit=true for a caller with edit access', async () => {
    const folder = await prisma.folder.create({
      data: { name: `doc-canedit-${randomUUID()}`, parentId: null, createdBy: 'seed' },
    });
    const document = await prisma.document.create({
      data: { name: 'readme.txt', folderId: folder.id, createdBy: 'seed' },
    });
    await prisma.permission.create({
      data: {
        resourceType: 'document',
        resourceId: document.id,
        principalType: 'user',
        principalId: testUserId,
        permissionLevel: 'edit',
        grantedBy: 'seed',
      },
    });

    const token = await getToken('testuser', 'testpass');
    const res = await axios.get<DocumentResponse>(`${API_BASE_URL}/documents/${document.id}`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.data.canEdit).toBe(true);
  });

  it('downloads the current version content correctly, and is blocked without a grant', async () => {
    const adminToken = await getToken('testadmin', 'testadminpass');
    const adminHeader = { Authorization: `Bearer ${adminToken}` };

    const folderRes = await axios.post<FolderResponse>(
      `${API_BASE_URL}/folders`,
      { name: `read-test-${Date.now()}` },
      { headers: adminHeader },
    );

    const content = `download check ${Date.now()}`;
    const form = new FormData();
    form.append('folderId', folderRes.data.id);
    form.append('name', 'readme.txt');
    form.append('file', Buffer.from(content), { filename: 'readme.txt' });
    const createRes = await axios.post<DocumentResponse>(`${API_BASE_URL}/documents`, form, {
      headers: { ...adminHeader, ...form.getHeaders() },
    });
    const documentId = createRes.data.id;

    const downloadRes = await axios.get<string>(`${API_BASE_URL}/documents/${documentId}/download`, {
      headers: adminHeader,
      responseType: 'text',
    });
    expect(downloadRes.data).toBe(content);

    const employeeToken = await getToken('testuser', 'testpass');
    await expect(
      axios.get(`${API_BASE_URL}/documents/${documentId}/download`, {
        headers: { Authorization: `Bearer ${employeeToken}` },
      }),
    ).rejects.toMatchObject({ response: { status: 403 } });
  });

  it('GET /documents/:id, listVersions, and download all treat a soft-deleted document as not found', async () => {
    const folder = await prisma.folder.create({
      data: { name: `deleted-doc-folder-${randomUUID()}`, parentId: null, createdBy: 'seed' },
    });
    const document = await prisma.document.create({
      data: {
        name: 'will-be-deleted.txt',
        folderId: folder.id,
        createdBy: 'seed',
        deletedAt: new Date(),
      },
    });
    await prisma.permission.create({
      data: {
        resourceType: 'document',
        resourceId: document.id,
        principalType: 'user',
        principalId: testUserId,
        permissionLevel: 'manage',
        grantedBy: 'seed',
      },
    });

    const token = await getToken('testuser', 'testpass');
    const headers = { Authorization: `Bearer ${token}` };

    await expect(
      axios.get(`${API_BASE_URL}/documents/${document.id}`, { headers }),
    ).rejects.toMatchObject({ response: { status: 404 } });
    await expect(
      axios.get(`${API_BASE_URL}/documents/${document.id}/versions`, { headers }),
    ).rejects.toMatchObject({ response: { status: 404 } });
    await expect(
      axios.get(`${API_BASE_URL}/documents/${document.id}/download`, { headers }),
    ).rejects.toMatchObject({ response: { status: 404 } });
  });

  it('a soft-deleted document does not appear in its (non-deleted) folder listing', async () => {
    const folder = await prisma.folder.create({
      data: { name: `deleted-doc-listing-${randomUUID()}`, parentId: null, createdBy: 'seed' },
    });
    const document = await prisma.document.create({
      data: {
        name: 'hidden.txt',
        folderId: folder.id,
        createdBy: 'seed',
        deletedAt: new Date(),
      },
    });
    void document;
    await prisma.permission.create({
      data: {
        resourceType: 'folder',
        resourceId: folder.id,
        principalType: 'user',
        principalId: testUserId,
        permissionLevel: 'view',
        grantedBy: 'seed',
      },
    });

    const token = await getToken('testuser', 'testpass');
    const res = await axios.get<{ documents: { id: string }[] }>(
      `${API_BASE_URL}/folders/${folder.id}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    expect(res.data.documents.map((d) => d.id)).not.toContain(document.id);
  });
});
