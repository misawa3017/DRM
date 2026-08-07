# Rename / Move / Delete Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users rename, move, and (soft) delete folders and documents from the web UI, with matching backend endpoints, audit logging, and a same-level name-uniqueness check retrofitted onto both creation and mutation.

**Architecture:** Two new Prisma fields (`Folder.deletedAt`, `Document.deletedAt`) plus six new `AuditAction` values. `FoldersService`/`DocumentsService` each gain an `update` (rename+move, one `PATCH`) and `delete` (soft delete) method, both gated by the existing `edit`-level ACL check used elsewhere in these services. All existing read paths get a `deletedAt: null` filter so a soft-deleted resource is invisible to everyone, and `getWithContents` additionally computes `canManage` per child row (not just for the folder itself) so the frontend can gate per-row action buttons. The frontend adds three small reusable components (inline-editable name, delete-confirm dialog, move-to-folder button built on `ResourcePicker`) and wires them into `FolderView` (header + child rows) and `DocumentView` (header).

**Tech Stack:** NestJS + Prisma + PostgreSQL (backend), React + TanStack Query + React Router (frontend), Jest (`apps/api`), Vitest + Testing Library (`apps/web`).

## Global Constraints

- Rename, move, and delete all require `edit`-level ACL on the resource being mutated — the same level already used for "create subfolder" and "upload document" (`manage` is reserved for ACL administration only).
- Move additionally requires `edit` on the destination folder.
- Move never crosses the root boundary: the item being moved must already have a non-null `parentId`/`folderId`, and the destination must be an existing, non-deleted, non-root-required folder (destination itself may be a root folder — only the *source's own* root-ness and the literal value `null` as a destination are disallowed).
- Move is blocked (400) if the destination is the folder itself or one of its own descendants.
- Same-level name conflicts (a non-deleted sibling with the identical name) are rejected with 409, checked via an application-level query (`deletedAt: null`, excluding the row being updated) — never a DB-level `@@unique`, because `parentId` can be `null` for multiple root folders and Postgres `NULL <> NULL` would defeat a naive unique index there.
- Delete is a soft delete (`deletedAt` timestamp). Deleting a folder cascades to every descendant folder and document. A soft-deleted resource is invisible via every existing read path (`listRootFolders`, `getWithContents`, `getMetadata`, `listVersions`, `download`) to every caller, regardless of their ACL level. No restore/trash UI this round.
- Every folder/document actually soft-deleted gets its own audit log entry (`folder_delete`/`document_delete`), not one aggregated entry per cascade — matches the existing one-entry-per-resource pattern used by `folder_create`/`document_create`.
- `AclService` is not modified. The cascade-delete invariant (deleting a folder deletes 100% of its descendants in the same operation) guarantees a non-deleted resource's entire ancestor chain is also non-deleted, so `resolveLevel`'s parent walk never needs to know about `deletedAt`. Write-target checks (create's `parentId`, move's destination) still need their own explicit `deletedAt` check, since ACL alone would still resolve a grant on an already-deleted folder.
- Frontend TDD: this feature follows normal per-task TDD (no "build first, test later" exception — that exception was specific to the earlier visual-only navbar redesign).

---

## File Structure

**Backend (`apps/api/src`):**
- `apps/api/prisma/schema.prisma` — add `deletedAt` to `Folder`/`Document`, extend `AuditAction`.
- `folders/folders.service.ts` — add `update`, `delete`, private `assertNoFolderNameConflict`, `collectDescendantFolderIds`, `collectFolderSubtreeIds`; extend `listRootFolders`/`getWithContents` with `deletedAt: null` filtering and per-child `canManage`; extend `create` with the name-conflict check and a destination-not-deleted check.
- `folders/folders.controller.ts` — add `PATCH :id`, `DELETE :id`.
- `folders/dto/update-folder.dto.ts` — new.
- `documents/documents.service.ts` — add `update`, `delete`, private `assertNoDocumentNameConflict`; extend `getMetadata`/`listVersions`/`getDownloadStream` with `deletedAt` checks; extend `createDocument` with the name-conflict check and a destination-not-deleted check.
- `documents/documents.controller.ts` — add `PATCH :id`, `DELETE :id`.
- `documents/dto/update-document.dto.ts` — new.

**Frontend (`apps/web/src`):**
- `api/client.ts` — `friendlyErrorMessage` gains a 409 case.
- `api/folders.ts` — `FolderChildSummary`, `DocumentChildSummary` types; `renameFolder`, `moveFolder`, `deleteFolder`.
- `api/documents.ts` — `renameDocument`, `moveDocument`, `deleteDocument`.
- `components/ResourcePicker.tsx` — add `mode?: 'any' | 'folder-only'` and `title?: string` props.
- `components/InlineEditableName.tsx` — new, shared by both header titles and row names.
- `components/DeleteConfirmDialog.tsx` — new, shared.
- `components/MoveButton.tsx` — new, shared, wraps `ResourcePicker` in folder-only mode.
- `routes/FolderView.tsx` — wire the three actions into the header and both child-row tables.
- `routes/DocumentView.tsx` — wire the three actions into the header.

---

### Task 1: Prisma migration — `deletedAt` fields and new `AuditAction` values

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Create: a new migration folder under `apps/api/prisma/migrations/` (generated by Prisma, not hand-written)

**Interfaces:**
- Produces: `Folder.deletedAt: DateTime | null`, `Document.deletedAt: DateTime | null`, and six new `AuditAction` enum members (`folder_rename`, `folder_move`, `folder_delete`, `document_rename`, `document_move`, `document_delete`) that every later task's audit calls rely on.

- [ ] **Step 1: Edit the schema**

In `apps/api/prisma/schema.prisma`, add `deletedAt` to `Folder` (after `updatedAt`):

```prisma
model Folder {
  id        String     @id @default(uuid())
  name      String
  parentId  String?
  parent    Folder?    @relation("FolderChildren", fields: [parentId], references: [id])
  children  Folder[]   @relation("FolderChildren")
  documents Document[]
  createdBy String
  createdAt DateTime   @default(now())
  updatedAt DateTime   @updatedAt
  deletedAt DateTime?

  @@index([parentId])
  @@map("folders")
}
```

Add `deletedAt` to `Document` (after `updatedAt`):

```prisma
model Document {
  id               String            @id @default(uuid())
  folderId         String
  folder           Folder            @relation(fields: [folderId], references: [id])
  name             String
  currentVersionId String?           @unique
  currentVersion   DocumentVersion?  @relation("CurrentVersion", fields: [currentVersionId], references: [id])
  versions         DocumentVersion[] @relation("DocumentVersions")
  createdBy        String
  createdAt        DateTime          @default(now())
  updatedAt        DateTime          @updatedAt
  deletedAt        DateTime?

  @@index([folderId])
  @@map("documents")
}
```

Extend the `AuditAction` enum:

```prisma
enum AuditAction {
  folder_create
  folder_view
  folder_rename
  folder_move
  folder_delete
  document_create
  document_view
  document_download
  document_version_upload
  document_rename
  document_move
  document_delete
  permission_grant
  permission_revoke
  virus_detected
}
```

- [ ] **Step 2: Generate and apply the migration**

Run (from `apps/api`):

```bash
DATABASE_URL="postgresql://drm:drm_dev_password@localhost:5433/drm" pnpm exec prisma migrate dev --name add_deleted_at_and_mutation_audit_actions
```

Expected: a new folder appears under `apps/api/prisma/migrations/`, and the command prints "Your database is now in sync with your schema."

- [ ] **Step 3: Regenerate the Prisma client**

```bash
pnpm exec prisma generate
```

- [ ] **Step 4: Verify the existing suite still passes**

```bash
pnpm --filter api exec jest
```

Expected: all existing suites still pass (the new columns are nullable and the new enum values are additive, so nothing existing should break).

- [ ] **Step 5: Commit**

```bash
git add apps/api/prisma/schema.prisma apps/api/prisma/migrations
git commit -m "feat(api): add deletedAt to Folder/Document and new mutation audit actions"
```

---

### Task 2: Folders — name-conflict check, retrofit into `create`, soft-delete filtering on reads

**Files:**
- Modify: `apps/api/src/folders/folders.service.ts`
- Test: `apps/api/test/folders.e2e-spec.ts`

**Interfaces:**
- Consumes: `AclService.can(user, 'folder', id, level)` (existing).
- Produces: `FoldersService.assertNoFolderNameConflict(parentId: string | null, name: string, excludeId?: string): Promise<void>` (private, throws `ConflictException`) — Task 3 reuses this for the move/rename path. `listRootFolders`/`getWithContents` now filter out soft-deleted rows and `getWithContents`'s `children`/`documents` entries each carry their own `canManage: boolean`.

- [ ] **Step 1: Write the failing tests**

Append to `apps/api/test/folders.e2e-spec.ts` (it already has `FolderResponse`, `getToken`, the `prisma` client, and `testUserId` set up — see the existing `beforeAll`):

```ts
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

    const childIds = res.data.children.map((c) => c.id);
    expect(childIds).toContain(manageableChild.id);
    expect(childIds).toContain(viewOnlyChild.id);
    expect(childIds).not.toContain(deletedChild.id);
    expect(res.data.children.find((c) => c.id === manageableChild.id)?.canManage).toBe(true);
    expect(res.data.children.find((c) => c.id === viewOnlyChild.id)?.canManage).toBe(false);
  });
```

- [ ] **Step 2: Run to verify failure**

```bash
pnpm --filter api exec jest --config ./test/jest-e2e.json test/folders.e2e-spec.ts -t "canManage|soft-deleted|collides"
```

Expected: FAIL — 409/canManage/filtering behavior doesn't exist yet.

- [ ] **Step 3: Implement**

Replace the full contents of `apps/api/src/folders/folders.service.ts` with:

```ts
import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AclService } from '../acl/acl.service';
import { AuditService } from '../audit/audit.service';

interface AuthenticatedUser {
  id: string;
  roles: string[];
}

@Injectable()
export class FoldersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly acl: AclService,
    private readonly audit: AuditService,
  ) {}

  // Application-level check rather than a DB @@unique([parentId, name]):
  // parentId is nullable (multiple root folders), and Postgres treats every
  // NULL as distinct from every other NULL, so a naive unique index would
  // silently fail to catch root-level name collisions. A soft-deleted
  // sibling's name must not block reuse, hence deletedAt: null here.
  private async assertNoFolderNameConflict(
    parentId: string | null,
    name: string,
    excludeId?: string,
  ): Promise<void> {
    const conflict = await this.prisma.folder.findFirst({
      where: {
        parentId,
        name,
        deletedAt: null,
        ...(excludeId ? { id: { not: excludeId } } : {}),
      },
      select: { id: true },
    });
    if (conflict) {
      throw new ConflictException('A folder with this name already exists here');
    }
  }

  async listRootFolders(user: AuthenticatedUser) {
    const folders = await this.prisma.folder.findMany({
      where: { parentId: null, deletedAt: null },
      orderBy: { name: 'asc' },
    });
    const allowed = await Promise.all(
      folders.map((folder) => this.acl.can(user, 'folder', folder.id, 'view')),
    );
    // Not audited: this only decides which root folders are *listed*, it
    // doesn't view any one folder's contents. Opening a folder is still
    // audited as folder_view via getWithContents below, mirroring the
    // listVersions/getMetadata split in documents.service.ts.
    return folders.filter((_, index) => allowed[index]);
  }

  async create(user: AuthenticatedUser, name: string, parentId: string | null, ipAddress: string | null) {
    if (parentId === null || parentId === undefined) {
      if (!user.roles.includes('admin')) {
        throw new ForbiddenException('Only admins can create root-level folders');
      }
    } else {
      const allowed = await this.acl.can(user, 'folder', parentId, 'edit');
      if (!allowed) {
        throw new ForbiddenException('You do not have edit access to the parent folder');
      }
      const parent = await this.prisma.folder.findUnique({ where: { id: parentId } });
      if (!parent || parent.deletedAt) {
        throw new NotFoundException('Parent folder not found');
      }
    }

    await this.assertNoFolderNameConflict(parentId ?? null, name);

    const folder = await this.prisma.folder.create({
      data: { name, parentId: parentId ?? null, createdBy: user.id },
    });

    await this.audit.recordSafely({
      actorId: user.id,
      action: 'folder_create',
      resourceType: 'folder',
      resourceId: folder.id,
      ipAddress,
    });

    return folder;
  }

  async getWithContents(user: AuthenticatedUser, id: string, ipAddress: string | null) {
    const allowed = await this.acl.can(user, 'folder', id, 'view');
    if (!allowed) {
      throw new ForbiddenException('You do not have view access to this folder');
    }

    const folder = await this.prisma.folder.findUnique({
      where: { id },
      include: {
        children: { where: { deletedAt: null }, orderBy: { name: 'asc' } },
        documents: {
          where: { deletedAt: null },
          include: { currentVersion: true },
          orderBy: { name: 'asc' },
        },
      },
    });
    if (!folder || folder.deletedAt) {
      throw new NotFoundException('Folder not found');
    }

    // Each child's own canManage — not just the folder being viewed — so the
    // frontend can gate a rename/move/delete affordance per row. GET
    // /folders/:id/permissions requires 'manage', a higher bar than the
    // 'view' access that gets a caller into this method at all, so a caller
    // can see a child without being allowed to mutate it.
    const [canManage, childrenCanManage, documentsCanManage] = await Promise.all([
      this.acl.can(user, 'folder', id, 'manage'),
      Promise.all(folder.children.map((c) => this.acl.can(user, 'folder', c.id, 'manage'))),
      Promise.all(folder.documents.map((d) => this.acl.can(user, 'document', d.id, 'manage'))),
    ]);

    await this.audit.recordSafely({
      actorId: user.id,
      action: 'folder_view',
      resourceType: 'folder',
      resourceId: id,
      ipAddress,
    });

    return {
      ...folder,
      canManage,
      children: folder.children.map((c, i) => ({ ...c, canManage: childrenCanManage[i] })),
      documents: folder.documents.map((d, i) => ({ ...d, canManage: documentsCanManage[i] })),
    };
  }
}
```

- [ ] **Step 4: Run to verify tests pass**

```bash
pnpm --filter api exec jest --config ./test/jest-e2e.json test/folders.e2e-spec.ts
```

Expected: PASS, full file (existing + new tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/folders/folders.service.ts apps/api/test/folders.e2e-spec.ts
git commit -m "feat(api): folder name-conflict check and soft-delete filtering on reads"
```

---

### Task 3: Folders — `PATCH /folders/:id` (rename + move)

**Files:**
- Create: `apps/api/src/folders/dto/update-folder.dto.ts`
- Modify: `apps/api/src/folders/folders.service.ts`, `apps/api/src/folders/folders.controller.ts`
- Test: `apps/api/test/folders.e2e-spec.ts`

**Interfaces:**
- Consumes: `assertNoFolderNameConflict` (Task 2).
- Produces: `FoldersService.update(user, id, changes: { name?: string; parentId?: string }, ipAddress): Promise<Folder>`; `FoldersService.collectDescendantFolderIds(folderId: string): Promise<string[]>` (private, Task 4 reuses the same recursive-walk technique for cascade delete — not the same function, but the same query shape, called out here so Task 4's implementer knows it already exists as a reference).

- [ ] **Step 1: Write the failing tests**

Append to `apps/api/test/folders.e2e-spec.ts`:

```ts
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
          resourceId: grandparent.id,
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
    // Move grandparent into its own grandchild — a cycle two levels down.
    await expect(
      axios.patch(
        `${API_BASE_URL}/folders/${grandparent.id}`,
        { parentId: child.id },
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
```

- [ ] **Step 2: Run to verify failure**

```bash
pnpm --filter api exec jest --config ./test/jest-e2e.json test/folders.e2e-spec.ts -t "PATCH"
```

Expected: FAIL — route doesn't exist (404/`Cannot PATCH`).

- [ ] **Step 3: Implement the DTO**

Create `apps/api/src/folders/dto/update-folder.dto.ts`:

```ts
import { IsNotEmpty, IsOptional, IsString, IsUUID } from 'class-validator';

export class UpdateFolderDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  name?: string;

  @IsOptional()
  @IsUUID()
  parentId?: string;
}
```

- [ ] **Step 4: Implement the service method**

Add to `apps/api/src/folders/folders.service.ts` (import `BadRequestException` alongside the existing Nest imports at the top, and add the method to the class, after `getWithContents`):

```ts
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
```

```ts
  // Descendants only (excludes folderId itself) — used to block moving a
  // folder into itself or into its own subtree.
  private async collectDescendantFolderIds(folderId: string): Promise<string[]> {
    const result: string[] = [];
    const queue: string[] = [folderId];
    while (queue.length > 0) {
      const current = queue.shift() as string;
      const children = await this.prisma.folder.findMany({
        where: { parentId: current },
        select: { id: true },
      });
      for (const child of children) {
        result.push(child.id);
        queue.push(child.id);
      }
    }
    return result;
  }

  async update(
    user: AuthenticatedUser,
    id: string,
    changes: { name?: string; parentId?: string },
    ipAddress: string | null,
  ) {
    const allowed = await this.acl.can(user, 'folder', id, 'edit');
    if (!allowed) {
      throw new ForbiddenException('You do not have edit access to this folder');
    }

    const folder = await this.prisma.folder.findUnique({ where: { id } });
    if (!folder || folder.deletedAt) {
      throw new NotFoundException('Folder not found');
    }

    let newParentId = folder.parentId;
    if (changes.parentId !== undefined) {
      if (folder.parentId === null) {
        throw new BadRequestException('Cannot move a top-level folder');
      }
      const destinationAllowed = await this.acl.can(user, 'folder', changes.parentId, 'edit');
      if (!destinationAllowed) {
        throw new ForbiddenException('You do not have edit access to the destination folder');
      }
      const destination = await this.prisma.folder.findUnique({ where: { id: changes.parentId } });
      if (!destination || destination.deletedAt) {
        throw new NotFoundException('Destination folder not found');
      }
      const descendantIds = await this.collectDescendantFolderIds(id);
      if (changes.parentId === id || descendantIds.includes(changes.parentId)) {
        throw new BadRequestException(
          'Cannot move a folder into itself or one of its own descendants',
        );
      }
      newParentId = changes.parentId;
    }

    const newName = changes.name ?? folder.name;
    if (changes.name !== undefined || changes.parentId !== undefined) {
      await this.assertNoFolderNameConflict(newParentId, newName, folder.id);
    }

    const updated = await this.prisma.folder.update({
      where: { id },
      data: { name: newName, parentId: newParentId },
    });

    if (changes.name !== undefined && changes.name !== folder.name) {
      await this.audit.recordSafely({
        actorId: user.id,
        action: 'folder_rename',
        resourceType: 'folder',
        resourceId: id,
        ipAddress,
        details: { oldName: folder.name, newName: changes.name },
      });
    }
    if (changes.parentId !== undefined && changes.parentId !== folder.parentId) {
      await this.audit.recordSafely({
        actorId: user.id,
        action: 'folder_move',
        resourceType: 'folder',
        resourceId: id,
        ipAddress,
        details: { oldParentId: folder.parentId ?? '', newParentId: changes.parentId },
      });
    }

    return updated;
  }
```

- [ ] **Step 5: Implement the controller route**

In `apps/api/src/folders/folders.controller.ts`, update the imports and add the route:

```ts
import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
```

```ts
  @Patch(':id')
  async update(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: UpdateFolderDto,
  ) {
    const user = await this.usersService.upsertFromToken(req.user);
    return this.foldersService.update(
      { id: user.id, roles: req.user.roles },
      id,
      { name: body.name, parentId: body.parentId },
      req.ip ?? null,
    );
  }
```

Add the import for `UpdateFolderDto` alongside `CreateFolderDto`.

- [ ] **Step 6: Run to verify tests pass**

```bash
pnpm --filter api exec jest --config ./test/jest-e2e.json test/folders.e2e-spec.ts
```

Expected: PASS, full file.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/folders/dto/update-folder.dto.ts apps/api/src/folders/folders.service.ts apps/api/src/folders/folders.controller.ts apps/api/test/folders.e2e-spec.ts
git commit -m "feat(api): add PATCH /folders/:id for rename and move"
```

---

### Task 4: Folders — `DELETE /folders/:id` (cascading soft delete)

**Files:**
- Modify: `apps/api/src/folders/folders.service.ts`, `apps/api/src/folders/folders.controller.ts`
- Test: `apps/api/test/folders.e2e-spec.ts`

**Interfaces:**
- Produces: `FoldersService.delete(user, id, ipAddress): Promise<void>`.

- [ ] **Step 1: Write the failing tests**

Append to `apps/api/test/folders.e2e-spec.ts`:

```ts
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
```

- [ ] **Step 2: Run to verify failure**

```bash
pnpm --filter api exec jest --config ./test/jest-e2e.json test/folders.e2e-spec.ts -t "DELETE|soft-deleted parent"
```

Expected: FAIL — route doesn't exist, and the "deleted parent" case isn't rejected yet (already covered by Task 2's `create` change — this test should already pass once Task 2 is in; if it doesn't, that's a signal Task 2 was incomplete, not a Task 4 defect).

- [ ] **Step 3: Implement the service method**

Add to `apps/api/src/folders/folders.service.ts`, after `update`:

```ts
  // Folder itself plus every descendant folder, and every document anywhere
  // in that subtree. Used by delete() to cascade the soft-delete in one
  // pass; each returned id gets its own audit entry (see Global
  // Constraints — one entry per resource, not one aggregated entry).
  private async collectFolderSubtreeIds(
    rootFolderId: string,
  ): Promise<{ folderIds: string[]; documentIds: string[] }> {
    const folderIds: string[] = [rootFolderId];
    const documentIds: string[] = [];
    const queue: string[] = [rootFolderId];
    while (queue.length > 0) {
      const current = queue.shift() as string;
      const [children, documents] = await Promise.all([
        this.prisma.folder.findMany({ where: { parentId: current }, select: { id: true } }),
        this.prisma.document.findMany({ where: { folderId: current }, select: { id: true } }),
      ]);
      for (const child of children) {
        folderIds.push(child.id);
        queue.push(child.id);
      }
      documentIds.push(...documents.map((d) => d.id));
    }
    return { folderIds, documentIds };
  }

  async delete(user: AuthenticatedUser, id: string, ipAddress: string | null): Promise<void> {
    const allowed = await this.acl.can(user, 'folder', id, 'edit');
    if (!allowed) {
      throw new ForbiddenException('You do not have edit access to this folder');
    }

    const folder = await this.prisma.folder.findUnique({ where: { id } });
    if (!folder || folder.deletedAt) {
      throw new NotFoundException('Folder not found');
    }

    const { folderIds, documentIds } = await this.collectFolderSubtreeIds(id);
    const now = new Date();

    await this.prisma.$transaction([
      this.prisma.folder.updateMany({ where: { id: { in: folderIds } }, data: { deletedAt: now } }),
      this.prisma.document.updateMany({
        where: { id: { in: documentIds } },
        data: { deletedAt: now },
      }),
    ]);

    for (const folderId of folderIds) {
      await this.audit.recordSafely({
        actorId: user.id,
        action: 'folder_delete',
        resourceType: 'folder',
        resourceId: folderId,
        ipAddress,
      });
    }
    for (const documentId of documentIds) {
      await this.audit.recordSafely({
        actorId: user.id,
        action: 'document_delete',
        resourceType: 'document',
        resourceId: documentId,
        ipAddress,
      });
    }
  }
```

- [ ] **Step 4: Implement the controller route**

Add to `apps/api/src/folders/folders.controller.ts` (the `Delete`/`HttpCode` imports were already added in Task 3's Step 5):

```ts
  @Delete(':id')
  @HttpCode(204)
  async remove(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    const user = await this.usersService.upsertFromToken(req.user);
    await this.foldersService.delete({ id: user.id, roles: req.user.roles }, id, req.ip ?? null);
  }
```

- [ ] **Step 5: Run to verify tests pass**

```bash
pnpm --filter api exec jest --config ./test/jest-e2e.json test/folders.e2e-spec.ts
```

Expected: PASS, full file.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/folders/folders.service.ts apps/api/src/folders/folders.controller.ts apps/api/test/folders.e2e-spec.ts
git commit -m "feat(api): add DELETE /folders/:id with cascading soft delete"
```

---

### Task 5: Documents — name-conflict check, retrofit into `createDocument`, soft-delete filtering on reads

**Files:**
- Modify: `apps/api/src/documents/documents.service.ts`
- Test: `apps/api/test/documents-read.e2e-spec.ts`, `apps/api/test/documents-write.e2e-spec.ts`

**Interfaces:**
- Produces: `DocumentsService.assertNoDocumentNameConflict(folderId: string, name: string, excludeId?: string): Promise<void>` (private, Task 6 reuses this).

- [ ] **Step 1: Write the failing tests**

Append to `apps/api/test/documents-write.e2e-spec.ts` (check its existing header for `getToken`/`API_BASE_URL` — reuse the same helper shape as `documents-read.e2e-spec.ts`; if this file doesn't already import `PrismaClient`, add `import { PrismaClient } from '@prisma/client';` and a `prisma` client the same way `documents-read.e2e-spec.ts`'s Task-added tests did):

```ts
  it('POST /documents rejects a name that collides with an existing, non-deleted sibling in the same folder', async () => {
    const adminToken = await getToken('testadmin', 'testadminpass');
    const folderRes = await axios.post<{ id: string }>(
      `${API_BASE_URL}/folders`,
      { name: `doc-conflict-${Date.now()}` },
      { headers: { Authorization: `Bearer ${adminToken}` } },
    );
    const folderId = folderRes.data.id;

    const form1 = new FormData();
    form1.append('folderId', folderId);
    form1.append('name', 'dup.txt');
    form1.append('file', Buffer.from('one'), { filename: 'dup.txt' });
    await axios.post(`${API_BASE_URL}/documents`, form1, {
      headers: { Authorization: `Bearer ${adminToken}`, ...form1.getHeaders() },
    });

    const form2 = new FormData();
    form2.append('folderId', folderId);
    form2.append('name', 'dup.txt');
    form2.append('file', Buffer.from('two'), { filename: 'dup.txt' });
    await expect(
      axios.post(`${API_BASE_URL}/documents`, form2, {
        headers: { Authorization: `Bearer ${adminToken}`, ...form2.getHeaders() },
      }),
    ).rejects.toMatchObject({ response: { status: 409 } });
  });
```

Append to `apps/api/test/documents-read.e2e-spec.ts` (it already has `prisma`, `testUserId`, `getToken`, `randomUUID` from the earlier `canManage` tests):

```ts
  it('GET /documents/:id, listVersions, and download all treat a soft-deleted document as not found', async () => {
    const folder = await prisma.folder.create({
      data: { name: `deleted-doc-folder-${randomUUID()}`, parentId: null, createdBy: 'seed' },
    });
    const document = await prisma.document.create({
      data: {
        name: 'will-be-deleted.txt',
        folderId: folder.id,
        createdBy: 'seed',
        deletedAt: new Date(),
      },
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

    const token = await getToken('testuser', 'testpass');
    const headers = { Authorization: `Bearer ${token}` };

    await expect(
      axios.get(`${API_BASE_URL}/documents/${document.id}`, { headers }),
    ).rejects.toMatchObject({ response: { status: 404 } });
    await expect(
      axios.get(`${API_BASE_URL}/documents/${document.id}/versions`, { headers }),
    ).rejects.toMatchObject({ response: { status: 404 } });
    await expect(
      axios.get(`${API_BASE_URL}/documents/${document.id}/download`, { headers }),
    ).rejects.toMatchObject({ response: { status: 404 } });
  });

  it('a soft-deleted document does not appear in its (non-deleted) folder listing', async () => {
    const folder = await prisma.folder.create({
      data: { name: `deleted-doc-listing-${randomUUID()}`, parentId: null, createdBy: 'seed' },
    });
    const document = await prisma.document.create({
      data: {
        name: 'hidden.txt',
        folderId: folder.id,
        createdBy: 'seed',
        deletedAt: new Date(),
      },
    });
    void document;
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
    const res = await axios.get<{ documents: { id: string }[] }>(
      `${API_BASE_URL}/folders/${folder.id}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    expect(res.data.documents.map((d) => d.id)).not.toContain(document.id);
  });
```

- [ ] **Step 2: Run to verify failure**

```bash
pnpm --filter api exec jest --config ./test/jest-e2e.json test/documents-write.e2e-spec.ts test/documents-read.e2e-spec.ts -t "conflict|soft-deleted|hidden"
```

Expected: FAIL.

- [ ] **Step 3: Implement**

In `apps/api/src/documents/documents.service.ts`, update the top-level import to add `ConflictException` and `NotFoundException`:

```ts
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  PayloadTooLargeException,
  ServiceUnavailableException,
} from '@nestjs/common';
```

Add this private method to the class (anywhere before `createDocument`):

```ts
  // Same rationale as FoldersService.assertNoFolderNameConflict: application-
  // level check, deletedAt: null excludes soft-deleted siblings from the
  // conflict check.
  private async assertNoDocumentNameConflict(
    folderId: string,
    name: string,
    excludeId?: string,
  ): Promise<void> {
    const conflict = await this.prisma.document.findFirst({
      where: {
        folderId,
        name,
        deletedAt: null,
        ...(excludeId ? { id: { not: excludeId } } : {}),
      },
      select: { id: true },
    });
    if (conflict) {
      throw new ConflictException('A document with this name already exists in this folder');
    }
  }
```

In `createDocument`, right after the existing `edit`-access check and before `rejectIfInfected`, add the destination-not-deleted check and the name-conflict check:

```ts
    const allowed = await this.acl.can(user, 'folder', folderId, 'edit');
    if (!allowed) {
      throw new ForbiddenException('You do not have edit access to this folder');
    }
    const folder = await this.prisma.folder.findUnique({ where: { id: folderId } });
    if (!folder || folder.deletedAt) {
      throw new NotFoundException('Folder not found');
    }
    await this.assertNoDocumentNameConflict(folderId, name);
```

(This replaces the existing three-line `allowed`/`if` block at the top of `createDocument` — the rest of the method, starting at `// No Document row exists yet...`, is unchanged.)

In `listVersions`, replace the body to check the parent document isn't deleted:

```ts
  async listVersions(user: AuthenticatedUser, documentId: string) {
    const allowed = await this.acl.can(user, 'document', documentId, 'view');
    if (!allowed) {
      throw new ForbiddenException('You do not have view access to this document');
    }
    const document = await this.prisma.document.findUnique({ where: { id: documentId } });
    if (!document || document.deletedAt) {
      throw new NotFoundException('Document not found');
    }
    return this.prisma.documentVersion.findMany({
      where: { documentId },
      orderBy: { versionNumber: 'desc' },
    });
  }
```

In `getMetadata`, replace `findUniqueOrThrow` with an explicit deletedAt-aware fetch:

```ts
  async getMetadata(user: AuthenticatedUser, documentId: string, ipAddress: string | null) {
    const allowed = await this.acl.can(user, 'document', documentId, 'view');
    if (!allowed) {
      throw new ForbiddenException('You do not have view access to this document');
    }
    const document = await this.prisma.document.findUnique({
      where: { id: documentId },
      include: { currentVersion: true },
    });
    if (!document || document.deletedAt) {
      throw new NotFoundException('Document not found');
    }

    await this.audit.recordSafely({
      actorId: user.id,
      action: 'document_view',
      resourceType: 'document',
      resourceId: documentId,
      ipAddress,
    });

    return document;
  }
```

In `getDownloadStream`, add a deletedAt check right after the `download`-access check:

```ts
    const allowed = await this.acl.can(user, 'document', documentId, 'download');
    if (!allowed) {
      throw new ForbiddenException('You do not have download access to this document');
    }
    const document = await this.prisma.document.findUnique({ where: { id: documentId } });
    if (!document || document.deletedAt) {
      throw new NotFoundException('Document not found');
    }
```

(The rest of `getDownloadStream`, starting at `const version = versionId ? ...`, is unchanged.)

In `FoldersService.getWithContents` (already modified in Task 2), no further change is needed — its `documents: { where: { deletedAt: null }, ... }` filter already covers "a soft-deleted document does not appear in its folder listing."

- [ ] **Step 4: Run to verify tests pass**

```bash
pnpm --filter api exec jest --config ./test/jest-e2e.json test/documents-write.e2e-spec.ts test/documents-read.e2e-spec.ts
```

Expected: PASS, both full files.

- [ ] **Step 5: Run the full e2e suite once to catch any other test relying on the old `findUniqueOrThrow`/no-conflict-check behavior**

```bash
pnpm --filter api exec jest --config ./test/jest-e2e.json
```

Expected: PASS (the two known-flaky audit hash-chain suites — `audit-documents.e2e-spec.ts`, `audit-permissions.e2e-spec.ts` — may intermittently fail when run alongside every other suite due to a pre-existing race on the shared audit log; if either fails, re-run just that file alone to confirm it's the known flake, not a regression from this task).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/documents/documents.service.ts apps/api/test/documents-write.e2e-spec.ts apps/api/test/documents-read.e2e-spec.ts
git commit -m "feat(api): document name-conflict check and soft-delete filtering on reads"
```

---

### Task 6: Documents — `PATCH /documents/:id` (rename + move)

**Files:**
- Create: `apps/api/src/documents/dto/update-document.dto.ts`
- Modify: `apps/api/src/documents/documents.service.ts`, `apps/api/src/documents/documents.controller.ts`
- Test: `apps/api/test/documents-write.e2e-spec.ts`

**Interfaces:**
- Consumes: `assertNoDocumentNameConflict` (Task 5).
- Produces: `DocumentsService.update(user, id, changes: { name?: string; folderId?: string }, ipAddress): Promise<Document>`.

- [ ] **Step 1: Write the failing tests**

Append to `apps/api/test/documents-write.e2e-spec.ts`:

```ts
  it('PATCH /documents/:id renames a document the caller has edit access to, and records document_rename', async () => {
    const adminToken = await getToken('testadmin', 'testadminpass');
    const folderRes = await axios.post<{ id: string }>(
      `${API_BASE_URL}/folders`,
      { name: `doc-rename-${Date.now()}` },
      { headers: { Authorization: `Bearer ${adminToken}` } },
    );
    const form = new FormData();
    form.append('folderId', folderRes.data.id);
    form.append('name', 'old.txt');
    form.append('file', Buffer.from('content'), { filename: 'old.txt' });
    const createRes = await axios.post<{ id: string }>(`${API_BASE_URL}/documents`, form, {
      headers: { Authorization: `Bearer ${adminToken}`, ...form.getHeaders() },
    });

    const res = await axios.patch<{ name: string }>(
      `${API_BASE_URL}/documents/${createRes.data.id}`,
      { name: 'new.txt' },
      { headers: { Authorization: `Bearer ${adminToken}` } },
    );
    expect(res.data.name).toBe('new.txt');
  });

  it('PATCH /documents/:id moves a document when the caller has edit on both the document and destination folder', async () => {
    const adminToken = await getToken('testadmin', 'testadminpass');
    const sourceFolderRes = await axios.post<{ id: string }>(
      `${API_BASE_URL}/folders`,
      { name: `doc-move-source-${Date.now()}` },
      { headers: { Authorization: `Bearer ${adminToken}` } },
    );
    const destinationFolderRes = await axios.post<{ id: string }>(
      `${API_BASE_URL}/folders`,
      { name: `doc-move-destination-${Date.now()}` },
      { headers: { Authorization: `Bearer ${adminToken}` } },
    );
    const form = new FormData();
    form.append('folderId', sourceFolderRes.data.id);
    form.append('name', 'movable.txt');
    form.append('file', Buffer.from('content'), { filename: 'movable.txt' });
    const createRes = await axios.post<{ id: string }>(`${API_BASE_URL}/documents`, form, {
      headers: { Authorization: `Bearer ${adminToken}`, ...form.getHeaders() },
    });

    const res = await axios.patch<{ folderId: string }>(
      `${API_BASE_URL}/documents/${createRes.data.id}`,
      { folderId: destinationFolderRes.data.id },
      { headers: { Authorization: `Bearer ${adminToken}` } },
    );
    expect(res.data.folderId).toBe(destinationFolderRes.data.id);
  });

  it('PATCH /documents/:id rejects moving without edit access to the destination folder', async () => {
    const adminToken = await getToken('testadmin', 'testadminpass');
    const employeeToken = await getToken('testuser', 'testpass');
    const sourceFolderRes = await axios.post<{ id: string }>(
      `${API_BASE_URL}/folders`,
      { name: `doc-move-noedit-source-${Date.now()}` },
      { headers: { Authorization: `Bearer ${adminToken}` } },
    );
    const destinationFolderRes = await axios.post<{ id: string }>(
      `${API_BASE_URL}/folders`,
      { name: `doc-move-noedit-destination-${Date.now()}` },
      { headers: { Authorization: `Bearer ${adminToken}` } },
    );
    const form = new FormData();
    form.append('folderId', sourceFolderRes.data.id);
    form.append('name', 'movable2.txt');
    form.append('file', Buffer.from('content'), { filename: 'movable2.txt' });
    const createRes = await axios.post<{ id: string }>(`${API_BASE_URL}/documents`, form, {
      headers: { Authorization: `Bearer ${adminToken}`, ...form.getHeaders() },
    });

    const whoamiRes = await axios.get<{ id: string }>(`${API_BASE_URL}/whoami`, {
      headers: { Authorization: `Bearer ${employeeToken}` },
    });
    await axios.post(
      `${API_BASE_URL}/documents/${createRes.data.id}/permissions`,
      { principalType: 'user', principalId: whoamiRes.data.id, permissionLevel: 'edit' },
      { headers: { Authorization: `Bearer ${adminToken}` } },
    );

    await expect(
      axios.patch(
        `${API_BASE_URL}/documents/${createRes.data.id}`,
        { folderId: destinationFolderRes.data.id },
        { headers: { Authorization: `Bearer ${employeeToken}` } },
      ),
    ).rejects.toMatchObject({ response: { status: 403 } });
  });
```

- [ ] **Step 2: Run to verify failure**

```bash
pnpm --filter api exec jest --config ./test/jest-e2e.json test/documents-write.e2e-spec.ts -t "PATCH"
```

Expected: FAIL — route doesn't exist.

- [ ] **Step 3: Implement the DTO**

Create `apps/api/src/documents/dto/update-document.dto.ts`:

```ts
import { IsNotEmpty, IsOptional, IsString, IsUUID } from 'class-validator';

export class UpdateDocumentDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  name?: string;

  @IsOptional()
  @IsUUID()
  folderId?: string;
}
```

- [ ] **Step 4: Implement the service method**

Add to `apps/api/src/documents/documents.service.ts`, after `createDocument` (or anywhere in the class):

```ts
  async update(
    user: AuthenticatedUser,
    documentId: string,
    changes: { name?: string; folderId?: string },
    ipAddress: string | null,
  ) {
    const allowed = await this.acl.can(user, 'document', documentId, 'edit');
    if (!allowed) {
      throw new ForbiddenException('You do not have edit access to this document');
    }

    const document = await this.prisma.document.findUnique({ where: { id: documentId } });
    if (!document || document.deletedAt) {
      throw new NotFoundException('Document not found');
    }

    let newFolderId = document.folderId;
    if (changes.folderId !== undefined) {
      if (changes.folderId === document.folderId) {
        throw new BadRequestException('Document is already in this folder');
      }
      const destinationAllowed = await this.acl.can(user, 'folder', changes.folderId, 'edit');
      if (!destinationAllowed) {
        throw new ForbiddenException('You do not have edit access to the destination folder');
      }
      const destination = await this.prisma.folder.findUnique({ where: { id: changes.folderId } });
      if (!destination || destination.deletedAt) {
        throw new NotFoundException('Destination folder not found');
      }
      newFolderId = changes.folderId;
    }

    const newName = changes.name ?? document.name;
    if (changes.name !== undefined || changes.folderId !== undefined) {
      await this.assertNoDocumentNameConflict(newFolderId, newName, document.id);
    }

    const updated = await this.prisma.document.update({
      where: { id: documentId },
      data: { name: newName, folderId: newFolderId },
    });

    if (changes.name !== undefined && changes.name !== document.name) {
      await this.audit.recordSafely({
        actorId: user.id,
        action: 'document_rename',
        resourceType: 'document',
        resourceId: documentId,
        ipAddress,
        details: { oldName: document.name, newName: changes.name },
      });
    }
    if (changes.folderId !== undefined && changes.folderId !== document.folderId) {
      await this.audit.recordSafely({
        actorId: user.id,
        action: 'document_move',
        resourceType: 'document',
        resourceId: documentId,
        ipAddress,
        details: { oldFolderId: document.folderId, newFolderId: changes.folderId },
      });
    }

    return updated;
  }
```

- [ ] **Step 5: Implement the controller route**

In `apps/api/src/documents/documents.controller.ts`, update the imports:

```ts
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
```

Add the import for `UpdateDocumentDto` alongside `CreateDocumentDto`, and add the route:

```ts
  @Patch(':id')
  async update(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: UpdateDocumentDto,
  ) {
    const user = await this.usersService.upsertFromToken(req.user);
    return this.documentsService.update(
      { id: user.id, roles: req.user.roles },
      id,
      { name: body.name, folderId: body.folderId },
      req.ip ?? null,
    );
  }
```

- [ ] **Step 6: Run to verify tests pass**

```bash
pnpm --filter api exec jest --config ./test/jest-e2e.json test/documents-write.e2e-spec.ts
```

Expected: PASS, full file.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/documents/dto/update-document.dto.ts apps/api/src/documents/documents.service.ts apps/api/src/documents/documents.controller.ts apps/api/test/documents-write.e2e-spec.ts
git commit -m "feat(api): add PATCH /documents/:id for rename and move"
```

---

### Task 7: Documents — `DELETE /documents/:id`

**Files:**
- Modify: `apps/api/src/documents/documents.service.ts`, `apps/api/src/documents/documents.controller.ts`
- Test: `apps/api/test/documents-write.e2e-spec.ts`

**Interfaces:**
- Produces: `DocumentsService.delete(user, documentId, ipAddress): Promise<void>`.

- [ ] **Step 1: Write the failing tests**

Append to `apps/api/test/documents-write.e2e-spec.ts`:

```ts
  it('DELETE /documents/:id soft-deletes the document and records document_delete', async () => {
    const adminToken = await getToken('testadmin', 'testadminpass');
    const folderRes = await axios.post<{ id: string }>(
      `${API_BASE_URL}/folders`,
      { name: `doc-delete-${Date.now()}` },
      { headers: { Authorization: `Bearer ${adminToken}` } },
    );
    const form = new FormData();
    form.append('folderId', folderRes.data.id);
    form.append('name', 'deleteme.txt');
    form.append('file', Buffer.from('content'), { filename: 'deleteme.txt' });
    const createRes = await axios.post<{ id: string }>(`${API_BASE_URL}/documents`, form, {
      headers: { Authorization: `Bearer ${adminToken}`, ...form.getHeaders() },
    });

    const res = await axios.delete(`${API_BASE_URL}/documents/${createRes.data.id}`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(res.status).toBe(204);

    await expect(
      axios.get(`${API_BASE_URL}/documents/${createRes.data.id}`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      }),
    ).rejects.toMatchObject({ response: { status: 404 } });
  });

  it('DELETE /documents/:id rejects deletion without edit access', async () => {
    const adminToken = await getToken('testadmin', 'testadminpass');
    const employeeToken = await getToken('testuser', 'testpass');
    const folderRes = await axios.post<{ id: string }>(
      `${API_BASE_URL}/folders`,
      { name: `doc-delete-noedit-${Date.now()}` },
      { headers: { Authorization: `Bearer ${adminToken}` } },
    );
    const form = new FormData();
    form.append('folderId', folderRes.data.id);
    form.append('name', 'nodelete.txt');
    form.append('file', Buffer.from('content'), { filename: 'nodelete.txt' });
    const createRes = await axios.post<{ id: string }>(`${API_BASE_URL}/documents`, form, {
      headers: { Authorization: `Bearer ${adminToken}`, ...form.getHeaders() },
    });
    const whoamiRes = await axios.get<{ id: string }>(`${API_BASE_URL}/whoami`, {
      headers: { Authorization: `Bearer ${employeeToken}` },
    });
    await axios.post(
      `${API_BASE_URL}/documents/${createRes.data.id}/permissions`,
      { principalType: 'user', principalId: whoamiRes.data.id, permissionLevel: 'view' },
      { headers: { Authorization: `Bearer ${adminToken}` } },
    );

    await expect(
      axios.delete(`${API_BASE_URL}/documents/${createRes.data.id}`, {
        headers: { Authorization: `Bearer ${employeeToken}` },
      }),
    ).rejects.toMatchObject({ response: { status: 403 } });
  });
```

- [ ] **Step 2: Run to verify failure**

```bash
pnpm --filter api exec jest --config ./test/jest-e2e.json test/documents-write.e2e-spec.ts -t "DELETE"
```

Expected: FAIL — route doesn't exist.

- [ ] **Step 3: Implement the service method**

Add to `apps/api/src/documents/documents.service.ts`, after `update`:

```ts
  async delete(user: AuthenticatedUser, documentId: string, ipAddress: string | null): Promise<void> {
    const allowed = await this.acl.can(user, 'document', documentId, 'edit');
    if (!allowed) {
      throw new ForbiddenException('You do not have edit access to this document');
    }

    const document = await this.prisma.document.findUnique({ where: { id: documentId } });
    if (!document || document.deletedAt) {
      throw new NotFoundException('Document not found');
    }

    await this.prisma.document.update({
      where: { id: documentId },
      data: { deletedAt: new Date() },
    });

    await this.audit.recordSafely({
      actorId: user.id,
      action: 'document_delete',
      resourceType: 'document',
      resourceId: documentId,
      ipAddress,
    });
  }
```

- [ ] **Step 4: Implement the controller route**

Add to `apps/api/src/documents/documents.controller.ts`:

```ts
  @Delete(':id')
  @HttpCode(204)
  async remove(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    const user = await this.usersService.upsertFromToken(req.user);
    await this.documentsService.delete({ id: user.id, roles: req.user.roles }, id, req.ip ?? null);
  }
```

- [ ] **Step 5: Run to verify tests pass**

```bash
pnpm --filter api exec jest --config ./test/jest-e2e.json test/documents-write.e2e-spec.ts
```

Expected: PASS, full file.

- [ ] **Step 6: Run the full backend suite (unit + e2e) once, end to end**

```bash
pnpm --filter api exec jest
pnpm --filter api exec jest --config ./test/jest-e2e.json
```

Expected: all pass (modulo the two known-flaky audit hash-chain suites when run alongside everything else — see Task 5, Step 5).

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/documents/documents.service.ts apps/api/src/documents/documents.controller.ts apps/api/test/documents-write.e2e-spec.ts
git commit -m "feat(api): add DELETE /documents/:id"
```

---

### Task 8: Frontend API client — types and rename/move/delete functions

**Files:**
- Modify: `apps/web/src/api/client.ts`, `apps/web/src/api/folders.ts`, `apps/web/src/api/documents.ts`
- Test: `apps/web/test/api/client.test.ts`, `apps/web/test/api/folders.test.ts`, `apps/web/test/api/documents.test.ts`

**Interfaces:**
- Produces: `renameFolder(id, name, accessToken)`, `moveFolder(id, parentId, accessToken)`, `deleteFolder(id, accessToken)`, `renameDocument(id, name, accessToken)`, `moveDocument(id, folderId, accessToken)`, `deleteDocument(id, accessToken)`. `FolderChildSummary`, `DocumentChildSummary` types (each = their non-child counterpart + `canManage: boolean`), used by `FolderDetail.children`/`FolderDetail.documents`. `friendlyErrorMessage` now returns a specific string for 409.

- [ ] **Step 1: Write the failing tests**

Add to `apps/web/test/api/client.test.ts`, inside the existing `describe('friendlyErrorMessage', ...)` block (this file uses `vi.stubGlobal('fetch', vi.fn())` in `beforeEach` and mocks `fetch` by resolving a plain object cast `as Response` — match that exactly, not a real `new Response(...)`):

```ts
  it('maps 409 to a name-conflict message', () => {
    expect(friendlyErrorMessage(new ApiError(409, 'x'))).toBe('這個名稱已經被使用了');
  });
```

Add to `apps/web/test/api/folders.test.ts` (this file's existing tests use `vi.stubGlobal('fetch', vi.fn())` in `beforeEach`, mock resolved values as `{ ok: true, headers: new Headers(...), json: async () => ... } as Response`, and assert by destructuring `vi.mocked(fetch).mock.calls[0]` — match that exactly):

```ts
  it('renameFolder PATCHes a JSON body with the new name', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ id: 'f1', name: 'new-name' }),
    } as Response);

    await renameFolder('f1', 'new-name', 'fake-token');

    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toContain('/folders/f1');
    expect(init?.method).toBe('PATCH');
    expect(JSON.parse(init?.body as string)).toEqual({ name: 'new-name' });
  });

  it('moveFolder PATCHes a JSON body with the new parentId', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ id: 'f1', parentId: 'f2' }),
    } as Response);

    await moveFolder('f1', 'f2', 'fake-token');

    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toContain('/folders/f1');
    expect(init?.method).toBe('PATCH');
    expect(JSON.parse(init?.body as string)).toEqual({ parentId: 'f2' });
  });

  it('deleteFolder DELETEs the folder', async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: true, headers: new Headers() } as Response);

    await deleteFolder('f1', 'fake-token');

    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toContain('/folders/f1');
    expect(init?.method).toBe('DELETE');
  });
