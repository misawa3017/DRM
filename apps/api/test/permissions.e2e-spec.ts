import axios from 'axios';

const KEYCLOAK_TOKEN_URL = 'http://auth.drm.localhost/realms/drm/protocol/openid-connect/token';
const API_BASE_URL = 'http://api.drm.localhost';

interface TokenResponse {
  access_token: string;
}

interface FolderResponse {
  id: string;
}

interface WhoamiResponse {
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

async function whoami(token: string): Promise<WhoamiResponse> {
  const res = await axios.get<WhoamiResponse>(`${API_BASE_URL}/whoami`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return res.data;
}

describe('Permissions (e2e)', () => {
  it('grants view access to another user, who can then see the folder but not manage it', async () => {
    const adminToken = await getToken('testadmin', 'testadminpass');
    const adminHeader = { Authorization: `Bearer ${adminToken}` };

    const folderRes = await axios.post<FolderResponse>(
      `${API_BASE_URL}/folders`,
      { name: `perm-test-${Date.now()}` },
      { headers: adminHeader },
    );
    const folderId = folderRes.data.id;

    const employeeToken = await getToken('testuser', 'testpass');
    const employeeUser = await whoami(employeeToken);

    await expect(
      axios.get(`${API_BASE_URL}/folders/${folderId}`, {
        headers: { Authorization: `Bearer ${employeeToken}` },
      }),
    ).rejects.toMatchObject({ response: { status: 403 } });

    await axios.post(
      `${API_BASE_URL}/folders/${folderId}/permissions`,
      { principalType: 'user', principalId: employeeUser.id, permissionLevel: 'view' },
      { headers: adminHeader },
    );

    const viewRes = await axios.get(`${API_BASE_URL}/folders/${folderId}`, {
      headers: { Authorization: `Bearer ${employeeToken}` },
    });
    expect(viewRes.status).toBe(200);

    await expect(
      axios.post(
        `${API_BASE_URL}/folders/${folderId}/permissions`,
        { principalType: 'user', principalId: employeeUser.id, permissionLevel: 'manage' },
        { headers: { Authorization: `Bearer ${employeeToken}` } },
      ),
    ).rejects.toMatchObject({ response: { status: 403 } });
  });

  it('rejects granting a group-type principal with 400', async () => {
    const adminToken = await getToken('testadmin', 'testadminpass');
    const folderRes = await axios.post<FolderResponse>(
      `${API_BASE_URL}/folders`,
      { name: `perm-group-test-${Date.now()}` },
      { headers: { Authorization: `Bearer ${adminToken}` } },
    );

    await expect(
      axios.post(
        `${API_BASE_URL}/folders/${folderRes.data.id}/permissions`,
        { principalType: 'group', principalId: 'some-group', permissionLevel: 'view' },
        { headers: { Authorization: `Bearer ${adminToken}` } },
      ),
    ).rejects.toMatchObject({ response: { status: 400 } });
  });
});
