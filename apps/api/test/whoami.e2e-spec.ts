import axios from 'axios';
import { PrismaClient } from '@prisma/client';

const KEYCLOAK_TOKEN_URL = 'http://auth.drm.localhost/realms/drm/protocol/openid-connect/token';
const API_BASE_URL = 'http://api.drm.localhost';

async function getTestUserToken(): Promise<string> {
  const response = await axios.post(
    KEYCLOAK_TOKEN_URL,
    new URLSearchParams({
      grant_type: 'password',
      client_id: 'drm-web',
      username: 'testuser',
      password: 'testpass',
    }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
  );
  return response.data.access_token;
}

describe('GET /whoami (e2e)', () => {
  const prisma = new PrismaClient({
    datasources: { db: { url: 'postgresql://drm:drm_dev_password@localhost:5433/drm' } },
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('returns the authenticated user and persists it', async () => {
    const token = await getTestUserToken();

    const res = await axios.get(`${API_BASE_URL}/whoami`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);
    expect(res.data.email).toBe('testuser@example.com');
    expect(res.data.roles).toContain('employee');

    const dbUser = await prisma.user.findUnique({ where: { email: 'testuser@example.com' } });
    expect(dbUser).not.toBeNull();
    expect(dbUser?.keycloakSub).toBeDefined();
  });

  it('rejects requests without a token', async () => {
    await expect(axios.get(`${API_BASE_URL}/whoami`)).rejects.toMatchObject({
      response: { status: 401 },
    });
  });
});