```

Add the matching imports (`renameFolder`, `moveFolder`, `deleteFolder`) to that test file's existing import line from `'../../src/api/folders'`.

Add to `apps/web/test/api/documents.test.ts` (same `vi.stubGlobal('fetch', vi.fn())` / destructured-`mock.calls[0]` pattern):

```ts
  it('renameDocument PATCHes a JSON body with the new name', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ id: 'd1', name: 'new.txt' }),
    } as Response);

    await renameDocument('d1', 'new.txt', 'fake-token');

    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toContain('/documents/d1');
    expect(init?.method).toBe('PATCH');
    expect(JSON.parse(init?.body as string)).toEqual({ name: 'new.txt' });
  });

  it('moveDocument PATCHes a JSON body with the new folderId', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ id: 'd1', folderId: 'f2' }),
    } as Response);

    await moveDocument('d1', 'f2', 'fake-token');

    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toContain('/documents/d1');
    expect(init?.method).toBe('PATCH');
    expect(JSON.parse(init?.body as string)).toEqual({ folderId: 'f2' });
  });

  it('deleteDocument DELETEs the document', async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: true, headers: new Headers() } as Response);

    await deleteDocument('d1', 'fake-token');

    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toContain('/documents/d1');
    expect(init?.method).toBe('DELETE');
  });
