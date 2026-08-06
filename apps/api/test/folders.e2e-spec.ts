import axios from 'axios';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';

const KEYCLOAK_TOKEN_URL = 'https://auth.drm.apower.lan/realms/drm/protocol/openid-connect/token';
const API_BASE_URL = 'https://api.drm.apower.lan';

interface TokenResponse {
  access_token: string;
}

interface FolderResponse {
  id: string;
  name: string;
  parentId: string | null;
  createdBy: string;
  createdAt: string;
  children?: unknown[];
  documents?: unknown[];
}

async function getToken(username: string, password: string): Promise<string> {
  const response = await axios.post<TokenResponse>(
    KEYCLOAK_TOKEN_URL,
    new URLSearchParams({
      grant_type: 'password',
      client_id: 'drm-web',
      username,
      password,
    }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
  );
  return response.data.access_token;
}

describe('Folders (e2e)', () => {
  // There is no seeded admin test user yet (Task 8 adds one via
  // realm-export.json), so root-folder-as-admin and cross-user visibility
  // scenarios below are set up by writing directly to Postgres rather than
  // going through Keycloak, mirroring how AclService's own spec seeds
  // fixtures. This still exercises the real HTTP path (FoldersController ->
  // FoldersService -> AclService) for every assertion; only the *setup* of
  // "a folder/grant already exists" bypasses the API.
  const prisma = new PrismaClient({
    datasources: { db: { url: 'postgresql://drm:drm_dev_password@localhost:5433/drm' } },
  });

  // The app-level User.id that Permission grants are keyed on (distinct from
  // the Keycloak `sub`). Resolved once in beforeAll by hitting an
  // authenticated endpoint, which upserts the User row as a side effect
  // (see UsersService.upsertFromToken).
  let testUserId: string;

  beforeAll(async () => {
    const token = await getToken('testuser', 'testpass');
    const res = await axios.get<{ id: string }>(`${API_BASE_URL}/whoami`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    testUserId = res.data.id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('a non-admin cannot create a root folder', async () => {
    const token = await getToken('testuser', 'testpass');
    await expect(
      axios.post(
        `${API_BASE_URL}/folders`,
        { name: 'should-fail' },
        { headers: { Authorization: `Bearer ${token}` } },
      ),
    ).rejects.toMatchObject({ response: { status: 403 } });
  });

  it('a non-admin cannot view a folder they have no grant on', async () => {
    // Seeded directly via Prisma with no Permission row for testUserId, so
    // the ACL chain resolves to "no grant anywhere in the chain" and the
    // folder must be invisible to them.
    const folder = await prisma.folder.create({
      data: { name: `no-access-${randomUUID()}`, parentId: null, createdBy: 'seed' },
    });

    const token = await getToken('testuser', 'testpass');
    await expect(
      axios.get(`${API_BASE_URL}/folders/${folder.id}`, {
        headers: { Authorization: `Bearer ${token}` },
      }),
    ).rejects.toMatchObject({ response: { status: 403 } });
  });

  it('a non-admin can view a folder they were explicitly granted view access to', async () => {
    const folder = await prisma.folder.create({
      data: { name: `granted-${randomUUID()}`, parentId: null, createdBy: 'seed' },
    });
    await prisma.permission.create({
      data: {
        resourceType: 'folder',
        resourceId: folder.id,
        principalType: 'user',
        principalId: testUserId,
        permissionLevel: 'view',
        grantedBy: 'seed',
      },
    });

    const token = await getToken('testuser', 'testpass');
    const res = await axios.get<FolderResponse>(`${API_BASE_URL}/folders/${folder.id}`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);
    expect(res.data.id).toBe(folder.id);
    expect(res.data.children).toEqual([]);
    expect(res.data.documents).toEqual([]);
  });

  it('a non-admin with edit access to a folder can create a subfolder inside it', async () => {
    const parent = await prisma.folder.create({
      data: { name: `parent-${randomUUID()}`, parentId: null, createdBy: 'seed' },
    });
    await prisma.permission.create({
      data: {
        resourceType: 'folder',
        resourceId: parent.id,
        principalType: 'user',
        principalId: testUserId,
        permissionLevel: 'edit',
        grantedBy: 'seed',
      },
    });

    const token = await getToken('testuser', 'testpass');
    const res = await axios.post<FolderResponse>(
      `${API_BASE_URL}/folders`,
      { name: 'child-folder', parentId: parent.id },
      { headers: { Authorization: `Bearer ${token}` } },
    );

    expect(res.status).toBe(201);
    expect(res.data.parentId).toBe(parent.id);
    expect(res.data.createdBy).toBe(testUserId);
  });

  it('a non-admin without edit access to a parent cannot create a subfolder inside it', async () => {
    const parent = await prisma.folder.create({
      data: { name: `locked-parent-${randomUUID()}`, parentId: null, createdBy: 'seed' },
    });

    const token = await getToken('testuser', 'testpass');
    await expect(
      axios.post(
        `${API_BASE_URL}/folders`,
        { name: 'should-fail-child', parentId: parent.id },
        { headers: { Authorization: `Bearer ${token}` } },
      ),
    ).rejects.toMatchObject({ response: { status: 403 } });
  });

  it('GET /folders returns only root folders the caller can view', async () => {
    const visible = await prisma.folder.create({
      data: { name: `visible-root-${randomUUID()}`, parentId: null, createdBy: 'seed' },
    });
    await prisma.permission.create({
      data: {
        resourceType: 'folder',
        resourceId: visible.id,
        principalType: 'user',
        principalId: testUserId,
        permissionLevel: 'view',
        grantedBy: 'seed',
      },
    });
    const hidden = await prisma.folder.create({
      data: { name: `hidden-root-${randomUUID()}`, parentId: null, createdBy: 'seed' },
    });

    const token = await getToken('testuser', 'testpass');
    const res = await axios.get<FolderResponse[]>(`${API_BASE_URL}/folders`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);
    const ids = res.data.map((folder) => folder.id);
    expect(ids).toContain(visible.id);
    expect(ids).not.toContain(hidden.id);
  });

  it('GET /folders returns every root folder for an admin, even without an explicit grant', async () => {
    const folder = await prisma.folder.create({
      data: { name: `admin-visible-${randomUUID()}`, parentId: null, createdBy: 'seed' },
    });

    const token = await getToken('testadmin', 'testadminpass');
    const res = await axios.get<FolderResponse[]>(`${API_BASE_URL}/folders`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.data.map((f) => f.id)).toContain(folder.id);
  });
});
