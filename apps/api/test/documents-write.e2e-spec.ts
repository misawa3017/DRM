import axios from 'axios';
import FormData from 'form-data';

const KEYCLOAK_TOKEN_URL = 'http://auth.drm.apower.lan/realms/drm/protocol/openid-connect/token';
const API_BASE_URL = 'http://api.drm.apower.lan';

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
});