```

Add the matching imports (`renameDocument`, `moveDocument`, `deleteDocument`) to that test file's existing import line from `'../../src/api/documents'`.

- [ ] **Step 2: Run to verify failure**

```bash
pnpm --filter web exec vitest run test/api/client.test.ts test/api/folders.test.ts test/api/documents.test.ts
```

Expected: FAIL — the new exports don't exist yet.

- [ ] **Step 3: Implement `client.ts`**

In `apps/web/src/api/client.ts`, add a 409 branch to `friendlyErrorMessage`:

```ts
export function friendlyErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 403) return '你沒有存取這個項目的權限';
    if (error.status === 404) return '找不到這個項目';
    if (error.status === 409) return '這個名稱已經被使用了';
  }
  return '發生錯誤，請稍後再試';
}
```

- [ ] **Step 4: Implement `folders.ts`**

In `apps/web/src/api/folders.ts`, add the child-row types and replace `FolderDetail` to use them, then add the three new functions:

```ts
export interface FolderChildSummary extends FolderSummary {
  canManage: boolean;
}

export interface DocumentChildSummary extends DocumentSummary {
  canManage: boolean;
}

export interface FolderDetail extends FolderSummary {
  children: FolderChildSummary[];
  documents: DocumentChildSummary[];
  // Whether the caller has manage-level access — GET /folders/:id only
  // requires 'view', a lower bar, so a caller can see the folder without
  // being allowed to see or edit its ACL.
  canManage: boolean;
}
```

```ts
export function renameFolder(id: string, name: string, accessToken: string) {
  return apiFetch<FolderSummary>(`/folders/${id}`, accessToken, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
}

export function moveFolder(id: string, parentId: string, accessToken: string) {
  return apiFetch<FolderSummary>(`/folders/${id}`, accessToken, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ parentId }),
  });
}

