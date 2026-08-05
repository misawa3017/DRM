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

interface DocumentResponse {
  id: string;
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
});
