import axios from 'axios';

const KEYCLOAK_TOKEN_URL = 'http://auth.drm.apower.lan/realms/drm/protocol/openid-connect/token';
const API_BASE_URL = 'http://api.drm.apower.lan';

interface TokenResponse {
  access_token: string;
}

interface FolderResponse {
  id: string;
}

interface WhoamiResponse {
  id: string;
}

interface AuditLogResponse {
  action: string;
}

interface VerifyResponse {
  valid: boolean;
  brokenAtId?: string;
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

describe('Audit log read endpoints (e2e)', () => {
  it('requires manage access to read a folder audit log, and includes the folder_create entry', async () => {
    const adminToken = await getToken('testadmin', 'testadminpass');
    const adminHeader = { Authorization: `Bearer ${adminToken}` };

    const folderRes = await axios.post<FolderResponse>(
      `${API_BASE_URL}/folders`,
      { name: `audit-endpoint-test-${Date.now()}` },
      { headers: adminHeader },
    );
    const folderId = folderRes.data.id;

    const employeeToken = await getToken('testuser', 'testpass');
    const employeeUser = await whoami(employeeToken);

    await axios.post(
      `${API_BASE_URL}/folders/${folderId}/permissions`,
      { principalType: 'user', principalId: employeeUser.id, permissionLevel: 'view' },
      { headers: adminHeader },
    );

    await expect(
      axios.get(`${API_BASE_URL}/folders/${folderId}/audit-logs`, {
        headers: { Authorization: `Bearer ${employeeToken}` },
      }),
    ).rejects.toMatchObject({ response: { status: 403 } });

    const auditRes = await axios.get<AuditLogResponse[]>(`${API_BASE_URL}/folders/${folderId}/audit-logs`, {
      headers: adminHeader,
    });

    expect(auditRes.status).toBe(200);
    expect(auditRes.data.some((entry) => entry.action === 'folder_create')).toBe(true);
  });

  it('requires admin role to verify the audit chain', async () => {
    const adminToken = await getToken('testadmin', 'testadminpass');
    const employeeToken = await getToken('testuser', 'testpass');

    await expect(
      axios.get(`${API_BASE_URL}/audit-logs/verify`, {
        headers: { Authorization: `Bearer ${employeeToken}` },
      }),
    ).rejects.toMatchObject({ response: { status: 403 } });

    const verifyRes = await axios.get<VerifyResponse>(`${API_BASE_URL}/audit-logs/verify`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });

    expect(verifyRes.status).toBe(200);
    expect(verifyRes.data.valid).toBe(true);
  });
});
