import axios from 'axios';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';

const KEYCLOAK_TOKEN_URL = 'https://auth.drm.apower.lan/realms/drm/protocol/openid-connect/token';
const API_BASE_URL = 'https://api.drm.apower.lan';

interface TokenResponse {
  access_token: string;
}

interface UserSummaryResponse {
  id: string;
  email: string;
  displayName: string;
  department: string | null;
}

async function getToken(username: string, password: string): Promise<string> {
  const response = await axios.post<TokenResponse>(
    KEYCLOAK_TOKEN_URL,
    new URLSearchParams({ grant_type: 'password', client_id: 'drm-web', username, password }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
  );
  return response.data.access_token;
}

describe('Users search (e2e)', () => {
  const prisma = new PrismaClient({
    datasources: { db: { url: 'postgresql://drm:drm_dev_password@localhost:5433/drm' } },
  });

  const suffix = randomUUID().slice(0, 8);
  const emailTarget = `search-target-${suffix}@example.com`;
  const nameTarget = `SearchTarget-${suffix}`;

  beforeAll(async () => {
    await prisma.user.create({
      data: {
        keycloakSub: `test-search-${suffix}`,
        email: emailTarget,
        displayName: nameTarget,
        department: 'QA',
      },
    });
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { email: emailTarget } });
    await prisma.$disconnect();
  });

  it('finds a user by a substring of their email, case-insensitively', async () => {
    const token = await getToken('testuser', 'testpass');
    const res = await axios.get<UserSummaryResponse[]>(
      `${API_BASE_URL}/users?search=${encodeURIComponent(`SEARCH-TARGET-${suffix}`)}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );

    expect(res.status).toBe(200);
    const match = res.data.find((u) => u.email === emailTarget);
    expect(match).toBeDefined();
    expect(match?.displayName).toBe(nameTarget);
    expect(match?.department).toBe('QA');
  });

  it('finds a user by a substring of their display name', async () => {
    const token = await getToken('testuser', 'testpass');
    const res = await axios.get<UserSummaryResponse[]>(
      `${API_BASE_URL}/users?search=${encodeURIComponent(nameTarget)}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );

    expect(res.data.map((u) => u.id)).toEqual(
      expect.arrayContaining([expect.any(String)]),
    );
    expect(res.data.some((u) => u.email === emailTarget)).toBe(true);
  });

  it('does not include sensitive fields like keycloakSub', async () => {
    const token = await getToken('testuser', 'testpass');
    const res = await axios.get<Record<string, unknown>[]>(
      `${API_BASE_URL}/users?search=${encodeURIComponent(nameTarget)}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );

    for (const user of res.data) {
      expect(user).not.toHaveProperty('keycloakSub');
    }
  });

  it('rejects an empty search query with 400', async () => {
    const token = await getToken('testuser', 'testpass');
    await expect(
      axios.get(`${API_BASE_URL}/users?search=`, {
        headers: { Authorization: `Bearer ${token}` },
      }),
    ).rejects.toMatchObject({ response: { status: 400 } });
  });

  it('rejects an unauthenticated request with 401', async () => {
    await expect(axios.get(`${API_BASE_URL}/users?search=anything`)).rejects.toMatchObject({
      response: { status: 401 },
    });
  });
});