export function deleteFolder(id: string, accessToken: string) {
  return apiFetch<void>(`/folders/${id}`, accessToken, { method: 'DELETE' });
}
```

- [ ] **Step 5: Implement `documents.ts`**

In `apps/web/src/api/documents.ts`, add:

```ts
export function renameDocument(id: string, name: string, accessToken: string) {
  return apiFetch<DocumentDetail>(`/documents/${id}`, accessToken, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
}

export function moveDocument(id: string, folderId: string, accessToken: string) {
  return apiFetch<DocumentDetail>(`/documents/${id}`, accessToken, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ folderId }),
  });
}

export function deleteDocument(id: string, accessToken: string) {
  return apiFetch<void>(`/documents/${id}`, accessToken, { method: 'DELETE' });
}
```

- [ ] **Step 6: Run to verify tests pass**

```bash
pnpm --filter web exec vitest run test/api/client.test.ts test/api/folders.test.ts test/api/documents.test.ts
```

Expected: PASS.

- [ ] **Step 7: Typecheck, and fix the resulting breakage in two other test files**

```bash
pnpm --filter web exec tsc --noEmit
```

`FolderDetail.children`/`.documents` are now typed as `FolderChildSummary[]`/`DocumentChildSummary[]`, each requiring `canManage: boolean`. Two existing test files mock `getFolder` with non-empty `children`/`documents` arrays that predate this field and will now fail to typecheck:

- `apps/web/test/components/ResourcePicker.test.tsx` — every `children: [{ id: 'f2', name: 'Q1', ... }]` and `documents: [{ id: 'd1', name: 'report.pdf', currentVersion: null }]` entry needs `canManage: false` added (ResourcePicker itself never reads this field, so the value doesn't affect any assertion — `false` is just a valid, uniform filler).
- `apps/web/test/components/GrantPermissionForm.test.tsx` — same fix, same file's `children: [{ id: 'f2', name: 'Q1', ... }]` entry.

Add `canManage: false` to each object literal inside those `children`/`documents` arrays (empty arrays `[]` need no change — there's nothing to annotate). Re-run:

```bash
pnpm --filter web exec tsc --noEmit
```

Expected: no errors.

- [ ] **Step 8: Run the full frontend suite once to confirm nothing else broke**

```bash
pnpm --filter web exec vitest run
```

Expected: all suites pass.

- [ ] **Step 9: Commit**

```bash
git add apps/web/src/api/client.ts apps/web/src/api/folders.ts apps/web/src/api/documents.ts apps/web/test/api/client.test.ts apps/web/test/api/folders.test.ts apps/web/test/api/documents.test.ts apps/web/test/components/ResourcePicker.test.tsx apps/web/test/components/GrantPermissionForm.test.tsx
git commit -m "feat(web): API client functions for rename/move/delete"
```

---

### Task 9: `ResourcePicker` — folder-only mode and custom title

**Files:**
- Modify: `apps/web/src/components/ResourcePicker.tsx`
- Test: `apps/web/test/components/ResourcePicker.test.tsx`

**Interfaces:**
- Produces: `ResourcePickerProps` gains `mode?: 'any' | 'folder-only'` (default `'any'`) and `title?: string` (default `'選擇資源'`). Task 12's `MoveButton` consumes both.

- [ ] **Step 1: Write the failing tests**

Add to `apps/web/test/components/ResourcePicker.test.tsx` (it already has `renderPicker`, `listRootFolders`/`getFolder` mocks set up — follow the existing file's exact fixture shapes):

```ts
  it('mode="folder-only" hides documents and does not let them be selected', async () => {
    vi.mocked(listRootFolders).mockResolvedValue([
      { id: 'f1', name: 'Finance', parentId: null, createdBy: 'u', createdAt: '' },
    ]);
    vi.mocked(getFolder).mockResolvedValue({
      id: 'f1',
      name: 'Finance',
      parentId: null,
      createdBy: 'u',
      createdAt: '',
      children: [],
      documents: [{ id: 'd1', name: 'report.pdf', currentVersion: null, canManage: true }],
      canManage: true,
    });

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const onSelect = vi.fn();
    render(
      <QueryClientProvider client={queryClient}>
        <ResourcePicker open={true} onOpenChange={vi.fn()} onSelect={onSelect} mode="folder-only" />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(screen.getByText('Finance')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Finance'));

    await waitFor(() => expect(screen.getByTestId('pick-current-folder')).toBeInTheDocument());
    expect(screen.queryByText('report.pdf')).not.toBeInTheDocument();
  });

  it('renders a custom title when provided', async () => {
    vi.mocked(listRootFolders).mockResolvedValue([]);

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <ResourcePicker open={true} onOpenChange={vi.fn()} onSelect={vi.fn()} title="選擇移動目的地" />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(screen.getByText('選擇移動目的地')).toBeInTheDocument());
  });
```

Note: these two tests construct their own `QueryClientProvider` render (not the `renderPicker` helper) so they can pass the new props — match the existing "resets back to root folders" test's pattern for how it does this in the same file.

- [ ] **Step 2: Run to verify failure**

```bash
pnpm --filter web exec vitest run test/components/ResourcePicker.test.tsx
```

Expected: FAIL — `mode`/`title` props don't exist, so TypeScript will also flag it at typecheck time; the folder-only test's document text will still be found (since nothing hides it yet).

- [ ] **Step 3: Implement**

In `apps/web/src/components/ResourcePicker.tsx`, update `ResourcePickerProps` and the component signature:

```ts
interface ResourcePickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (resource: PickedResource) => void;
  mode?: 'any' | 'folder-only';
  title?: string;
}

