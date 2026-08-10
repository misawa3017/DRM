import axios from 'axios';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';

const KEYCLOAK_TOKEN_URL = 'https://auth.drm.apower.lan/realms/drm/protocol/openid-connect/token';
const API_BASE_URL = 'https://api.drm.apower.lan';

interface TokenResponse {
  access_token: string;
}

interface SearchResultItem {
  resourceType: 'folder' | 'document';
  resourceId: string;
  name: string;
  path: string;
}

async function getToken(username: string, password: string): Promise<string> {
  const response = await axios.post<TokenResponse>(
    KEYCLOAK_TOKEN_URL,
    new URLSearchParams({ grant_type: 'password', client_id: 'drm-web', username, password }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
  );
  return response.data.access_token;
}

describe('Search (e2e)', () => {
  const prisma = new PrismaClient({
    datasources: { db: { url: 'postgresql://drm:drm_dev_password@localhost:5433/drm' } },
  });

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

  it('finds a folder the caller has view access to, case-insensitively', async () => {
    const unique = randomUUID();
    const folder = await prisma.folder.create({
      data: { name: `SearchTarget-${unique}`, parentId: null, createdBy: 'seed' },
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
    const res = await axios.get<SearchResultItem[]>(
      `${API_BASE_URL}/search?q=${encodeURIComponent(`searchtarget-${unique}`)}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );

    expect(
      res.data.some((r) => r.resourceId === folder.id && r.resourceType === 'folder'),
    ).toBe(true);
  });

  it('does not return a folder the caller has no grant on', async () => {
    const folder = await prisma.folder.create({
      data: { name: `NoAccess-${randomUUID()}`, parentId: null, createdBy: 'seed' },
    });

    const token = await getToken('testuser', 'testpass');
    const res = await axios.get<SearchResultItem[]>(
      `${API_BASE_URL}/search?q=${encodeURIComponent('NoAccess')}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );

    expect(res.data.some((r) => r.resourceId === folder.id)).toBe(false);
  });

  it('excludes a soft-deleted folder even if the caller has manage access to it, while still surfacing a live sibling', async () => {
    const unique = randomUUID();
    const folder = await prisma.folder.create({
      data: {
        name: `DeletedTarget-${unique}`,
        parentId: null,
        createdBy: 'seed',
        deletedAt: new Date(),
      },
    });
    const liveSibling = await prisma.folder.create({
      data: { name: `LiveTarget-${unique}`, parentId: null, createdBy: 'seed' },
    });
    await prisma.permission.create({
      data: {
        resourceType: 'folder',
        resourceId: folder.id,
        principalType: 'user',
        principalId: testUserId,
        permissionLevel: 'manage',
        grantedBy: 'seed',
      },
    });
    await prisma.permission.create({
      data: {
        resourceType: 'folder',
        resourceId: liveSibling.id,
        principalType: 'user',
        principalId: testUserId,
        permissionLevel: 'view',
        grantedBy: 'seed',
      },
    });

    const token = await getToken('testuser', 'testpass');
    const res = await axios.get<SearchResultItem[]>(
      `${API_BASE_URL}/search?q=${encodeURIComponent(unique)}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );

    expect(res.data.some((r) => r.resourceId === folder.id)).toBe(false);
    expect(res.data.some((r) => r.resourceId === liveSibling.id)).toBe(true);
  });

  it('excludes a soft-deleted document while still surfacing a live sibling', async () => {
    const unique = randomUUID();
    const folder = await prisma.folder.create({
      data: { name: `DocDeleteParent-${unique}`, parentId: null, createdBy: 'seed' },
    });
    const document = await prisma.document.create({
      data: {
        name: `DeletedDoc-${unique}`,
        folderId: folder.id,
        createdBy: 'seed',
        deletedAt: new Date(),
      },
    });
    const liveSibling = await prisma.document.create({
      data: { name: `LiveDoc-${unique}`, folderId: folder.id, createdBy: 'seed' },
    });
    await prisma.permission.create({
      data: {
        resourceType: 'document',
        resourceId: document.id,
        principalType: 'user',
        principalId: testUserId,
        permissionLevel: 'manage',
        grantedBy: 'seed',
      },
    });
    await prisma.permission.create({
      data: {
        resourceType: 'document',
        resourceId: liveSibling.id,
        principalType: 'user',
        principalId: testUserId,
        permissionLevel: 'view',
        grantedBy: 'seed',
      },
    });

    const token = await getToken('testuser', 'testpass');
    const res = await axios.get<SearchResultItem[]>(
      `${API_BASE_URL}/search?q=${encodeURIComponent(unique)}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );

    expect(res.data.some((r) => r.resourceId === document.id)).toBe(false);
    expect(res.data.some((r) => r.resourceId === liveSibling.id)).toBe(true);
  });

  it('resolves the correct ancestor path for a nested folder match', async () => {
    const unique = randomUUID();
    const root = await prisma.folder.create({
      data: { name: `PathRoot-${unique}`, parentId: null, createdBy: 'seed' },
    });
    const child = await prisma.folder.create({
      data: { name: `PathChild-${unique}`, parentId: root.id, createdBy: 'seed' },
    });
    await prisma.permission.create({
      data: {
        resourceType: 'folder',
        resourceId: child.id,
        principalType: 'user',
        principalId: testUserId,
        permissionLevel: 'view',
        grantedBy: 'seed',
      },
    });

    const token = await getToken('testuser', 'testpass');
    const res = await axios.get<SearchResultItem[]>(
      `${API_BASE_URL}/search?q=${encodeURIComponent(`PathChild-${unique}`)}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );

    const match = res.data.find((r) => r.resourceId === child.id);
    expect(match?.path).toBe(`Root / ${root.name}`);
  });

  it('returns an empty array for an empty or whitespace-only query', async () => {
    const token = await getToken('testuser', 'testpass');
    const res = await axios.get<SearchResultItem[]>(
      `${API_BASE_URL}/search?q=${encodeURIComponent('   ')}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );

    expect(res.data).toEqual([]);
  });

  it('lets an admin find any resource without an explicit grant', async () => {
    const unique = randomUUID();
    const folder = await prisma.folder.create({
      data: { name: `AdminFindable-${unique}`, parentId: null, createdBy: 'seed' },
    });

    const token = await getToken('testadmin', 'testadminpass');
    const res = await axios.get<SearchResultItem[]>(
      `${API_BASE_URL}/search?q=${encodeURIComponent(`AdminFindable-${unique}`)}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );

    expect(res.data.some((r) => r.resourceId === folder.id)).toBe(true);
  });
});
