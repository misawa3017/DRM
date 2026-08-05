import axios from 'axios';
import FormData from 'form-data';
import { PrismaClient } from '@prisma/client';

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
  currentVersion: { id: string };
}

interface DocumentVersionResponse {
  id: string;
  versionNumber: number;
}

async function getToken(username: string, password: string): Promise<string> {
  const response = await axios.post<TokenResponse>(
    KEYCLOAK_TOKEN_URL,
    new URLSearchParams({ grant_type: 'password', client_id: 'drm-web', username, password }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
  );
  return response.data.access_token;
}

describe('Document audit logging (e2e)', () => {
  const prisma = new PrismaClient({
    datasources: { db: { url: 'postgresql://drm:drm_dev_password@localhost:5433/drm' } },
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('records document_create, document_view, document_download, and document_version_upload in a valid hash chain', async () => {
    const adminToken = await getToken('testadmin', 'testadminpass');
    const authHeader = { Authorization: `Bearer ${adminToken}` };

    const folderRes = await axios.post<FolderResponse>(
      `${API_BASE_URL}/folders`,
      { name: `audit-doc-test-${Date.now()}` },
      { headers: authHeader },
    );
    const folderId = folderRes.data.id;

    const form1 = new FormData();
    form1.append('folderId', folderId);
    form1.append('name', 'audit-doc.txt');
    form1.append('file', Buffer.from('version one content'), { filename: 'v1.txt' });
    const createRes = await axios.post<DocumentResponse>(`${API_BASE_URL}/documents`, form1, {
      headers: { ...authHeader, ...form1.getHeaders() },
    });
    const documentId = createRes.data.id;

    const metadataRes = await axios.get<DocumentResponse>(`${API_BASE_URL}/documents/${documentId}`, {
      headers: authHeader,
    });
    const firstVersionId = metadataRes.data.currentVersion.id;

    await axios.get(`${API_BASE_URL}/documents/${documentId}/download`, {
      headers: authHeader,
      responseType: 'text',
    });

    const form2 = new FormData();
    form2.append('file', Buffer.from('version two content'), { filename: 'v2.txt' });
    await axios.post<DocumentVersionResponse>(`${API_BASE_URL}/documents/${documentId}/versions`, form2, {
      headers: { ...authHeader, ...form2.getHeaders() },
    });

    const entries = await prisma.auditLog.findMany({
      where: { resourceType: 'document', resourceId: documentId },
      orderBy: { sequence: 'asc' },
    });

    expect(entries).toHaveLength(4);
    expect(entries[0].action).toBe('document_create');
    expect(entries[1].action).toBe('document_view');
    expect(entries[2].action).toBe('document_download');
    expect(entries[3].action).toBe('document_version_upload');

    expect(entries[1].prevHash).toBe(entries[0].hash);
    expect(entries[2].prevHash).toBe(entries[1].hash);
    expect(entries[3].prevHash).toBe(entries[2].hash);

    for (const entry of entries) {
      expect(entry.ipAddress).not.toBeNull();
    }

    // Fix 4: document_download must record which version was downloaded
    // (the resolved version's actual id — here it's the default/current
    // version at the time of download, since no versionId query param was
    // passed).
    expect(entries[2].details).toMatchObject({ versionId: firstVersionId });
  });
});
