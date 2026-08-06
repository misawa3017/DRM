import axios from 'axios';
import FormData from 'form-data';

const KEYCLOAK_TOKEN_URL = 'https://auth.drm.apower.lan/realms/drm/protocol/openid-connect/token';
const API_BASE_URL = 'https://api.drm.apower.lan';

interface TokenResponse {
  access_token: string;
}

interface FolderResponse {
  id: string;
  name: string;
}

interface DocumentVersionResponse {
  id: string;
  versionNumber: number;
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
  it('an admin can list root folders, create a folder, upload a document, view it, and download the exact bytes back', async () => {
    const token = await getToken('testadmin', 'testadminpass');
    const authHeader = { Authorization: `Bearer ${token}` };

    const folderRes = await axios.post<FolderResponse>(
      `${API_BASE_URL}/folders`,
      { name: `flow-test-${Date.now()}` },
      { headers: authHeader },
    );
    const folderId = folderRes.data.id;

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

    const metadataRes = await axios.get<DocumentResponse>(`${API_BASE_URL}/documents/${documentId}`, {
      headers: authHeader,
    });
    expect(metadataRes.data.name).toBe('flow-test.txt');

    const versionsRes = await axios.get<DocumentVersionResponse[]>(
      `${API_BASE_URL}/documents/${documentId}/versions`,
      { headers: authHeader },
    );
    expect(versionsRes.data).toHaveLength(1);

    const downloadRes = await axios.get<string>(`${API_BASE_URL}/documents/${documentId}/download`, {
      headers: authHeader,
      responseType: 'text',
    });
    expect(downloadRes.data).toBe(content);
  });
});
