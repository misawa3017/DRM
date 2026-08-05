import axios from 'axios';
import * as crypto from 'crypto';

const KEYCLOAK_TOKEN_URL = 'https://auth.drm.apower.lan/realms/drm/protocol/openid-connect/token';
const API_BASE_URL = 'https://api.drm.apower.lan';

interface TokenResponse {
  access_token: string;
}

interface FolderResponse {
  id: string;
}

interface WhoamiResponse {
  id: string;
}

interface PermissionResponse {
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

  it('revokes a permission with a 204, empty body, and the grantee immediately loses access', async () => {
    const adminToken = await getToken('testadmin', 'testadminpass');
    const adminHeader = { Authorization: `Bearer ${adminToken}` };

    const folderRes = await axios.post<FolderResponse>(
      `${API_BASE_URL}/folders`,
      { name: `perm-revoke-test-${Date.now()}` },
      { headers: adminHeader },
    );
    const folderId = folderRes.data.id;

    const employeeToken = await getToken('testuser', 'testpass');
    const employeeUser = await whoami(employeeToken);

    const grantRes = await axios.post<PermissionResponse>(
      `${API_BASE_URL}/folders/${folderId}/permissions`,
      { principalType: 'user', principalId: employeeUser.id, permissionLevel: 'view' },
      { headers: adminHeader },
    );
    const permissionId = grantRes.data.id;

    const viewRes = await axios.get(`${API_BASE_URL}/folders/${folderId}`, {
      headers: { Authorization: `Bearer ${employeeToken}` },
    });
    expect(viewRes.status).toBe(200);

    const revokeRes = await axios.delete(
      `${API_BASE_URL}/folders/${folderId}/permissions/${permissionId}`,
      { headers: adminHeader },
    );
    expect(revokeRes.status).toBe(204);
    expect(revokeRes.data).toEqual('');

    await expect(
      axios.get(`${API_BASE_URL}/folders/${folderId}`, {
        headers: { Authorization: `Bearer ${employeeToken}` },
      }),
    ).rejects.toMatchObject({ response: { status: 403 } });
  });

  it('rejects revoking a nonexistent permission id with 404', async () => {
    const adminToken = await getToken('testadmin', 'testadminpass');
    const adminHeader = { Authorization: `Bearer ${adminToken}` };

    const folderRes = await axios.post<FolderResponse>(
      `${API_BASE_URL}/folders`,
      { name: `perm-404-test-${Date.now()}` },
      { headers: adminHeader },
    );

    await expect(
      axios.delete(
        `${API_BASE_URL}/folders/${folderRes.data.id}/permissions/${crypto.randomUUID()}`,
        { headers: adminHeader },
      ),
    ).rejects.toMatchObject({ response: { status: 404 } });
  });

  it('does not allow revoking a permission on one resource through a different resource the caller manages (IDOR)', async () => {
    const adminToken = await getToken('testadmin', 'testadminpass');
    const adminHeader = { Authorization: `Bearer ${adminToken}` };

    // Two independent folders. testuser will be granted `manage` on A only.
    const folderARes = await axios.post<FolderResponse>(
      `${API_BASE_URL}/folders`,
      { name: `perm-idor-a-${Date.now()}` },
      { headers: adminHeader },
    );
    const folderBRes = await axios.post<FolderResponse>(
      `${API_BASE_URL}/folders`,
      { name: `perm-idor-b-${Date.now()}` },
      { headers: adminHeader },
    );
    const folderAId = folderARes.data.id;
    const folderBId = folderBRes.data.id;

    const employeeToken = await getToken('testuser', 'testpass');
    const employeeHeader = { Authorization: `Bearer ${employeeToken}` };
    const employeeUser = await whoami(employeeToken);

    // testuser manages folder A only.
    await axios.post(
      `${API_BASE_URL}/folders/${folderAId}/permissions`,
      { principalType: 'user', principalId: employeeUser.id, permissionLevel: 'manage' },
      { headers: adminHeader },
    );

    // Some unrelated permission grant on folder B, which testuser has no access to.
    const grantBRes = await axios.post<PermissionResponse>(
      `${API_BASE_URL}/folders/${folderBId}/permissions`,
      { principalType: 'user', principalId: crypto.randomUUID(), permissionLevel: 'view' },
      { headers: adminHeader },
    );
    const permissionBId = grantBRes.data.id;

    // Attempting to revoke B's permission through B's own URL, as a caller
    // with no manage access to B, must be rejected as a plain 403.
    await expect(
      axios.delete(`${API_BASE_URL}/folders/${folderBId}/permissions/${permissionBId}`, {
        headers: employeeHeader,
      }),
    ).rejects.toMatchObject({ response: { status: 403 } });

    // The core IDOR: a caller who manages A must not be able to delete B's
    // permission row by supplying A's id in the URL and B's permission id
    // in the path param. This must 404, not silently succeed.
    await expect(
      axios.delete(`${API_BASE_URL}/folders/${folderAId}/permissions/${permissionBId}`, {
        headers: employeeHeader,
      }),
    ).rejects.toMatchObject({ response: { status: 404 } });

    // Confirm B's permission was never actually deleted by either attempt.
    const listBRes = await axios.get<PermissionResponse[]>(
      `${API_BASE_URL}/folders/${folderBId}/permissions`,
      { headers: adminHeader },
    );
    expect(listBRes.data.map((p) => p.id)).toContain(permissionBId);
  });
});
