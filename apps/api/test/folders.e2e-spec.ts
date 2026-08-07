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
  canManage?: boolean;
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

  it('GET /folders/:id reports canManage=false for a caller who only has view access', async () => {
    const folder = await prisma.folder.create({
      data: { name: `view-only-${randomUUID()}`, parentId: null, createdBy: 'seed' },
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

    expect(res.data.canManage).toBe(false);
  });

  it('GET /folders/:id reports canManage=true for a caller with manage access', async () => {
    const folder = await prisma.folder.create({
      data: { name: `manage-granted-${randomUUID()}`, parentId: null, createdBy: 'seed' },
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

    const token = await getToken('testuser', 'testpass');
    const res = await axios.get<FolderResponse>(`${API_BASE_URL}/folders/${folder.id}`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.data.canManage).toBe(true);
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

  it('POST /folders rejects a name that collides with an existing, non-deleted sibling', async () => {
    const parent = await prisma.folder.create({
      data: { name: `conflict-parent-${randomUUID()}`, parentId: null, createdBy: 'seed' },
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
    await axios.post(
      `${API_BASE_URL}/folders`,
      { name: 'dup-name', parentId: parent.id },
      { headers: { Authorization: `Bearer ${token}` } },
    );

    await expect(
      axios.post(
        `${API_BASE_URL}/folders`,
        { name: 'dup-name', parentId: parent.id },
        { headers: { Authorization: `Bearer ${token}` } },
      ),
    ).rejects.toMatchObject({ response: { status: 409 } });
  });

  it('POST /folders allows a name that collides only with a soft-deleted sibling', async () => {
    const parent = await prisma.folder.create({
      data: { name: `conflict-parent-${randomUUID()}`, parentId: null, createdBy: 'seed' },
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
    const deletedSibling = await prisma.folder.create({
      data: {
        name: 'reusable-name',
        parentId: parent.id,
        createdBy: 'seed',
        deletedAt: new Date(),
      },
    });
    void deletedSibling;

    const token = await getToken('testuser', 'testpass');
    const res = await axios.post<FolderResponse>(
      `${API_BASE_URL}/folders`,
      { name: 'reusable-name', parentId: parent.id },
      { headers: { Authorization: `Bearer ${token}` } },
    );
    expect(res.status).toBe(201);
  });

  it('GET /folders and GET /folders/:id never return a soft-deleted folder', async () => {
    const root = await prisma.folder.create({
      data: { name: `soft-deleted-root-${randomUUID()}`, parentId: null, createdBy: 'seed' },
    });
    await prisma.permission.create({
      data: {
        resourceType: 'folder',
        resourceId: root.id,
        principalType: 'user',
        principalId: testUserId,
        permissionLevel: 'manage',
        grantedBy: 'seed',
      },
    });
    await prisma.folder.update({ where: { id: root.id }, data: { deletedAt: new Date() } });

    const token = await getToken('testuser', 'testpass');
    const listRes = await axios.get<FolderResponse[]>(`${API_BASE_URL}/folders`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(listRes.data.map((f) => f.id)).not.toContain(root.id);

    await expect(
      axios.get(`${API_BASE_URL}/folders/${root.id}`, {
        headers: { Authorization: `Bearer ${token}` },
      }),
    ).rejects.toMatchObject({ response: { status: 404 } });
  });

  it("GET /folders/:id's children and documents each carry their own canManage, and exclude soft-deleted rows", async () => {
    const parent = await prisma.folder.create({
      data: { name: `parent-children-canmanage-${randomUUID()}`, parentId: null, createdBy: 'seed' },
    });
    await prisma.permission.create({
      data: {
        resourceType: 'folder',
        resourceId: parent.id,
        principalType: 'user',
        principalId: testUserId,
        permissionLevel: 'view',
        grantedBy: 'seed',
      },
    });
    const manageableChild = await prisma.folder.create({
      data: { name: 'manageable-child', parentId: parent.id, createdBy: 'seed' },
    });
    await prisma.permission.create({
      data: {
        resourceType: 'folder',
        resourceId: manageableChild.id,
        principalType: 'user',
        principalId: testUserId,
        permissionLevel: 'manage',
        grantedBy: 'seed',
      },
    });
    const viewOnlyChild = await prisma.folder.create({
      data: { name: 'view-only-child', parentId: parent.id, createdBy: 'seed' },
    });
    const deletedChild = await prisma.folder.create({
      data: {
        name: 'deleted-child',
        parentId: parent.id,
        createdBy: 'seed',
        deletedAt: new Date(),
      },
    });
    void deletedChild;

    const token = await getToken('testuser', 'testpass');
    const res = await axios.get<
      FolderResponse & { children: (FolderResponse & { canManage: boolean })[] }
    >(`${API_BASE_URL}/folders/${parent.id}`, { headers: { Authorization: `Bearer ${token}` } });

    const childIds = (res.data.children as (FolderResponse & { canManage: boolean })[]).map((c) => c.id);
    expect(childIds).toContain(manageableChild.id);
    expect(childIds).toContain(viewOnlyChild.id);
    expect(childIds).not.toContain(deletedChild.id);
    expect((res.data.children as (FolderResponse & { canManage: boolean })[]).find((c) => c.id === manageableChild.id)?.canManage).toBe(true);
    expect((res.data.children as (FolderResponse & { canManage: boolean })[]).find((c) => c.id === viewOnlyChild.id)?.canManage).toBe(false);
  });

  it('PATCH /folders/:id renames a folder the caller has edit access to, and records folder_rename', async () => {
    const parent = await prisma.folder.create({
      data: { name: `rename-parent-${randomUUID()}`, parentId: null, createdBy: 'seed' },
    });
    const folder = await prisma.folder.create({
      data: { name: 'old-name', parentId: parent.id, createdBy: 'seed' },
    });
    await prisma.permission.create({
      data: {
        resourceType: 'folder',
        resourceId: folder.id,
        principalType: 'user',
        principalId: testUserId,
        permissionLevel: 'edit',
        grantedBy: 'seed',
      },
    });

    const token = await getToken('testuser', 'testpass');
    const res = await axios.patch<FolderResponse>(
      `${API_BASE_URL}/folders/${folder.id}`,
      { name: 'new-name' },
      { headers: { Authorization: `Bearer ${token}` } },
    );
    expect(res.data.name).toBe('new-name');

    const logs = await prisma.auditLog.findMany({
      where: { resourceType: 'folder', resourceId: folder.id, action: 'folder_rename' },
    });
    expect(logs).toHaveLength(1);
  });

  it('PATCH /folders/:id rejects renaming without edit access', async () => {
    const folder = await prisma.folder.create({
      data: { name: 'no-edit-rename', parentId: null, createdBy: 'seed' },
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
    await expect(
      axios.patch(
        `${API_BASE_URL}/folders/${folder.id}`,
        { name: 'should-fail' },
        { headers: { Authorization: `Bearer ${token}` } },
      ),
    ).rejects.toMatchObject({ response: { status: 403 } });
  });

  it('PATCH /folders/:id rejects a rename that collides with an existing sibling', async () => {
    const parent = await prisma.folder.create({
      data: { name: `rename-conflict-parent-${randomUUID()}`, parentId: null, createdBy: 'seed' },
    });
    const target = await prisma.folder.create({
      data: { name: 'target', parentId: parent.id, createdBy: 'seed' },
    });
    await prisma.folder.create({
      data: { name: 'taken', parentId: parent.id, createdBy: 'seed' },
    });
    await prisma.permission.create({
      data: {
        resourceType: 'folder',
        resourceId: target.id,
        principalType: 'user',
        principalId: testUserId,
        permissionLevel: 'edit',
        grantedBy: 'seed',
      },
    });

    const token = await getToken('testuser', 'testpass');
    await expect(
      axios.patch(
        `${API_BASE_URL}/folders/${target.id}`,
        { name: 'taken' },
        { headers: { Authorization: `Bearer ${token}` } },
      ),
    ).rejects.toMatchObject({ response: { status: 409 } });
  });

  it('PATCH /folders/:id moves a folder when the caller has edit on both source and destination', async () => {
    const source = await prisma.folder.create({
      data: { name: `move-source-${randomUUID()}`, parentId: null, createdBy: 'seed' },
    });
    const destination = await prisma.folder.create({
      data: { name: `move-destination-${randomUUID()}`, parentId: null, createdBy: 'seed' },
    });
    const moved = await prisma.folder.create({
      data: { name: 'moved-folder', parentId: source.id, createdBy: 'seed' },
    });
    await prisma.permission.createMany({
      data: [
        {
          resourceType: 'folder',
          resourceId: moved.id,
          principalType: 'user',
          principalId: testUserId,
          permissionLevel: 'edit',
          grantedBy: 'seed',
        },
        {
          resourceType: 'folder',
          resourceId: destination.id,
          principalType: 'user',
          principalId: testUserId,
          permissionLevel: 'edit',
          grantedBy: 'seed',
        },
      ],
    });

    const token = await getToken('testuser', 'testpass');
    const res = await axios.patch<FolderResponse>(
      `${API_BASE_URL}/folders/${moved.id}`,
      { parentId: destination.id },
      { headers: { Authorization: `Bearer ${token}` } },
    );
    expect(res.data.parentId).toBe(destination.id);

    const logs = await prisma.auditLog.findMany({
      where: { resourceType: 'folder', resourceId: moved.id, action: 'folder_move' },
    });
    expect(logs).toHaveLength(1);
  });

  it('PATCH /folders/:id rejects moving without edit access to the destination', async () => {
    const source = await prisma.folder.create({
      data: { name: `move-noedit-source-${randomUUID()}`, parentId: null, createdBy: 'seed' },
    });
    const destination = await prisma.folder.create({
      data: { name: `move-noedit-destination-${randomUUID()}`, parentId: null, createdBy: 'seed' },
    });
    const moved = await prisma.folder.create({
      data: { name: 'moved-folder-2', parentId: source.id, createdBy: 'seed' },
    });
    await prisma.permission.create({
      data: {
        resourceType: 'folder',
        resourceId: moved.id,
        principalType: 'user',
        principalId: testUserId,
        permissionLevel: 'edit',
        grantedBy: 'seed',
      },
    });

    const token = await getToken('testuser', 'testpass');
    await expect(
      axios.patch(
        `${API_BASE_URL}/folders/${moved.id}`,
        { parentId: destination.id },
        { headers: { Authorization: `Bearer ${token}` } },
      ),
    ).rejects.toMatchObject({ response: { status: 403 } });
  });

  it('PATCH /folders/:id rejects moving a folder into its own descendant', async () => {
    const grandparent = await prisma.folder.create({
      data: { name: `cycle-gp-${randomUUID()}`, parentId: null, createdBy: 'seed' },
    });
    const parent = await prisma.folder.create({
      data: { name: 'cycle-parent', parentId: grandparent.id, createdBy: 'seed' },
    });
    const child = await prisma.folder.create({
      data: { name: 'cycle-child', parentId: parent.id, createdBy: 'seed' },
    });
    await prisma.permission.createMany({
      data: [
        {
          resourceType: 'folder',
          resourceId: parent.id,
          principalType: 'user',
          principalId: testUserId,
          permissionLevel: 'edit',
          grantedBy: 'seed',
        },
        {
          resourceType: 'folder',
          resourceId: child.id,
          principalType: 'user',
          principalId: testUserId,
          permissionLevel: 'edit',
          grantedBy: 'seed',
        },
      ],
    });

    const token = await getToken('testuser', 'testpass');
    // Move parent (non-root, has parentId: grandparent.id) into its own child.
    // This tests the descendant-cycle check, not the root-boundary check.
    await expect(
      axios.patch(
        `${API_BASE_URL}/folders/${parent.id}`,
        { parentId: child.id },
        { headers: { Authorization: `Bearer ${token}` } },
      ),
    ).rejects.toMatchObject({ response: { status: 400 } });
  });

  it('PATCH /folders/:id rejects explicit parentId: null', async () => {
    const parent = await prisma.folder.create({
      data: { name: `null-parent-${randomUUID()}`, parentId: null, createdBy: 'seed' },
    });
    const folder = await prisma.folder.create({
      data: { name: 'null-target', parentId: parent.id, createdBy: 'seed' },
    });
    await prisma.permission.create({
      data: {
        resourceType: 'folder',
        resourceId: folder.id,
        principalType: 'user',
        principalId: testUserId,
        permissionLevel: 'edit',
        grantedBy: 'seed',
      },
    });

    const token = await getToken('testuser', 'testpass');
    // Explicitly passing null for parentId in the request body should reject with 400,
    // not 403 (which would indicate a permissions problem).
    await expect(
      axios.patch(
        `${API_BASE_URL}/folders/${folder.id}`,
        { parentId: null },
        { headers: { Authorization: `Bearer ${token}` } },
      ),
    ).rejects.toMatchObject({ response: { status: 400 } });
  });

  it('PATCH /folders/:id rejects moving a top-level (root) folder', async () => {
    const root = await prisma.folder.create({
      data: { name: `root-move-attempt-${randomUUID()}`, parentId: null, createdBy: 'seed' },
    });
    const destination = await prisma.folder.create({
      data: { name: `root-move-destination-${randomUUID()}`, parentId: null, createdBy: 'seed' },
    });
    await prisma.permission.createMany({
      data: [
        {
          resourceType: 'folder',
          resourceId: root.id,
          principalType: 'user',
          principalId: testUserId,
          permissionLevel: 'edit',
          grantedBy: 'seed',
        },
        {
          resourceType: 'folder',
          resourceId: destination.id,
          principalType: 'user',
          principalId: testUserId,
          permissionLevel: 'edit',
          grantedBy: 'seed',
        },
      ],
    });

    const token = await getToken('testuser', 'testpass');
    await expect(
      axios.patch(
        `${API_BASE_URL}/folders/${root.id}`,
        { parentId: destination.id },
        { headers: { Authorization: `Bearer ${token}` } },
      ),
    ).rejects.toMatchObject({ response: { status: 400 } });
  });

  it('DELETE /folders/:id soft-deletes the folder and all descendant folders/documents, each with its own audit entry', async () => {
    const root = await prisma.folder.create({
      data: { name: `delete-root-${randomUUID()}`, parentId: null, createdBy: 'seed' },
    });
    const child = await prisma.folder.create({
      data: { name: 'delete-child', parentId: root.id, createdBy: 'seed' },
    });
    const doc = await prisma.document.create({
      data: { name: 'delete-doc.txt', folderId: child.id, createdBy: 'seed' },
    });
    await prisma.permission.create({
      data: {
        resourceType: 'folder',
        resourceId: root.id,
        principalType: 'user',
        principalId: testUserId,
        permissionLevel: 'edit',
        grantedBy: 'seed',
      },
    });

    const token = await getToken('testuser', 'testpass');
    const res = await axios.delete(`${API_BASE_URL}/folders/${root.id}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(204);

    const [rootRow, childRow, docRow] = await Promise.all([
      prisma.folder.findUniqueOrThrow({ where: { id: root.id } }),
      prisma.folder.findUniqueOrThrow({ where: { id: child.id } }),
      prisma.document.findUniqueOrThrow({ where: { id: doc.id } }),
    ]);
    expect(rootRow.deletedAt).not.toBeNull();
    expect(childRow.deletedAt).not.toBeNull();
    expect(docRow.deletedAt).not.toBeNull();

    const [rootLogs, childLogs, docLogs] = await Promise.all([
      prisma.auditLog.findMany({
        where: { resourceType: 'folder', resourceId: root.id, action: 'folder_delete' },
      }),
      prisma.auditLog.findMany({
        where: { resourceType: 'folder', resourceId: child.id, action: 'folder_delete' },
      }),
      prisma.auditLog.findMany({
        where: { resourceType: 'document', resourceId: doc.id, action: 'document_delete' },
      }),
    ]);
    expect(rootLogs).toHaveLength(1);
    expect(childLogs).toHaveLength(1);
    expect(docLogs).toHaveLength(1);
  });

  it('DELETE /folders/:id rejects deletion without edit access', async () => {
    const folder = await prisma.folder.create({
      data: { name: `no-edit-delete-${randomUUID()}`, parentId: null, createdBy: 'seed' },
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
    await expect(
      axios.delete(`${API_BASE_URL}/folders/${folder.id}`, {
        headers: { Authorization: `Bearer ${token}` },
      }),
    ).rejects.toMatchObject({ response: { status: 403 } });
  });

  it('creating inside a soft-deleted parent folder is rejected as not found', async () => {
    const parent = await prisma.folder.create({
      data: {
        name: `deleted-parent-${randomUUID()}`,
        parentId: null,
        createdBy: 'seed',
        deletedAt: new Date(),
      },
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
    await expect(
      axios.post(
        `${API_BASE_URL}/folders`,
        { name: 'child-of-deleted', parentId: parent.id },
        { headers: { Authorization: `Bearer ${token}` } },
      ),
    ).rejects.toMatchObject({ response: { status: 404 } });
  });
});
