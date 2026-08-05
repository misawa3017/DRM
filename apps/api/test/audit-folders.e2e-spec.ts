import axios from 'axios';
import { PrismaClient } from '@prisma/client';

const KEYCLOAK_TOKEN_URL = 'http://auth.drm.apower.lan/realms/drm/protocol/openid-connect/token';
const API_BASE_URL = 'http://api.drm.apower.lan';

interface TokenResponse {
  access_token: string;
}

interface FolderResponse {
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

describe('Folder audit logging (e2e)', () => {
  const prisma = new PrismaClient({
    datasources: { db: { url: 'postgresql://drm:drm_dev_password@localhost:5433/drm' } },
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('records folder_create and folder_view with a valid chain link and a real IP', async () => {
    const adminToken = await getToken('testadmin', 'testadminpass');
    const authHeader = { Authorization: `Bearer ${adminToken}` };

    const createRes = await axios.post<FolderResponse>(
      `${API_BASE_URL}/folders`,
      { name: `audit-test-${Date.now()}` },
      { headers: authHeader },
    );
    const folderId = createRes.data.id;

    await axios.get(`${API_BASE_URL}/folders/${folderId}`, { headers: authHeader });

    const entries = await prisma.auditLog.findMany({
      where: { resourceType: 'folder', resourceId: folderId },
      orderBy: { sequence: 'asc' },
    });

    expect(entries).toHaveLength(2);
    expect(entries[0].action).toBe('folder_create');
    expect(entries[1].action).toBe('folder_view');
    expect(entries[1].prevHash).toBe(entries[0].hash);
    expect(entries[0].ipAddress).not.toBeNull();
    // Without `app.set('trust proxy', true)` in main.ts, Express reports the
    // TCP peer address of the request — Traefik's own container IP inside
    // the compose network, IPv6-mapped by Node's socket layer — instead of
    // the real client IP forwarded via X-Forwarded-For. Verified directly:
    // temporarily reverting the trust-proxy line and rerunning this test
    // captured `::ffff:172.19.0.5` (Traefik's container IP) in the audit row.
    expect(entries[0].ipAddress).not.toBe('::ffff:172.19.0.5');
  });
});