export function ResourcePicker({
  open,
  onOpenChange,
  onSelect,
  mode = 'any',
  title = '選擇資源',
}: ResourcePickerProps) {
```

Update the `DialogTitle` to use the new prop:

```tsx
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
```

Wrap the documents `.map(...)` block in a `mode === 'any'` guard:

```tsx
              {mode === 'any' &&
                (folderQuery.data?.documents ?? []).map((doc) => (
                  <li key={doc.id} className="border-b last:border-0">
                    <button
                      className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-sm hover:bg-muted/50"
                      onClick={() =>
                        onSelect({
                          resourceType: 'document',
                          resourceId: doc.id,
                          name: doc.name,
                          path: fullPath,
                        })
                      }
                    >
                      <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                      {doc.name}
                    </button>
                  </li>
                ))}
```

(This is the same block that already exists — only the wrapping `mode === 'any' &&` and switching `.map` to `(...).map` inside a parenthesized expression are new; the JSX contents are unchanged.)

- [ ] **Step 4: Run to verify tests pass**

```bash
pnpm --filter web exec vitest run test/components/ResourcePicker.test.tsx
```

Expected: PASS, full file.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/ResourcePicker.tsx apps/web/test/components/ResourcePicker.test.tsx
git commit -m "feat(web): ResourcePicker folder-only mode and custom title"
```

---

### Task 10: `InlineEditableName` shared component

**Files:**
- Create: `apps/web/src/components/InlineEditableName.tsx`
- Test: `apps/web/test/components/InlineEditableName.test.tsx`

**Interfaces:**
- Produces: `InlineEditableName({ value, onSave, className, ariaLabel, testId }): JSX.Element`. Tasks 13-14 use this for both row-level names and each detail page's own `h1`.

- [ ] **Step 1: Write the failing test**

Create `apps/web/test/components/InlineEditableName.test.tsx`:

```tsx
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { InlineEditableName } from '../../src/components/InlineEditableName';

describe('InlineEditableName', () => {
  it('shows the value as a button until clicked, then shows an editable input', () => {
    render(<InlineEditableName value="財務部" onSave={vi.fn()} ariaLabel="編輯名稱" testId="name" />);

    expect(screen.getByText('財務部')).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('name'));

    expect(screen.getByRole('textbox')).toHaveValue('財務部');
  });

  it('calls onSave with the trimmed new value on Enter', () => {
    const onSave = vi.fn();
    render(<InlineEditableName value="財務部" onSave={onSave} ariaLabel="編輯名稱" testId="name" />);

    fireEvent.click(screen.getByTestId('name'));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '  新名字  ' } });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });

    expect(onSave).toHaveBeenCalledWith('新名字');
  });

  it('does not call onSave if the value is unchanged', () => {
    const onSave = vi.fn();
    render(<InlineEditableName value="財務部" onSave={onSave} ariaLabel="編輯名稱" testId="name" />);

    fireEvent.click(screen.getByTestId('name'));
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });

    expect(onSave).not.toHaveBeenCalled();
  });

  it('discards the draft and does not call onSave on Escape', () => {
    const onSave = vi.fn();
    render(<InlineEditableName value="財務部" onSave={onSave} ariaLabel="編輯名稱" testId="name" />);

    fireEvent.click(screen.getByTestId('name'));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '不要這個' } });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' });

    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.getByText('財務部')).toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
pnpm --filter web exec vitest run test/components/InlineEditableName.test.tsx
```

Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement**

Create `apps/web/src/components/InlineEditableName.tsx`:

```tsx
import { useState } from 'react';

interface InlineEditableNameProps {
  value: string;
  onSave: (newValue: string) => void;
  className?: string;
  ariaLabel: string;
  testId: string;
}

export function InlineEditableName({
  value,
  onSave,
  className,
  ariaLabel,
  testId,
}: InlineEditableNameProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);

  if (!editing) {
    return (
      <button
        type="button"
        className={className}
        data-testid={testId}
        aria-label={ariaLabel}
        onClick={() => {
          setDraft(value);
          setEditing(true);
        }}
      >
        {value}
      </button>
    );
  }

  const commit = () => {
    const trimmed = draft.trim();
    setEditing(false);
    if (trimmed && trimmed !== value) {
      onSave(trimmed);
    }
  };

  return (
    <input
      autoFocus
      className={className}
      data-testid={`${testId}-input`}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.currentTarget.blur();
        }
        if (e.key === 'Escape') {
          setEditing(false);
        }
      }}
    />
  );
}
```

- [ ] **Step 4: Run to verify tests pass**

```bash
pnpm --filter web exec vitest run test/components/InlineEditableName.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/InlineEditableName.tsx apps/web/test/components/InlineEditableName.test.tsx
git commit -m "feat(web): add InlineEditableName shared component"
```

---

### Task 11: `DeleteConfirmDialog` shared component

**Files:**
- Create: `apps/web/src/components/DeleteConfirmDialog.tsx`
- Test: `apps/web/test/components/DeleteConfirmDialog.test.tsx`

**Interfaces:**
- Produces: `DeleteConfirmDialog({ open, onOpenChange, resourceName, onConfirm, isDeleting }): JSX.Element`. Tasks 13-14 use this.

- [ ] **Step 1: Write the failing test**

Create `apps/web/test/components/DeleteConfirmDialog.test.tsx`:

```tsx
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { DeleteConfirmDialog } from '../../src/components/DeleteConfirmDialog';

describe('DeleteConfirmDialog', () => {
  it('shows the resource name and calls onConfirm when the delete button is clicked', () => {
    const onConfirm = vi.fn();
    render(
      <DeleteConfirmDialog
        open={true}
        onOpenChange={vi.fn()}
        resourceName="財務部"
        onConfirm={onConfirm}
      />,
    );

    expect(screen.getByText(/財務部/)).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('confirm-delete'));
    expect(onConfirm).toHaveBeenCalled();
  });

  it('calls onOpenChange(false) when cancel is clicked', () => {
    const onOpenChange = vi.fn();
    render(
      <DeleteConfirmDialog
        open={true}
        onOpenChange={onOpenChange}
        resourceName="財務部"
        onConfirm={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText('取消'));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('disables the delete button while isDeleting is true', () => {
    render(
      <DeleteConfirmDialog
        open={true}
        onOpenChange={vi.fn()}
        resourceName="財務部"
        onConfirm={vi.fn()}
        isDeleting={true}
      />,
    );

    expect(screen.getByTestId('confirm-delete')).toBeDisabled();
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
pnpm --filter web exec vitest run test/components/DeleteConfirmDialog.test.tsx
```

Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement**

Create `apps/web/src/components/DeleteConfirmDialog.tsx`:

```tsx
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';

interface DeleteConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  resourceName: string;
  onConfirm: () => void;
  isDeleting?: boolean;
}

export function DeleteConfirmDialog({
  open,
  onOpenChange,
  resourceName,
  onConfirm,
  isDeleting,
}: DeleteConfirmDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>刪除「{resourceName}」？</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          刪除後這個項目就不會再出現在清單裡，目前介面上還沒有提供還原功能。
        </p>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button
            variant="destructive"
            data-testid="confirm-delete"
            disabled={isDeleting}
            onClick={onConfirm}
          >
            刪除
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 4: Run to verify tests pass**

```bash
pnpm --filter web exec vitest run test/components/DeleteConfirmDialog.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/DeleteConfirmDialog.tsx apps/web/test/components/DeleteConfirmDialog.test.tsx
git commit -m "feat(web): add DeleteConfirmDialog shared component"
```

---

### Task 12: `MoveButton` shared component

**Files:**
- Create: `apps/web/src/components/MoveButton.tsx`
- Test: `apps/web/test/components/MoveButton.test.tsx`

**Interfaces:**
- Consumes: `ResourcePicker` with `mode="folder-only"` (Task 9), `moveFolder`/`moveDocument` (Task 8), `friendlyErrorMessage` (Task 8).
- Produces: `MoveButton({ resourceType, resourceId, onMoved }): JSX.Element`. Tasks 13-14 use this.

- [ ] **Step 1: Write the failing test**

Create `apps/web/test/components/MoveButton.test.tsx`:

```tsx
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useAuth } from 'react-oidc-context';
import { MoveButton } from '../../src/components/MoveButton';
import { listRootFolders, getFolder, moveFolder } from '../../src/api/folders';
import { moveDocument } from '../../src/api/documents';

