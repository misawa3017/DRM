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

interface DocumentVersionResponse {
  id: string;
  versionNumber: number;
}

interface DocumentResponse {
  id: string;
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

describe('Documents write path (e2e)', () => {
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

  it('a user with edit access can upload a document and a new version', async () => {
    const token = await getToken('testadmin', 'testadminpass');
    const authHeader = { Authorization: `Bearer ${token}` };

    const folderRes = await axios.post<FolderResponse>(
      `${API_BASE_URL}/folders`,
      { name: `test-folder-${Date.now()}` },
      { headers: authHeader },
    );
    const folderId = folderRes.data.id;

    const form1 = new FormData();
    form1.append('folderId', folderId);
    form1.append('name', 'test-doc.txt');
    form1.append('file', Buffer.from('version one content'), { filename: 'v1.txt' });

    const createRes = await axios.post<DocumentResponse>(`${API_BASE_URL}/documents`, form1, {
      headers: { ...authHeader, ...form1.getHeaders() },
    });
    expect(createRes.status).toBe(201);
    expect(createRes.data.currentVersion.versionNumber).toBe(1);
    const documentId = createRes.data.id;

    const form2 = new FormData();
    form2.append('file', Buffer.from('version two content'), { filename: 'v2.txt' });

    const versionRes = await axios.post<DocumentVersionResponse>(
      `${API_BASE_URL}/documents/${documentId}/versions`,
      form2,
      { headers: { ...authHeader, ...form2.getHeaders() } },
    );
    expect(versionRes.status).toBe(201);
    expect(versionRes.data.versionNumber).toBe(2);

    const listRes = await axios.get<DocumentVersionResponse[]>(
      `${API_BASE_URL}/documents/${documentId}/versions`,
      { headers: authHeader },
    );
    expect(listRes.data).toHaveLength(2);
    expect(listRes.data[0].versionNumber).toBe(2);
  });

  it('a user with no grant cannot upload into a folder they cannot edit', async () => {
    const adminToken = await getToken('testadmin', 'testadminpass');
    const folderRes = await axios.post<FolderResponse>(
      `${API_BASE_URL}/folders`,
      { name: `locked-folder-${Date.now()}` },
      { headers: { Authorization: `Bearer ${adminToken}` } },
    );

    const employeeToken = await getToken('testuser', 'testpass');
    const form = new FormData();
    form.append('folderId', folderRes.data.id);
    form.append('name', 'nope.txt');
    form.append('file', Buffer.from('should not be allowed'), { filename: 'nope.txt' });

    await expect(
      axios.post(`${API_BASE_URL}/documents`, form, {
        headers: { Authorization: `Bearer ${employeeToken}`, ...form.getHeaders() },
      }),
    ).rejects.toMatchObject({ response: { status: 403 } });
  });

  it('POST /documents rejects a name that collides with an existing, non-deleted sibling in the same folder', async () => {
    const adminToken = await getToken('testadmin', 'testadminpass');
    const folderRes = await axios.post<{ id: string }>(
      `${API_BASE_URL}/folders`,
      { name: `doc-conflict-${Date.now()}` },
      { headers: { Authorization: `Bearer ${adminToken}` } },
    );
    const folderId = folderRes.data.id;

    const form1 = new FormData();
    form1.append('folderId', folderId);
    form1.append('name', 'dup.txt');
    form1.append('file', Buffer.from('one'), { filename: 'dup.txt' });
    await axios.post(`${API_BASE_URL}/documents`, form1, {
      headers: { Authorization: `Bearer ${adminToken}`, ...form1.getHeaders() },
    });

    const form2 = new FormData();
    form2.append('folderId', folderId);
    form2.append('name', 'dup.txt');
    form2.append('file', Buffer.from('two'), { filename: 'dup.txt' });
    await expect(
      axios.post(`${API_BASE_URL}/documents`, form2, {
        headers: { Authorization: `Bearer ${adminToken}`, ...form2.getHeaders() },
      }),
    ).rejects.toMatchObject({ response: { status: 409 } });
  });

  it('PATCH /documents/:id renames a document the caller has edit access to, and records document_rename', async () => {
    const adminToken = await getToken('testadmin', 'testadminpass');
    const folderRes = await axios.post<{ id: string }>(
      `${API_BASE_URL}/folders`,
      { name: `doc-rename-${Date.now()}` },
      { headers: { Authorization: `Bearer ${adminToken}` } },
    );
    const form = new FormData();
    form.append('folderId', folderRes.data.id);
    form.append('name', 'old.txt');
    form.append('file', Buffer.from('content'), { filename: 'old.txt' });
    const createRes = await axios.post<{ id: string }>(`${API_BASE_URL}/documents`, form, {
      headers: { Authorization: `Bearer ${adminToken}`, ...form.getHeaders() },
    });

    const res = await axios.patch<{ name: string }>(
      `${API_BASE_URL}/documents/${createRes.data.id}`,
      { name: 'new.txt' },
      { headers: { Authorization: `Bearer ${adminToken}` } },
    );
    expect(res.data.name).toBe('new.txt');
  });

  it('PATCH /documents/:id moves a document when the caller has edit on both the document and destination folder', async () => {
    const adminToken = await getToken('testadmin', 'testadminpass');
    const sourceFolderRes = await axios.post<{ id: string }>(
      `${API_BASE_URL}/folders`,
      { name: `doc-move-source-${Date.now()}` },
      { headers: { Authorization: `Bearer ${adminToken}` } },
    );
    const destinationFolderRes = await axios.post<{ id: string }>(
      `${API_BASE_URL}/folders`,
      { name: `doc-move-destination-${Date.now()}` },
      { headers: { Authorization: `Bearer ${adminToken}` } },
    );
    const form = new FormData();
    form.append('folderId', sourceFolderRes.data.id);
    form.append('name', 'movable.txt');
    form.append('file', Buffer.from('content'), { filename: 'movable.txt' });
    const createRes = await axios.post<{ id: string }>(`${API_BASE_URL}/documents`, form, {
      headers: { Authorization: `Bearer ${adminToken}`, ...form.getHeaders() },
    });

    const res = await axios.patch<{ folderId: string }>(
      `${API_BASE_URL}/documents/${createRes.data.id}`,
      { folderId: destinationFolderRes.data.id },
      { headers: { Authorization: `Bearer ${adminToken}` } },
    );
    expect(res.data.folderId).toBe(destinationFolderRes.data.id);
  });

  it('PATCH /documents/:id rejects moving without edit access to the destination folder', async () => {
    const adminToken = await getToken('testadmin', 'testadminpass');
    const employeeToken = await getToken('testuser', 'testpass');
    const sourceFolderRes = await axios.post<{ id: string }>(
      `${API_BASE_URL}/folders`,
      { name: `doc-move-noedit-source-${Date.now()}` },
      { headers: { Authorization: `Bearer ${adminToken}` } },
    );
    const destinationFolderRes = await axios.post<{ id: string }>(
      `${API_BASE_URL}/folders`,
      { name: `doc-move-noedit-destination-${Date.now()}` },
      { headers: { Authorization: `Bearer ${adminToken}` } },
    );
    const form = new FormData();
    form.append('folderId', sourceFolderRes.data.id);
    form.append('name', 'movable2.txt');
    form.append('file', Buffer.from('content'), { filename: 'movable2.txt' });
    const createRes = await axios.post<{ id: string }>(`${API_BASE_URL}/documents`, form, {
      headers: { Authorization: `Bearer ${adminToken}`, ...form.getHeaders() },
    });

    const whoamiRes = await axios.get<{ id: string }>(`${API_BASE_URL}/whoami`, {
      headers: { Authorization: `Bearer ${employeeToken}` },
    });
    await axios.post(
      `${API_BASE_URL}/documents/${createRes.data.id}/permissions`,
      { principalType: 'user', principalId: whoamiRes.data.id, permissionLevel: 'edit' },
      { headers: { Authorization: `Bearer ${adminToken}` } },
    );

    await expect(
      axios.patch(
        `${API_BASE_URL}/documents/${createRes.data.id}`,
        { folderId: destinationFolderRes.data.id },
        { headers: { Authorization: `Bearer ${employeeToken}` } },
      ),
    ).rejects.toMatchObject({ response: { status: 403 } });
  });
});
