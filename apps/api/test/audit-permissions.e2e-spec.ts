import axios from 'axios';
import { PrismaClient } from '@prisma/client';

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

describe('Permission audit logging (e2e)', () => {
  const prisma = new PrismaClient({
    datasources: { db: { url: 'postgresql://drm:drm_dev_password@localhost:5433/drm' } },
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('records permission_grant and permission_revoke against the resource, in a valid hash chain', async () => {
    const adminToken = await getToken('testadmin', 'testadminpass');
    const adminHeader = { Authorization: `Bearer ${adminToken}` };

    const folderRes = await axios.post<FolderResponse>(
      `${API_BASE_URL}/folders`,
      { name: `audit-perm-test-${Date.now()}` },
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

    await axios.delete(`${API_BASE_URL}/folders/${folderId}/permissions/${permissionId}`, {
      headers: adminHeader,
    });

    const entries = await prisma.auditLog.findMany({
      where: { resourceType: 'folder', resourceId: folderId },
      orderBy: { sequence: 'asc' },
    });

    // folder_create, then permission_grant, then permission_revoke.
    expect(entries).toHaveLength(3);
    expect(entries[0].action).toBe('folder_create');
    expect(entries[1].action).toBe('permission_grant');
    expect(entries[2].action).toBe('permission_revoke');

    expect(entries[1].prevHash).toBe(entries[0].hash);
    expect(entries[2].prevHash).toBe(entries[1].hash);

    for (const entry of entries) {
      expect(entry.ipAddress).not.toBeNull();
    }

    // Fix 4: grant/revoke must record who received access and at what
    // level, so there's a durable record of past access even after revoke.
    expect(entries[1].details).toMatchObject({
      principalType: 'user',
      principalId: employeeUser.id,
      permissionLevel: 'view',
    });
    expect(entries[2].details).toMatchObject({
      principalId: employeeUser.id,
      permissionLevel: 'view',
    });
  });
});