vi.mock('react-oidc-context', () => ({ useAuth: vi.fn() }));
vi.mock('../../src/api/folders', () => ({
  listRootFolders: vi.fn(),
  getFolder: vi.fn(),
  moveFolder: vi.fn(),
}));
vi.mock('../../src/api/documents', () => ({ moveDocument: vi.fn() }));

function renderMoveButton(props: Partial<Parameters<typeof MoveButton>[0]> = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onMoved = vi.fn();
  return {
    onMoved,
    ...render(
      <QueryClientProvider client={queryClient}>
        <MoveButton resourceType="folder" resourceId="f1" onMoved={onMoved} {...props} />
      </QueryClientProvider>,
    ),
  };
}

describe('MoveButton', () => {
  beforeEach(() => {
    vi.mocked(useAuth).mockReturnValue({
      user: { access_token: 'fake-token' },
    } as unknown as ReturnType<typeof useAuth>);
  });

  it('opens the folder-only ResourcePicker and calls moveFolder with the chosen destination', async () => {
    vi.mocked(listRootFolders).mockResolvedValue([
      { id: 'f2', name: 'Destination', parentId: null, createdBy: 'u', createdAt: '' },
    ]);
    vi.mocked(getFolder).mockResolvedValue({
      id: 'f2',
      name: 'Destination',
      parentId: null,
      createdBy: 'u',
      createdAt: '',
      children: [],
      documents: [],
      canManage: true,
    });
    vi.mocked(moveFolder).mockResolvedValue({
      id: 'f1',
      name: 'Moved',
      parentId: 'f2',
      createdBy: 'u',
      createdAt: '',
    });

    const { onMoved } = renderMoveButton();

    fireEvent.click(screen.getByTestId('move-folder-f1'));
    await waitFor(() => expect(screen.getByText('Destination')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Destination'));
    await waitFor(() => expect(screen.getByTestId('pick-current-folder')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('pick-current-folder'));

    await waitFor(() => expect(moveFolder).toHaveBeenCalledWith('f1', 'f2', 'fake-token'));
    await waitFor(() => expect(onMoved).toHaveBeenCalled());
  });

  it('calls moveDocument (not moveFolder) when resourceType is document', async () => {
    vi.mocked(listRootFolders).mockResolvedValue([
      { id: 'f2', name: 'Destination', parentId: null, createdBy: 'u', createdAt: '' },
    ]);
    vi.mocked(getFolder).mockResolvedValue({
      id: 'f2',
      name: 'Destination',
      parentId: null,
      createdBy: 'u',
      createdAt: '',
      children: [],
      documents: [],
      canManage: true,
    });
    vi.mocked(moveDocument).mockResolvedValue({
      id: 'd1',
      folderId: 'f2',
      name: 'doc.txt',
      currentVersionId: null,
      currentVersion: null,
      createdBy: 'u',
      createdAt: '',
      canManage: true,
    });

    renderMoveButton({ resourceType: 'document', resourceId: 'd1' });

    fireEvent.click(screen.getByTestId('move-document-d1'));
    await waitFor(() => expect(screen.getByText('Destination')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Destination'));
    await waitFor(() => expect(screen.getByTestId('pick-current-folder')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('pick-current-folder'));

    await waitFor(() => expect(moveDocument).toHaveBeenCalledWith('d1', 'f2', 'fake-token'));
  });

  it('shows a friendly error message when the move fails', async () => {
    vi.mocked(listRootFolders).mockResolvedValue([
      { id: 'f2', name: 'Destination', parentId: null, createdBy: 'u', createdAt: '' },
    ]);
    vi.mocked(getFolder).mockResolvedValue({
      id: 'f2',
      name: 'Destination',
      parentId: null,
      createdBy: 'u',
      createdAt: '',
      children: [],
      documents: [],
      canManage: true,
    });
    vi.mocked(moveFolder).mockRejectedValue(new Error('boom'));

    renderMoveButton();

    fireEvent.click(screen.getByTestId('move-folder-f1'));
    await waitFor(() => expect(screen.getByText('Destination')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Destination'));
    await waitFor(() => expect(screen.getByTestId('pick-current-folder')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('pick-current-folder'));

    await waitFor(() => expect(screen.getByText('發生錯誤，請稍後再試')).toBeInTheDocument());
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
pnpm --filter web exec vitest run test/components/MoveButton.test.tsx
```

Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement**

Create `apps/web/src/components/MoveButton.tsx`:

```tsx
import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useAuth } from 'react-oidc-context';
import { FolderInput } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { moveFolder } from '../api/folders';
import { moveDocument } from '../api/documents';
import { friendlyErrorMessage } from '../api/client';
import { ResourcePicker } from './ResourcePicker';

interface MoveButtonProps {
  resourceType: 'folder' | 'document';
  resourceId: string;
  onMoved: () => void;
}

export function MoveButton({ resourceType, resourceId, onMoved }: MoveButtonProps) {
  const auth = useAuth();
  const accessToken = auth.user?.access_token ?? '';
  const [pickerOpen, setPickerOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: (destinationId: string) =>
      resourceType === 'folder'
        ? moveFolder(resourceId, destinationId, accessToken)
        : moveDocument(resourceId, destinationId, accessToken),
    onSuccess: () => {
      setPickerOpen(false);
      onMoved();
    },
    onError: (err) => setError(friendlyErrorMessage(err)),
  });

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        aria-label="移動"
        data-testid={`move-${resourceType}-${resourceId}`}
        onClick={() => {
          setError(null);
          setPickerOpen(true);
        }}
      >
        <FolderInput className="h-4 w-4" />
      </Button>
      <ResourcePicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        mode="folder-only"
        title="選擇移動目的地"
        onSelect={(picked) => mutation.mutate(picked.resourceId)}
      />
      {error && (
        <p className="mt-1 text-xs text-destructive" data-testid={`move-error-${resourceId}`}>
          {error}
        </p>
      )}
    </>
  );
}
```

- [ ] **Step 4: Run to verify tests pass**

```bash
pnpm --filter web exec vitest run test/components/MoveButton.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/MoveButton.tsx apps/web/test/components/MoveButton.test.tsx
git commit -m "feat(web): add MoveButton shared component"
```

---

### Task 13: Wire rename/move/delete into `FolderView`

**Files:**
- Modify: `apps/web/src/routes/FolderView.tsx`
- Test: `apps/web/test/routes/FolderView.test.tsx`

**Interfaces:**
- Consumes: `InlineEditableName` (Task 10), `DeleteConfirmDialog` (Task 11), `MoveButton` (Task 12), `renameFolder`/`deleteFolder`/`renameDocument`/`deleteDocument` (Task 8), `FolderChildSummary`/`DocumentChildSummary` (Task 8).

- [ ] **Step 1: Write the failing tests**

Add to `apps/web/test/routes/FolderView.test.tsx` (it already mocks `getFolder`/`createFolder` from `'../../src/api/folders'` and `uploadDocument` from `'../../src/api/documents'` — extend those `vi.mock` factories to include the new functions used below, and add `canManage: false` to every existing `getFolder` mock's row objects the same way Task 2/canManage work already did for the top-level object, but now also to nested `children`/`documents` array entries):

```tsx
  it('renaming the folder itself via the header calls renameFolder and refetches', async () => {
    vi.mocked(getFolder).mockResolvedValue({
      id: 'folder-1',
      name: 'Finance',
      parentId: null,
      createdBy: 'u',
      createdAt: '',
      children: [],
      documents: [],
      canManage: true,
    });
    vi.mocked(renameFolder).mockResolvedValue({
      id: 'folder-1',
      name: 'Finance',
      parentId: null,
      createdBy: 'u',
      createdAt: '',
    });

    renderWithProviders(<FolderView />, { route: '/folders/folder-1', path: '/folders/:id' });

    await waitFor(() => expect(screen.getByTestId('folder-name')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('folder-name'));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Finance Dept' } });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });

    await waitFor(() =>
      expect(renameFolder).toHaveBeenCalledWith('folder-1', 'Finance Dept', 'fake-token'),
    );
  });

  it('does not show the rename/move/delete header actions when canManage is false', async () => {
    vi.mocked(getFolder).mockResolvedValue({
      id: 'folder-1',
      name: 'Finance',
      parentId: null,
      createdBy: 'u',
      createdAt: '',
      children: [],
      documents: [],
      canManage: false,
    });

    renderWithProviders(<FolderView />, { route: '/folders/folder-1', path: '/folders/:id' });

    await waitFor(() => expect(screen.getByText('Finance')).toBeInTheDocument());
    expect(screen.queryByTestId('folder-name')).not.toBeInTheDocument();
    expect(screen.queryByTestId('delete-folder-folder-1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('move-folder-folder-1')).not.toBeInTheDocument();
  });

  it('shows rename/move/delete actions only on child rows the caller can manage', async () => {
    vi.mocked(getFolder).mockResolvedValue({
      id: 'folder-1',
      name: 'Finance',
      parentId: null,
      createdBy: 'u',
      createdAt: '',
      children: [
        {
          id: 'child-1',
          name: 'Q1',
          parentId: 'folder-1',
          createdBy: 'u',
          createdAt: '',
          canManage: true,
        },
        {
          id: 'child-2',
          name: 'Q2',
          parentId: 'folder-1',
          createdBy: 'u',
          createdAt: '',
          canManage: false,
        },
      ],
      documents: [],
      canManage: true,
    });

    renderWithProviders(<FolderView />, { route: '/folders/folder-1', path: '/folders/:id' });

    await waitFor(() => expect(screen.getByTestId('folder-row-name-child-1')).toBeInTheDocument());
    expect(screen.getByTestId('delete-folder-child-1')).toBeInTheDocument();
    expect(screen.queryByTestId('delete-folder-child-2')).not.toBeInTheDocument();
  });

  it('deleting a child document row calls deleteDocument and refetches the folder', async () => {
    vi.mocked(getFolder).mockResolvedValue({
      id: 'folder-1',
      name: 'Finance',
      parentId: null,
      createdBy: 'u',
      createdAt: '',
      children: [],
      documents: [
        { id: 'doc-1', name: 'report.pdf', currentVersion: null, canManage: true },
      ],
      canManage: true,
    });
    vi.mocked(deleteDocument).mockResolvedValue(undefined);

    renderWithProviders(<FolderView />, { route: '/folders/folder-1', path: '/folders/:id' });

    await waitFor(() => expect(screen.getByTestId('delete-document-doc-1')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('delete-document-doc-1'));
    await waitFor(() => expect(screen.getByTestId('confirm-delete')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('confirm-delete'));

    await waitFor(() => expect(deleteDocument).toHaveBeenCalledWith('doc-1', 'fake-token'));
  });
```

Update the file's `vi.mock` calls at the top to include the new functions:

```ts
vi.mock('../../src/api/folders', () => ({
  getFolder: vi.fn(),
  createFolder: vi.fn(),
  renameFolder: vi.fn(),
  moveFolder: vi.fn(),
  deleteFolder: vi.fn(),
}));
vi.mock('../../src/api/documents', () => ({
  uploadDocument: vi.fn(),
  renameDocument: vi.fn(),
  moveDocument: vi.fn(),
  deleteDocument: vi.fn(),
}));
```

Update the import line to pull in the new mocked functions:

```ts
import { getFolder, renameFolder, deleteFolder } from '../../src/api/folders';
import { deleteDocument } from '../../src/api/documents';
```

Every existing `getFolder`/`getFolder`-mock object literal in this file that has a `children: [...]` or `documents: [...]` array with entries must have `canManage: false` (or `true`, matching the scenario's intent) added to each entry, and every top-level mock object needs `canManage` too if it doesn't already (Task 2/the earlier merge already added this to the top-level object — only the nested array entries are new here).

- [ ] **Step 2: Run to verify failure**

```bash
pnpm --filter web exec vitest run test/routes/FolderView.test.tsx
```

Expected: FAIL — `data-testid="folder-name"` etc. don't exist yet, and TypeScript will flag the missing `canManage` on child/document mock entries once Task 8's types are live (fix those as part of this task's test file, not by loosening the type).

- [ ] **Step 3: Implement**

Replace the full contents of `apps/web/src/routes/FolderView.tsx` with:

```tsx
import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from 'react-oidc-context';
import { Folder, FileText, Trash2 } from 'lucide-react';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import {
  getFolder,
  renameFolder,
  deleteFolder,
  type FolderChildSummary,
  type DocumentChildSummary,
} from '../api/folders';
import { renameDocument, deleteDocument } from '../api/documents';
import { friendlyErrorMessage } from '../api/client';
import { Breadcrumb } from '../components/Breadcrumb';
import { CreateFolderDialog } from '../components/CreateFolderDialog';
import { UploadDialog } from '../components/UploadDialog';
import { InlineEditableName } from '../components/InlineEditableName';
import { DeleteConfirmDialog } from '../components/DeleteConfirmDialog';
import { MoveButton } from '../components/MoveButton';
import { useSetNavbarCrumb } from '../lib/navbarBreadcrumb';

function FolderRow({
  folder,
  onChanged,
}: {
  folder: FolderChildSummary;
  onChanged: () => void;
}) {
  const auth = useAuth();
  const accessToken = auth.user?.access_token ?? '';
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [rowError, setRowError] = useState<string | null>(null);

  const renameMutation = useMutation({
    mutationFn: (name: string) => renameFolder(folder.id, name, accessToken),
    onSuccess: onChanged,
    onError: (err) => setRowError(friendlyErrorMessage(err)),
  });
  const deleteMutation = useMutation({
    mutationFn: () => deleteFolder(folder.id, accessToken),
    onSuccess: () => {
      setConfirmOpen(false);
      onChanged();
    },
    onError: (err) => setRowError(friendlyErrorMessage(err)),
  });

  return (
    <TableRow>
      <TableCell>
        <div className="flex items-center gap-2">
          <Link to={`/folders/${folder.id}`} className="flex items-center gap-2">
            <Folder className="h-4 w-4 text-muted-foreground" />
          </Link>
          {folder.canManage ? (
            <InlineEditableName
              value={folder.name}
              onSave={(name) => renameMutation.mutate(name)}
              ariaLabel="編輯資料夾名稱"
              testId={`folder-row-name-${folder.id}`}
            />
          ) : (
            <Link to={`/folders/${folder.id}`}>{folder.name}</Link>
          )}
        </div>
        {rowError && (
          <p className="mt-1 text-xs text-destructive" data-testid={`folder-row-error-${folder.id}`}>
            {rowError}
          </p>
        )}
      </TableCell>
      <TableCell className="w-0 whitespace-nowrap">
        {folder.canManage && (
          <div className="flex items-center gap-1">
            <MoveButton resourceType="folder" resourceId={folder.id} onMoved={onChanged} />
            <Button
              variant="outline"
              size="sm"
              aria-label="刪除"
              data-testid={`delete-folder-${folder.id}`}
              onClick={() => {
                setRowError(null);
                setConfirmOpen(true);
              }}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
            <DeleteConfirmDialog
              open={confirmOpen}
              onOpenChange={setConfirmOpen}
              resourceName={folder.name}
              isDeleting={deleteMutation.isPending}
              onConfirm={() => deleteMutation.mutate()}
            />
          </div>
        )}
      </TableCell>
    </TableRow>
  );
}

function DocumentRow({
  document,
  onChanged,
}: {
  document: DocumentChildSummary;
  onChanged: () => void;
}) {
  const auth = useAuth();
  const accessToken = auth.user?.access_token ?? '';
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [rowError, setRowError] = useState<string | null>(null);

  const renameMutation = useMutation({
    mutationFn: (name: string) => renameDocument(document.id, name, accessToken),
    onSuccess: onChanged,
    onError: (err) => setRowError(friendlyErrorMessage(err)),
  });
  const deleteMutation = useMutation({
    mutationFn: () => deleteDocument(document.id, accessToken),
    onSuccess: () => {
      setConfirmOpen(false);
      onChanged();
    },
    onError: (err) => setRowError(friendlyErrorMessage(err)),
  });

  return (
    <TableRow>
      <TableCell>
        <div className="flex items-center gap-2">
          <Link to={`/documents/${document.id}`} className="flex items-center gap-2">
            <FileText className="h-4 w-4 text-muted-foreground" />
          </Link>
          {document.canManage ? (
            <InlineEditableName
              value={document.name}
              onSave={(name) => renameMutation.mutate(name)}
              ariaLabel="編輯文件名稱"
              testId={`document-row-name-${document.id}`}
            />
          ) : (
            <Link to={`/documents/${document.id}`}>{document.name}</Link>
          )}
        </div>
        {rowError && (
          <p
            className="mt-1 text-xs text-destructive"
            data-testid={`document-row-error-${document.id}`}
          >
            {rowError}
          </p>
        )}
      </TableCell>
      <TableCell>
        {document.currentVersion ? `v${document.currentVersion.versionNumber}` : '—'}
      </TableCell>
      <TableCell className="w-0 whitespace-nowrap">
        {document.canManage && (
          <div className="flex items-center gap-1">
            <MoveButton resourceType="document" resourceId={document.id} onMoved={onChanged} />
            <Button
              variant="outline"
              size="sm"
              aria-label="刪除"
              data-testid={`delete-document-${document.id}`}
              onClick={() => {
                setRowError(null);
                setConfirmOpen(true);
              }}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
            <DeleteConfirmDialog
              open={confirmOpen}
              onOpenChange={setConfirmOpen}
              resourceName={document.name}
              isDeleting={deleteMutation.isPending}
              onConfirm={() => deleteMutation.mutate()}
            />
          </div>
        )}
      </TableCell>
    </TableRow>
  );
}

export function FolderView() {
  const { id } = useParams<{ id: string }>();
  const auth = useAuth();
  const accessToken = auth.user?.access_token ?? '';
  const folderId = id ?? '';
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const query = useQuery({
    queryKey: ['folder', folderId],
    queryFn: () => getFolder(folderId, accessToken),
    enabled: !!folderId,
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['folder'] });
    queryClient.invalidateQueries({ queryKey: ['rootFolders'] });
  };

  const [headerError, setHeaderError] = useState<string | null>(null);
  const [headerDeleteOpen, setHeaderDeleteOpen] = useState(false);

  const folder = query.data;
  const crumb = useMemo(
    () =>
      folder ? (
        <Breadcrumb currentId={folder.id} currentName={folder.name} parentId={folder.parentId} />
      ) : null,
    [folder],
  );
  useSetNavbarCrumb(crumb);

  const renameMutation = useMutation({
    mutationFn: (name: string) => renameFolder(folderId, name, accessToken),
    onSuccess: invalidate,
    onError: (err) => setHeaderError(friendlyErrorMessage(err)),
  });
  const deleteMutation = useMutation({
    mutationFn: () => deleteFolder(folderId, accessToken),
    onSuccess: () => {
      invalidate();
      navigate(folder?.parentId ? `/folders/${folder.parentId}` : '/');
    },
    onError: (err) => setHeaderError(friendlyErrorMessage(err)),
  });

  if (query.isLoading) return <p data-testid="loading">Loading...</p>;
  if (query.isError) return <p data-testid="error">{friendlyErrorMessage(query.error)}</p>;
  if (!folder) return null;

  return (
    <div className="mx-auto max-w-4xl px-6 py-8">
      <div className="mb-6 flex items-center justify-between gap-3">
        {folder.canManage ? (
          <InlineEditableName
            value={folder.name}
            onSave={(name) => renameMutation.mutate(name)}
            className="text-xl font-bold"
            ariaLabel="編輯資料夾名稱"
            testId="folder-name"
          />
        ) : (
          <h1 className="text-xl font-bold">{folder.name}</h1>
        )}
        <div className="flex gap-2">
          <CreateFolderDialog parentId={folder.id} />
          <UploadDialog mode="new-document" folderId={folder.id} />
          {folder.canManage && (
            <>
              <MoveButton resourceType="folder" resourceId={folder.id} onMoved={invalidate} />
              <Button
                variant="outline"
                data-testid={`delete-folder-${folder.id}`}
                onClick={() => {
                  setHeaderError(null);
                  setHeaderDeleteOpen(true);
                }}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
              <DeleteConfirmDialog
                open={headerDeleteOpen}
                onOpenChange={setHeaderDeleteOpen}
                resourceName={folder.name}
                isDeleting={deleteMutation.isPending}
                onConfirm={() => deleteMutation.mutate()}
              />
              <Link
                to={`/folders/${folder.id}/permissions`}
                className="inline-flex items-center rounded-md border px-3 py-2 text-sm font-medium hover:bg-accent"
              >
                權限
              </Link>
            </>
          )}
        </div>
      </div>
      {headerError && (
        <p className="mb-4 text-sm text-destructive" data-testid="folder-header-error">
          {headerError}
        </p>
      )}

      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        子資料夾
      </h2>
      <div className="mb-8 overflow-hidden rounded-lg border bg-background">
        <Table>
          <TableBody>
            {folder.children.map((child) => (
              <FolderRow key={child.id} folder={child} onChanged={invalidate} />
            ))}
          </TableBody>
        </Table>
      </div>

      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        文件
      </h2>
      <div className="overflow-hidden rounded-lg border bg-background">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>名稱</TableHead>
              <TableHead>目前版本</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {folder.documents.map((document) => (
              <DocumentRow key={document.id} document={document} onChanged={invalidate} />
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run to verify tests pass**

```bash
pnpm --filter web exec vitest run test/routes/FolderView.test.tsx
```

Expected: PASS, full file.

- [ ] **Step 5: Typecheck and run the full frontend suite**

```bash
pnpm --filter web exec tsc --noEmit
pnpm --filter web exec vitest run
```

Expected: no type errors; all suites pass (this will catch any other test file whose `FolderDetail`/`getFolder` mocks are now missing `canManage` on child/document entries — fix each one the same way Task 13's own tests were fixed, adding `canManage: false` or `true` to match the scenario).

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/routes/FolderView.tsx apps/web/test/routes/FolderView.test.tsx
git commit -m "feat(web): wire rename/move/delete into FolderView"
```

---

### Task 14: Wire rename/move/delete into `DocumentView`

**Files:**
- Modify: `apps/web/src/routes/DocumentView.tsx`
- Test: `apps/web/test/routes/DocumentView.test.tsx`

**Interfaces:**
- Consumes: `InlineEditableName`, `DeleteConfirmDialog`, `MoveButton` (Tasks 10-12), `renameDocument`/`deleteDocument` (Task 8).

- [ ] **Step 1: Write the failing tests**

Add to `apps/web/test/routes/DocumentView.test.tsx` (extend its `vi.mock('../../src/api/documents', ...)` factory to add `renameDocument`, `moveDocument`, `deleteDocument`, and import them alongside the existing `getDocument`/`listVersions`/`downloadDocument`):

```ts
vi.mock('../../src/api/documents', () => ({
  getDocument: vi.fn(),
  listVersions: vi.fn(),
  downloadDocument: vi.fn(),
  renameDocument: vi.fn(),
  moveDocument: vi.fn(),
  deleteDocument: vi.fn(),
}));
```

```tsx
  it('renaming the document via the header calls renameDocument and refetches', async () => {
    vi.mocked(getDocument).mockResolvedValue({
      id: 'doc-1',
      folderId: 'folder-1',
      name: 'report.pdf',
      currentVersionId: null,
      currentVersion: null,
      createdBy: 'u',
      createdAt: '',
      canManage: true,
    });
    vi.mocked(listVersions).mockResolvedValue([]);
    vi.mocked(renameDocument).mockResolvedValue({
      id: 'doc-1',
      folderId: 'folder-1',
      name: 'report.pdf',
      currentVersionId: null,
      currentVersion: null,
      createdBy: 'u',
      createdAt: '',
      canManage: true,
    });

    renderWithProviders(<DocumentView />, { route: '/documents/doc-1', path: '/documents/:id' });

    await waitFor(() => expect(screen.getByTestId('document-name')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('document-name'));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'renamed.pdf' } });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });

    await waitFor(() =>
      expect(renameDocument).toHaveBeenCalledWith('doc-1', 'renamed.pdf', 'fake-token'),
    );
  });

  it('does not show the rename/move/delete header actions when canManage is false', async () => {
    vi.mocked(getDocument).mockResolvedValue({
      id: 'doc-1',
      folderId: 'folder-1',
      name: 'report.pdf',
      currentVersionId: null,
      currentVersion: null,
      createdBy: 'u',
      createdAt: '',
      canManage: false,
    });
    vi.mocked(listVersions).mockResolvedValue([]);

    renderWithProviders(<DocumentView />, { route: '/documents/doc-1', path: '/documents/:id' });

    await waitFor(() => expect(screen.getByText('report.pdf')).toBeInTheDocument());
    expect(screen.queryByTestId('document-name')).not.toBeInTheDocument();
    expect(screen.queryByTestId('delete-document-doc-1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('move-document-doc-1')).not.toBeInTheDocument();
  });

  it('deleting the document via the header calls deleteDocument', async () => {
    vi.mocked(getDocument).mockResolvedValue({
      id: 'doc-1',
      folderId: 'folder-1',
      name: 'report.pdf',
      currentVersionId: null,
      currentVersion: null,
      createdBy: 'u',
      createdAt: '',
      canManage: true,
    });
    vi.mocked(listVersions).mockResolvedValue([]);
    vi.mocked(deleteDocument).mockResolvedValue(undefined);

    renderWithProviders(<DocumentView />, { route: '/documents/doc-1', path: '/documents/:id' });

    await waitFor(() => expect(screen.getByTestId('delete-document-doc-1')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('delete-document-doc-1'));
    await waitFor(() => expect(screen.getByTestId('confirm-delete')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('confirm-delete'));

    await waitFor(() => expect(deleteDocument).toHaveBeenCalledWith('doc-1', 'fake-token'));
  });
```

Add `canManage: true`/`false` (matching the existing scenario's intent) to every pre-existing `getDocument` mock object in this file that doesn't already have it.

- [ ] **Step 2: Run to verify failure**

```bash
pnpm --filter web exec vitest run test/routes/DocumentView.test.tsx
```

Expected: FAIL — `data-testid="document-name"` etc. don't exist yet.

- [ ] **Step 3: Implement**

Replace the full contents of `apps/web/src/routes/DocumentView.tsx` with:

```tsx
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from 'react-oidc-context';
import { FileText, Trash2 } from 'lucide-react';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import {
  getDocument,
  listVersions,
  downloadDocument,
  renameDocument,
  deleteDocument,
} from '../api/documents';
import { friendlyErrorMessage } from '../api/client';
import { UploadDialog } from '../components/UploadDialog';
import { InlineEditableName } from '../components/InlineEditableName';
import { DeleteConfirmDialog } from '../components/DeleteConfirmDialog';
import { MoveButton } from '../components/MoveButton';

export function DocumentView() {
  const { id } = useParams<{ id: string }>();
  const auth = useAuth();
  const accessToken = auth.user?.access_token ?? '';
  const documentId = id ?? '';
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const documentQuery = useQuery({
    queryKey: ['document', documentId],
    queryFn: () => getDocument(documentId, accessToken),
    enabled: !!documentId,
  });
  const versionsQuery = useQuery({
    queryKey: ['documentVersions', documentId],
    queryFn: () => listVersions(documentId, accessToken),
    enabled: !!documentId,
  });

  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [headerError, setHeaderError] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['document'] });
    queryClient.invalidateQueries({ queryKey: ['folder'] });
  };

  const renameMutation = useMutation({
    mutationFn: (name: string) => renameDocument(documentId, name, accessToken),
    onSuccess: invalidate,
    onError: (err) => setHeaderError(friendlyErrorMessage(err)),
  });
  const deleteMutation = useMutation({
    mutationFn: () => deleteDocument(documentId, accessToken),
    onSuccess: () => {
      invalidate();
      if (documentQuery.data) {
        navigate(`/folders/${documentQuery.data.folderId}`);
      }
    },
    onError: (err) => setHeaderError(friendlyErrorMessage(err)),
  });

  const handleDownload = async (versionId?: string) => {
    setDownloadError(null);
    try {
      const { blob, fileName } = await downloadDocument(documentId, versionId, accessToken);
      const url = URL.createObjectURL(blob);
      const link = window.document.createElement('a');
      link.href = url;
      link.download = fileName;
      link.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      setDownloadError(friendlyErrorMessage(error));
    }
  };

  if (documentQuery.isLoading) return <p data-testid="loading">Loading...</p>;
  if (documentQuery.isError) {
    return <p data-testid="error">{friendlyErrorMessage(documentQuery.error)}</p>;
  }

  const doc = documentQuery.data;
  if (!doc) return <p data-testid="loading">Loading...</p>;

  return (
    <div className="mx-auto max-w-4xl px-6 py-8">
      <div className="mb-6 overflow-hidden rounded-lg border bg-background">
        <div className="flex items-center justify-between gap-3 border-b px-5 py-4">
          <h1 className="flex items-center gap-2 text-lg font-semibold">
            <FileText className="h-5 w-5 text-muted-foreground" />
            {doc.canManage ? (
              <InlineEditableName
                value={doc.name}
                onSave={(name) => renameMutation.mutate(name)}
                ariaLabel="編輯文件名稱"
                testId="document-name"
              />
            ) : (
              doc.name
            )}
          </h1>
          <div className="flex gap-2">
            <Button data-testid="download-current" onClick={() => handleDownload()}>
              下載目前版本
            </Button>
            <UploadDialog mode="new-version" documentId={documentId} />
            {doc.canManage && (
              <>
                <MoveButton resourceType="document" resourceId={documentId} onMoved={invalidate} />
                <Button
                  variant="outline"
                  size="sm"
                  aria-label="刪除"
                  data-testid={`delete-document-${documentId}`}
                  onClick={() => {
                    setHeaderError(null);
                    setDeleteOpen(true);
                  }}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
                <DeleteConfirmDialog
                  open={deleteOpen}
                  onOpenChange={setDeleteOpen}
                  resourceName={doc.name}
                  isDeleting={deleteMutation.isPending}
                  onConfirm={() => deleteMutation.mutate()}
                />
                <Link
                  to={`/documents/${documentId}/permissions`}
                  className="inline-flex items-center rounded-md border px-3 py-2 text-sm font-medium hover:bg-accent"
                >
                  權限
                </Link>
              </>
            )}
          </div>
        </div>
        {downloadError && (
          <p className="px-5 py-3 text-sm text-destructive" data-testid="download-error">
            {downloadError}
          </p>
        )}
        {headerError && (
          <p className="px-5 py-3 text-sm text-destructive" data-testid="document-header-error">
            {headerError}
          </p>
        )}
      </div>

      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        版本歷史
      </h2>
      {versionsQuery.isLoading && <p data-testid="versions-loading">Loading versions...</p>}
      {versionsQuery.isError && (
        <p data-testid="versions-error">{friendlyErrorMessage(versionsQuery.error)}</p>
      )}
      {versionsQuery.data && (
        <div className="overflow-hidden rounded-lg border bg-background">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>版本</TableHead>
                <TableHead>大小（bytes）</TableHead>
                <TableHead>上傳者</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {versionsQuery.data.map((version) => (
                <TableRow key={version.id}>
                  <TableCell>v{version.versionNumber}</TableCell>
                  <TableCell>{version.sizeBytes}</TableCell>
                  <TableCell>{version.uploadedBy}</TableCell>
                  <TableCell>
                    <Button
                      data-testid={`download-version-${version.id}`}
                      onClick={() => handleDownload(version.id)}
                    >
                      下載此版本
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run to verify tests pass**

```bash
pnpm --filter web exec vitest run test/routes/DocumentView.test.tsx
```

Expected: PASS, full file.

- [ ] **Step 5: Typecheck and run the full frontend suite**

```bash
pnpm --filter web exec tsc --noEmit
pnpm --filter web exec vitest run
```

Expected: no type errors, all suites pass.

- [ ] **Step 6: Run the full backend suite once more (unit + e2e) as a final cross-check**

```bash
pnpm --filter api exec jest
pnpm --filter api exec jest --config ./test/jest-e2e.json
```

Expected: all pass (modulo the two known-flaky audit hash-chain suites in isolation — see Task 5, Step 5).

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/routes/DocumentView.tsx apps/web/test/routes/DocumentView.test.tsx
git commit -m "feat(web): wire rename/move/delete into DocumentView"
```
