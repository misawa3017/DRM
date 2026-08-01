# Phase 2B: Documents, Folders & ACL Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the core document management business logic — folders, documents, versions, and per-resource ACL — on top of Phase 2A's encrypted storage chain and Phase 1's auth foundation, so a document can be uploaded, versioned, downloaded, and access-controlled entirely through the API.

**Architecture:** Five new NestJS modules in `apps/api/src`: `storage` (thin S3-compatible client wrapper around MinIO, using the Phase 2A-provisioned scoped credential), `acl` (permission resolution — the one piece of logic every other module depends on), `folders`, `documents`, `permissions`. All sit on top of the existing `PrismaModule` (global) and `AuthModule`'s JWT guard. Uploaded files are stored in MinIO under `{documentId}/{versionId}` object keys, encrypted via the already-working SSE-KMS chain — the application code never touches encryption directly, it just writes/reads through the S3 API and MinIO/KES/OpenBao handle the rest.

**Tech Stack:** NestJS 10, Prisma 5, `@aws-sdk/client-s3` (S3-compatible client, works against MinIO with `forcePathStyle: true`), `multer` (multipart upload handling via `@nestjs/platform-express`), Jest + Testcontainers (ACL logic), Jest e2e against the live stack (storage + full document flows, following this project's established pattern of not mocking infrastructure it can run for real).

## Global Constraints

- Continue the existing `apps/api` NestJS app — no new app, no new repo structure.
- TypeScript strict mode (existing project-wide constraint, unchanged).
- **Permission levels are hierarchical, not independent flags**: `view < download < edit < manage`. A grant of `edit` implies `view` and `download`. This is a deliberate interpretation of the design spec's `permission_level（view/download/edit/manage）` — the spec doesn't spell out ordering explicitly, but hierarchical is the standard ACL pattern (matches e.g. Google Drive viewer/commenter/editor) and avoids needing multiple grants for one principal.
- **ACL resolution never merges levels across the inheritance chain.** If a resource has ANY explicit permission entry for a principal, that entry's level is used exactly as-is — inheritance from the parent folder only kicks in when the resource has NO explicit entry at all for that principal. This matches the design spec's "文件若無明確 ACL，向上查詢" wording literally.
- **Only the `admin` Keycloak realm role bypasses ACL entirely.** `deptmanager` and `employee` are ordinary principals that need explicit ACL grants like anyone else — the design spec only names Admin as the override.
- **`principalType` supports `user` and `group` at the schema level** (matching the design spec), but this phase only implements resolution/grant logic for `principalType: user`. Keycloak group sync doesn't exist yet (out of scope — no phase has built it). Attempting to grant a `group`-type permission through the API in this phase returns a clear `400 Bad Request` ("group principals are not yet supported"), not silent broken behavior.
- **Root-level folder creation (`parentId: null`) requires the `admin` role** — there's no parent to inherit an edit grant from, so an explicit exception is needed. Subfolder creation requires `edit` on the parent folder.
- **Downloads are proxied through the API, never presigned direct-to-MinIO URLs.** The design spec's key workflows assume every view/download passes through the API's ACL check and (in a later phase) audit logging and watermarking — a presigned URL would bypass all of that.
- MinIO object keys: `{documentId}/{versionId}` (UUIDs) — no folder path embedded, so moving/renaming folders never requires rewriting storage keys.
- Testing: ACL resolution logic gets Testcontainers-based integration tests (real Postgres, following the `user-persistence.spec.ts` pattern from Phase 1). Storage and full document-flow logic gets e2e tests against the **live running docker-compose stack** (following the `whoami.e2e-spec.ts` pattern from Phase 1) — this project does not mock MinIO, Postgres, or Keycloak in integration-level tests.
- Multipart upload size limit: 200MB (a deliberate, generous-but-bounded default — not unlimited).
- Docker daemon on this host is sometimes under load from unrelated processes, causing transient timeouts — retry a timed-out command once before concluding something's actually broken (a recurring, confirmed-benign pattern throughout Phases 1 and 2A).

---

### Task 1: Prisma schema — Folder, Document, DocumentVersion, Permission

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/<timestamp>_documents_folders_acl/migration.sql` (generated)

**Interfaces:**
- Consumes: nothing new.
- Produces: Prisma models `Folder`, `Document`, `DocumentVersion`, `Permission`, and enums `PermissionLevel` (`view`/`download`/`edit`/`manage`), `ResourceType` (`folder`/`document`), `PrincipalType` (`user`/`group`) — all importable from `@prisma/client` once generated.

- [ ] **Step 1: Extend `apps/api/prisma/schema.prisma`**

Append to the existing file (which already has `generator`, `datasource`, and `User`):

```prisma
enum PermissionLevel {
  view
  download
  edit
  manage
}

enum ResourceType {
  folder
  document
}

enum PrincipalType {
  user
  group
}

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

  @@index([parentId])
  @@map("folders")
}

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

  @@index([folderId])
  @@map("documents")
}

model DocumentVersion {
  id            String    @id @default(uuid())
  documentId    String
  document      Document  @relation("DocumentVersions", fields: [documentId], references: [id])
  versionNumber Int
  objectKey     String
  sha256        String
  mimeType      String
  sizeBytes     Int
  uploadedBy    String
  uploadedAt    DateTime  @default(now())
  currentFor    Document? @relation("CurrentVersion")

  @@unique([documentId, versionNumber])
  @@index([documentId])
  @@map("document_versions")
}

model Permission {
  id              String          @id @default(uuid())
  resourceType    ResourceType
  resourceId      String
  principalType   PrincipalType   @default(user)
  principalId     String
  permissionLevel PermissionLevel
  grantedBy       String
  grantedAt       DateTime        @default(now())

  @@unique([resourceType, resourceId, principalType, principalId])
  @@index([resourceType, resourceId])
  @@map("permissions")
}
```

- [ ] **Step 2: Start a local Postgres for migration authoring**

Run: `docker run --rm -d --name drm-dev-postgres -e POSTGRES_USER=drm -e POSTGRES_PASSWORD=drm_dev_password -e POSTGRES_DB=drm -p 5434:5432 postgres:16-alpine`

(Using host port 5434 here, not 5433, since the project's real Postgres from the running compose stack already occupies 5433 — check with `docker compose ps` first and adjust if 5434 is also taken.)

- [ ] **Step 3: Generate the migration**

Run: `cd apps/api && DATABASE_URL="postgresql://drm:drm_dev_password@localhost:5434/drm" pnpm exec prisma migrate dev --name documents_folders_acl`
Expected: creates a new migration directory under `apps/api/prisma/migrations/`, applies cleanly, prints `Your database is now in sync with your schema.`

- [ ] **Step 4: Stop the temporary Postgres**

Run: `docker stop drm-dev-postgres`

- [ ] **Step 5: Regenerate the Prisma client**

Run: `cd apps/api && pnpm exec prisma generate`

- [ ] **Step 6: Verify the project still builds**

Run: `cd apps/api && pnpm run build`
Expected: no TypeScript errors (nothing references the new models yet, so this just confirms the generated client is valid).

- [ ] **Step 7: Commit**

```bash
git add apps/api/prisma
git commit -m "feat(api): add Folder/Document/DocumentVersion/Permission schema"
```

---

### Task 2: StorageService — MinIO client wrapper

**Files:**
- Create: `apps/api/src/storage/storage.service.ts`
- Create: `apps/api/src/storage/storage.module.ts`
- Test: `apps/api/test/storage.e2e-spec.ts`

**Interfaces:**
- Consumes: `MINIO_ENDPOINT`, `MINIO_BUCKET`, `MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY` env vars (already wired into the `api` service by the Phase 2B-prep task).
- Produces: `StorageService.putObject(key: string, body: Buffer, contentType: string): Promise<void>`, `StorageService.getObjectStream(key: string): Promise<Readable>`, exported by `StorageModule`.

- [ ] **Step 1: Add the AWS SDK S3 client dependency**

Add to `apps/api/package.json` `dependencies`:

```json
    "@aws-sdk/client-s3": "^3.658.0",
```

Run: `cd apps/api && pnpm install`

- [ ] **Step 2: Create `apps/api/src/storage/storage.service.ts`**

```ts
import { Injectable } from '@nestjs/common';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import type { Readable } from 'stream';

@Injectable()
export class StorageService {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor() {
    this.bucket = process.env.MINIO_BUCKET ?? 'documents';
    this.client = new S3Client({
      endpoint: process.env.MINIO_ENDPOINT,
      region: 'us-east-1',
      forcePathStyle: true,
      credentials: {
        accessKeyId: process.env.MINIO_ACCESS_KEY ?? '',
        secretAccessKey: process.env.MINIO_SECRET_KEY ?? '',
      },
    });
  }

  async putObject(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  async getObjectStream(key: string): Promise<Readable> {
    const result = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    return result.Body as Readable;
  }
}
```

- [ ] **Step 3: Create `apps/api/src/storage/storage.module.ts`**

```ts
import { Module } from '@nestjs/common';
import { StorageService } from './storage.service';

@Module({
  providers: [StorageService],
  exports: [StorageService],
})
export class StorageModule {}
```

- [ ] **Step 4: Write the e2e test against the live MinIO**

This test runs on the host (not inside a container), so it must reach MinIO via its host-published loopback port (`127.0.0.1:9000`, established in Phase 2A), not the internal Docker-network address the `api` container uses. It uses the real scoped `drm-api` credential from `.env`.

`apps/api/test/storage.e2e-spec.ts`:

```ts
import 'dotenv/config';

process.env.MINIO_ENDPOINT = 'http://127.0.0.1:9000';

import { StorageService } from '../src/storage/storage.service';
import { randomUUID } from 'crypto';

describe('StorageService (e2e, live MinIO)', () => {
  let storage: StorageService;

  beforeAll(() => {
    storage = new StorageService();
  });

  it('round-trips an object through real SSE-KMS encrypted storage', async () => {
    const key = `${randomUUID()}/verify-storage-service.txt`;
    const content = Buffer.from(`storage service e2e check ${new Date().toISOString()}`);

    await storage.putObject(key, content, 'text/plain');

    const stream = await storage.getObjectStream(key);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.from(chunk));
    }
    const downloaded = Buffer.concat(chunks);

    expect(downloaded.equals(content)).toBe(true);
  });

  it('rejects a get for a key that does not exist', async () => {
    await expect(storage.getObjectStream(`${randomUUID()}/does-not-exist.txt`)).rejects.toThrow();
  });
});
```

If `dotenv` isn't already a dependency, add it to `apps/api/package.json` `devDependencies` (`"dotenv": "^16.4.5"`) and run `pnpm install` — the project's `.env` file (gitignored, already exists locally) holds `MINIO_API_ACCESS_KEY`/`MINIO_API_SECRET_KEY`, and this is the simplest way to load it into a test process running outside Docker. Adjust the exact env var names read by `StorageService`'s constructor if this project's `.env` uses different names than `MINIO_ACCESS_KEY`/`MINIO_SECRET_KEY` — check `docker-compose.yml`'s `api` service block for the authoritative mapping (`MINIO_ACCESS_KEY: ${MINIO_API_ACCESS_KEY}`) and set `process.env.MINIO_ACCESS_KEY = process.env.MINIO_API_ACCESS_KEY` etc. in the test's setup if `dotenv` alone doesn't produce the right variable names.

- [ ] **Step 5: Run it**

Precondition: the full stack must be running (`docker compose ps` shows `minio`/`kes`/`openbao` healthy).

Run: `cd apps/api && pnpm test:e2e -- storage`
Expected: PASS (2 tests)

- [ ] **Step 6: Commit**

```bash
git add apps/api/package.json apps/api/pnpm-lock.yaml apps/api/src/storage apps/api/test/storage.e2e-spec.ts
git commit -m "feat(api): add StorageService wrapping MinIO via S3 client"
```

---

### Task 3: AclService — permission resolution

**Files:**
- Create: `apps/api/src/acl/acl.service.ts`
- Create: `apps/api/src/acl/acl.module.ts`
- Test: `apps/api/src/acl/acl.service.spec.ts`

**Interfaces:**
- Consumes: `PrismaService` (global).
- Produces: `AclService.can(user: { id: string; roles: string[] }, resourceType: ResourceType, resourceId: string, required: PermissionLevel): Promise<boolean>`. This is the single function every other module in this phase calls to authorize an action.

- [ ] **Step 1: Write the failing tests**

`apps/api/src/acl/acl.service.spec.ts`:

```ts
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { execSync } from 'child_process';
import { PrismaClient } from '@prisma/client';
import * as path from 'path';
import { AclService } from './acl.service';

describe('AclService', () => {
  let container: StartedPostgreSqlContainer;
  let prisma: PrismaClient;
  let acl: AclService;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    process.env.DATABASE_URL = container.getConnectionUri();
    execSync('pnpm exec prisma migrate deploy', {
      cwd: path.join(__dirname, '..', '..'),
      env: { ...process.env },
      stdio: 'inherit',
    });
    prisma = new PrismaClient();
    acl = new AclService(prisma as any);
  }, 60000);

  afterAll(async () => {
    await prisma.$disconnect();
    await container.stop();
  });

  async function makeFolder(name: string, parentId: string | null = null) {
    return prisma.folder.create({ data: { name, parentId, createdBy: 'seed' } });
  }

  async function makeDocument(folderId: string, name: string) {
    return prisma.document.create({ data: { folderId, name, createdBy: 'seed' } });
  }

  async function grant(
    resourceType: 'folder' | 'document',
    resourceId: string,
    userId: string,
    level: 'view' | 'download' | 'edit' | 'manage',
  ) {
    return prisma.permission.create({
      data: {
        resourceType,
        resourceId,
        principalType: 'user',
        principalId: userId,
        permissionLevel: level,
        grantedBy: 'seed',
      },
    });
  }

  it('denies access when there is no grant anywhere in the chain', async () => {
    const root = await makeFolder('root-1');
    const result = await acl.can({ id: 'user-a', roles: ['employee'] }, 'folder', root.id, 'view');
    expect(result).toBe(false);
  });

  it('allows access via a direct grant on the resource', async () => {
    const root = await makeFolder('root-2');
    await grant('folder', root.id, 'user-b', 'view');
    const result = await acl.can({ id: 'user-b', roles: ['employee'] }, 'folder', root.id, 'view');
    expect(result).toBe(true);
  });

  it('inherits a grant from a parent folder when the child has no explicit ACL', async () => {
    const root = await makeFolder('root-3');
    const child = await makeFolder('child-3', root.id);
    const doc = await makeDocument(child.id, 'doc-3');
    await grant('folder', root.id, 'user-c', 'edit');

    const result = await acl.can({ id: 'user-c', roles: ['employee'] }, 'document', doc.id, 'edit');
    expect(result).toBe(true);
  });

  it('does not merge levels: an explicit lower grant on the resource overrides a higher inherited grant', async () => {
    const root = await makeFolder('root-4');
    const doc = await makeDocument(root.id, 'doc-4');
    await grant('folder', root.id, 'user-d', 'manage');
    await grant('document', doc.id, 'user-d', 'view');

    expect(await acl.can({ id: 'user-d', roles: ['employee'] }, 'document', doc.id, 'view')).toBe(true);
    expect(await acl.can({ id: 'user-d', roles: ['employee'] }, 'document', doc.id, 'edit')).toBe(false);
  });

  it('treats permission levels as hierarchical: edit implies view and download', async () => {
    const root = await makeFolder('root-5');
    await grant('folder', root.id, 'user-e', 'edit');

    expect(await acl.can({ id: 'user-e', roles: ['employee'] }, 'folder', root.id, 'view')).toBe(true);
    expect(await acl.can({ id: 'user-e', roles: ['employee'] }, 'folder', root.id, 'download')).toBe(true);
    expect(await acl.can({ id: 'user-e', roles: ['employee'] }, 'folder', root.id, 'edit')).toBe(true);
    expect(await acl.can({ id: 'user-e', roles: ['employee'] }, 'folder', root.id, 'manage')).toBe(false);
  });

  it('lets the admin role bypass ACL entirely, even with zero grants', async () => {
    const root = await makeFolder('root-6');
    const result = await acl.can({ id: 'user-f', roles: ['admin'] }, 'folder', root.id, 'manage');
    expect(result).toBe(true);
  });

  it('does not let deptmanager or employee roles bypass ACL', async () => {
    const root = await makeFolder('root-7');
    expect(await acl.can({ id: 'user-g', roles: ['deptmanager'] }, 'folder', root.id, 'view')).toBe(false);
  });

  it('fails closed (denies) when the resource does not exist, rather than throwing', async () => {
    const result = await acl.can(
      { id: 'user-i', roles: ['employee'] },
      'folder',
      '00000000-0000-0000-0000-000000000000',
      'view',
    );
    expect(result).toBe(false);
  });

  it('walks up multiple levels of folder nesting to find a grant', async () => {
    const root = await makeFolder('root-8');
    const mid = await makeFolder('mid-8', root.id);
    const leaf = await makeFolder('leaf-8', mid.id);
    await grant('folder', root.id, 'user-h', 'download');

    const result = await acl.can({ id: 'user-h', roles: ['employee'] }, 'folder', leaf.id, 'download');
    expect(result).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/api && pnpm test -- acl.service`
Expected: FAIL — `Cannot find module './acl.service'`

- [ ] **Step 3: Implement `AclService`**

`apps/api/src/acl/acl.service.ts`:

```ts
import { Injectable } from '@nestjs/common';
import { PermissionLevel, ResourceType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

const LEVEL_ORDER: Record<PermissionLevel, number> = {
  view: 1,
  download: 2,
  edit: 3,
  manage: 4,
};

const MAX_FOLDER_DEPTH = 100;

interface AuthenticatedUser {
  id: string;
  roles: string[];
}

@Injectable()
export class AclService {
  constructor(private readonly prisma: PrismaService) {}

  async can(
    user: AuthenticatedUser,
    resourceType: ResourceType,
    resourceId: string,
    required: PermissionLevel,
  ): Promise<boolean> {
    if (user.roles.includes('admin')) {
      return true;
    }
    const level = await this.resolveLevel(user.id, resourceType, resourceId);
    if (!level) {
      return false;
    }
    return LEVEL_ORDER[level] >= LEVEL_ORDER[required];
  }

  async resolveLevel(
    userId: string,
    resourceType: ResourceType,
    resourceId: string,
  ): Promise<PermissionLevel | null> {
    if (resourceType === 'document') {
      const direct = await this.findGrant('document', resourceId, userId);
      if (direct) return direct;

      const doc = await this.prisma.document.findUnique({
        where: { id: resourceId },
        select: { folderId: true },
      });
      if (!doc) return null; // fail closed: a non-existent resource never grants access
      return this.resolveLevel(userId, 'folder', doc.folderId);
    }

    let folderId: string | null = resourceId;
    for (let depth = 0; folderId && depth < MAX_FOLDER_DEPTH; depth++) {
      const direct = await this.findGrant('folder', folderId, userId);
      if (direct) return direct;

      const folder: { parentId: string | null } | null = await this.prisma.folder.findUnique({
        where: { id: folderId },
        select: { parentId: true },
      });
      if (!folder) return null; // fail closed: a non-existent resource never grants access
      folderId = folder.parentId;
    }
    return null;
  }

  private async findGrant(
    resourceType: ResourceType,
    resourceId: string,
    userId: string,
  ): Promise<PermissionLevel | null> {
    const permission = await this.prisma.permission.findUnique({
      where: {
        resourceType_resourceId_principalType_principalId: {
          resourceType,
          resourceId,
          principalType: 'user',
          principalId: userId,
        },
      },
    });
    return permission?.permissionLevel ?? null;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/api && pnpm test -- acl.service`
Expected: PASS (9 tests)

- [ ] **Step 5: Create `apps/api/src/acl/acl.module.ts`**

```ts
import { Module } from '@nestjs/common';
import { AclService } from './acl.service';

@Module({
  providers: [AclService],
  exports: [AclService],
})
export class AclModule {}
```

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/acl
git commit -m "feat(api): add AclService with hierarchical, non-merging permission resolution"
```

---

### Task 4: FoldersModule

**Files:**
- Create: `apps/api/src/folders/folders.controller.ts`
- Create: `apps/api/src/folders/folders.service.ts`
- Create: `apps/api/src/folders/folders.module.ts`
- Modify: `apps/api/src/app.module.ts`
- Test: `apps/api/test/folders.e2e-spec.ts`

**Interfaces:**
- Consumes: `AclService.can`, `PrismaService`, `UsersService.upsertFromToken` (Phase 1, resolves the app-level `User.id` from the JWT payload).
- Produces: `POST /folders` (`{ name: string; parentId?: string }` → `201 { id, name, parentId, createdBy, createdAt }`), `GET /folders/:id` (→ `200 { id, name, parentId, children: Folder[], documents: DocumentSummary[] }`).

- [ ] **Step 1: Create `apps/api/src/folders/folders.service.ts`**

```ts
import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AclService } from '../acl/acl.service';

interface AuthenticatedUser {
  id: string;
  roles: string[];
}

@Injectable()
export class FoldersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly acl: AclService,
  ) {}

  async create(user: AuthenticatedUser, name: string, parentId: string | null) {
    if (parentId === null || parentId === undefined) {
      if (!user.roles.includes('admin')) {
        throw new ForbiddenException('Only admins can create root-level folders');
      }
    } else {
      const allowed = await this.acl.can(user, 'folder', parentId, 'edit');
      if (!allowed) {
        throw new ForbiddenException('You do not have edit access to the parent folder');
      }
    }

    return this.prisma.folder.create({
      data: { name, parentId: parentId ?? null, createdBy: user.id },
    });
  }

  async getWithContents(user: AuthenticatedUser, id: string) {
    const allowed = await this.acl.can(user, 'folder', id, 'view');
    if (!allowed) {
      throw new ForbiddenException('You do not have view access to this folder');
    }

    const folder = await this.prisma.folder.findUnique({
      where: { id },
      include: {
        children: true,
        documents: { include: { currentVersion: true } },
      },
    });
    if (!folder) {
      throw new NotFoundException('Folder not found');
    }
    return folder;
  }
}
```

- [ ] **Step 2: Create `apps/api/src/folders/folders.controller.ts`**

```ts
import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Request } from 'express';
import { FoldersService } from './folders.service';
import { UsersService } from '../users/users.service';

interface AuthenticatedRequest extends Request {
  user: { sub: string; email: string; name: string; roles: string[] };
}

@Controller('folders')
@UseGuards(AuthGuard('jwt'))
export class FoldersController {
  constructor(
    private readonly foldersService: FoldersService,
    private readonly usersService: UsersService,
  ) {}

  @Post()
  async create(@Req() req: AuthenticatedRequest, @Body() body: { name: string; parentId?: string }) {
    const user = await this.usersService.upsertFromToken(req.user);
    return this.foldersService.create(
      { id: user.id, roles: req.user.roles },
      body.name,
      body.parentId ?? null,
    );
  }

  @Get(':id')
  async get(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    const user = await this.usersService.upsertFromToken(req.user);
    return this.foldersService.getWithContents({ id: user.id, roles: req.user.roles }, id);
  }
}
```

- [ ] **Step 3: Create `apps/api/src/folders/folders.module.ts`**

```ts
import { Module } from '@nestjs/common';
import { FoldersController } from './folders.controller';
import { FoldersService } from './folders.service';
import { AclModule } from '../acl/acl.module';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [AclModule, UsersModule],
  controllers: [FoldersController],
  providers: [FoldersService],
  exports: [FoldersService],
})
export class FoldersModule {}
```

`UsersModule` currently only declares `UsersController`/`UsersService` as providers without exporting `UsersService` — check `apps/api/src/users/users.module.ts` and add `exports: [UsersService]` if it's missing, since `FoldersModule` (and later `DocumentsModule`/`PermissionsModule`) need to inject it.

- [ ] **Step 4: Wire `FoldersModule` into `AppModule`**

Add `FoldersModule` to the `imports` array in `apps/api/src/app.module.ts`.

- [ ] **Step 5: Write the e2e test**

`apps/api/test/folders.e2e-spec.ts`:

```ts
import axios from 'axios';

const KEYCLOAK_TOKEN_URL = 'http://auth.drm.localhost/realms/drm/protocol/openid-connect/token';
const API_BASE_URL = 'http://api.drm.localhost';

async function getToken(username: string, password: string): Promise<string> {
  const response = await axios.post(
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
    // This test depends on at least one folder already existing that testuser has no
    // access to. If no such folder exists yet in a fresh environment, this test should
    // first create one using an admin token (see Task 8's realm-export.json addition for
    // a seeded admin test user), then attempt to view it as testuser and expect 403.
    // Adjust once Task 8's admin test user is available — for now this documents the
    // intended check; implement it fully once that fixture exists, or use direct Prisma
    // access in a beforeAll to seed a folder if that's simpler for this task alone.
  });
});
```

The second test is intentionally left as a documented placeholder here because it needs an admin identity to seed a folder the current test user can't see — Task 8 adds that fixture. Implement it for real once Task 8's `testadmin` user exists, or seed the folder directly via Prisma against the live Postgres (`postgresql://drm:drm_dev_password@localhost:5433/drm`) in a `beforeAll` if that's simpler — use your judgment; do not leave a test that doesn't actually assert anything meaningful in the final committed version of this file for Task 4. If you choose the direct-Prisma-seed approach, write the full test now rather than deferring it.

- [ ] **Step 6: Rebuild the API and run the tests**

Run: `docker compose up -d --build api`
Run: `cd apps/api && pnpm test:e2e -- folders`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/folders apps/api/src/app.module.ts apps/api/src/users/users.module.ts apps/api/test/folders.e2e-spec.ts
git commit -m "feat(api): add folders module (create + view, ACL-enforced)"
```

---

### Task 5: DocumentsModule — upload, versioning

**Files:**
- Create: `apps/api/src/documents/documents.controller.ts`
- Create: `apps/api/src/documents/documents.service.ts`
- Create: `apps/api/src/documents/documents.module.ts`
- Modify: `apps/api/src/app.module.ts`
- Test: `apps/api/test/documents-write.e2e-spec.ts`

**Interfaces:**
- Consumes: `AclService.can`, `StorageService.putObject`, `PrismaService`, `UsersService.upsertFromToken`.
- Produces: `POST /documents` (multipart: `file`, body `folderId`, `name` → `201` document + version 1), `POST /documents/:id/versions` (multipart: `file` → `201` new version, updates `currentVersionId`), `GET /documents/:id/versions` (→ `200 DocumentVersion[]`, newest first).

- [ ] **Step 1: Add multer types**

Add to `apps/api/package.json` `devDependencies`: `"@types/multer": "^1.4.12"` (multer itself ships as a transitive dep of `@nestjs/platform-express`, already installed).

Run: `cd apps/api && pnpm install`

- [ ] **Step 2: Create `apps/api/src/documents/documents.service.ts`**

```ts
import { ForbiddenException, Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AclService } from '../acl/acl.service';
import { StorageService } from '../storage/storage.service';

interface AuthenticatedUser {
  id: string;
  roles: string[];
}

interface UploadedFile {
  buffer: Buffer;
  mimetype: string;
}

@Injectable()
export class DocumentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly acl: AclService,
    private readonly storage: StorageService,
  ) {}

  async createDocument(
    user: AuthenticatedUser,
    folderId: string,
    name: string,
    file: UploadedFile,
  ) {
    const allowed = await this.acl.can(user, 'folder', folderId, 'edit');
    if (!allowed) {
      throw new ForbiddenException('You do not have edit access to this folder');
    }

    const documentId = randomUUID();
    const versionId = randomUUID();
    const objectKey = `${documentId}/${versionId}`;
    const sha256 = createHash('sha256').update(file.buffer).digest('hex');

    await this.storage.putObject(objectKey, file.buffer, file.mimetype);

    return this.prisma.$transaction(async (tx) => {
      await tx.document.create({
        data: {
          id: documentId,
          folderId,
          name,
          createdBy: user.id,
        },
      });
      const version = await tx.documentVersion.create({
        data: {
          id: versionId,
          documentId,
          versionNumber: 1,
          objectKey,
          sha256,
          mimeType: file.mimetype,
          sizeBytes: file.buffer.length,
          uploadedBy: user.id,
        },
      });
      return tx.document.update({
        where: { id: documentId },
        data: { currentVersionId: version.id },
        include: { currentVersion: true },
      });
    });
  }

  async addVersion(user: AuthenticatedUser, documentId: string, file: UploadedFile) {
    const allowed = await this.acl.can(user, 'document', documentId, 'edit');
    if (!allowed) {
      throw new ForbiddenException('You do not have edit access to this document');
    }

    const latest = await this.prisma.documentVersion.findFirst({
      where: { documentId },
      orderBy: { versionNumber: 'desc' },
    });
    const nextVersionNumber = (latest?.versionNumber ?? 0) + 1;

    const versionId = randomUUID();
    const objectKey = `${documentId}/${versionId}`;
    const sha256 = createHash('sha256').update(file.buffer).digest('hex');

    await this.storage.putObject(objectKey, file.buffer, file.mimetype);

    const version = await this.prisma.documentVersion.create({
      data: {
        id: versionId,
        documentId,
        versionNumber: nextVersionNumber,
        objectKey,
        sha256,
        mimeType: file.mimetype,
        sizeBytes: file.buffer.length,
        uploadedBy: user.id,
      },
    });

    await this.prisma.document.update({
      where: { id: documentId },
      data: { currentVersionId: version.id },
    });

    return version;
  }

  async listVersions(user: AuthenticatedUser, documentId: string) {
    const allowed = await this.acl.can(user, 'document', documentId, 'view');
    if (!allowed) {
      throw new ForbiddenException('You do not have view access to this document');
    }
    return this.prisma.documentVersion.findMany({
      where: { documentId },
      orderBy: { versionNumber: 'desc' },
    });
  }
}
```

Note the circular-looking `document.create` then `documentVersion.create` then `document.update` sequence inside `$transaction` — this is necessary because `DocumentVersion.documentId` requires the `Document` row to exist first, but `Document.currentVersionId` requires the `DocumentVersion` row to exist first. Creating the document with `currentVersionId` unset, then updating it after the version exists, resolves the circular dependency within one atomic transaction.

- [ ] **Step 3: Create `apps/api/src/documents/documents.controller.ts`**

```ts
import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { AuthGuard } from '@nestjs/passport';
import { Request } from 'express';
import { DocumentsService } from './documents.service';
import { UsersService } from '../users/users.service';

interface AuthenticatedRequest extends Request {
  user: { sub: string; email: string; name: string; roles: string[] };
}

const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;

@Controller('documents')
@UseGuards(AuthGuard('jwt'))
export class DocumentsController {
  constructor(
    private readonly documentsService: DocumentsService,
    private readonly usersService: UsersService,
  ) {}

  @Post()
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_BYTES } }))
  async create(
    @Req() req: AuthenticatedRequest,
    @UploadedFile() file: Express.Multer.File,
    @Body() body: { folderId: string; name: string },
  ) {
    const user = await this.usersService.upsertFromToken(req.user);
    return this.documentsService.createDocument(
      { id: user.id, roles: req.user.roles },
      body.folderId,
      body.name,
      { buffer: file.buffer, mimetype: file.mimetype },
    );
  }

  @Post(':id/versions')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_BYTES } }))
  async addVersion(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    const user = await this.usersService.upsertFromToken(req.user);
    return this.documentsService.addVersion({ id: user.id, roles: req.user.roles }, id, {
      buffer: file.buffer,
      mimetype: file.mimetype,
    });
  }

  @Get(':id/versions')
  async listVersions(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    const user = await this.usersService.upsertFromToken(req.user);
    return this.documentsService.listVersions({ id: user.id, roles: req.user.roles }, id);
  }
}
```

- [ ] **Step 4: Create `apps/api/src/documents/documents.module.ts`**

```ts
import { Module } from '@nestjs/common';
import { DocumentsController } from './documents.controller';
import { DocumentsService } from './documents.service';
import { AclModule } from '../acl/acl.module';
import { StorageModule } from '../storage/storage.module';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [AclModule, StorageModule, UsersModule],
  controllers: [DocumentsController],
  providers: [DocumentsService],
  exports: [DocumentsService],
})
export class DocumentsModule {}
```

- [ ] **Step 5: Wire `DocumentsModule` into `AppModule`**

Add `DocumentsModule` to the `imports` array in `apps/api/src/app.module.ts`.

- [ ] **Step 6: Write the e2e test**

`apps/api/test/documents-write.e2e-spec.ts`:

```ts
import axios from 'axios';
import FormData from 'form-data';

const KEYCLOAK_TOKEN_URL = 'http://auth.drm.localhost/realms/drm/protocol/openid-connect/token';
const API_BASE_URL = 'http://api.drm.localhost';

async function getToken(username: string, password: string): Promise<string> {
  const response = await axios.post(
    KEYCLOAK_TOKEN_URL,
    new URLSearchParams({ grant_type: 'password', client_id: 'drm-web', username, password }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
  );
  return response.data.access_token;
}

describe('Documents write path (e2e)', () => {
  it('a user with edit access can upload a document and a new version', async () => {
    const token = await getToken('testadmin', 'testadminpass');
    const authHeader = { Authorization: `Bearer ${token}` };

    const folderRes = await axios.post(
      `${API_BASE_URL}/folders`,
      { name: `test-folder-${Date.now()}` },
      { headers: authHeader },
    );
    const folderId = folderRes.data.id;

    const form1 = new FormData();
    form1.append('folderId', folderId);
    form1.append('name', 'test-doc.txt');
    form1.append('file', Buffer.from('version one content'), { filename: 'v1.txt' });

    const createRes = await axios.post(`${API_BASE_URL}/documents`, form1, {
      headers: { ...authHeader, ...form1.getHeaders() },
    });
    expect(createRes.status).toBe(201);
    expect(createRes.data.currentVersion.versionNumber).toBe(1);
    const documentId = createRes.data.id;

    const form2 = new FormData();
    form2.append('file', Buffer.from('version two content'), { filename: 'v2.txt' });

    const versionRes = await axios.post(`${API_BASE_URL}/documents/${documentId}/versions`, form2, {
      headers: { ...authHeader, ...form2.getHeaders() },
    });
    expect(versionRes.status).toBe(201);
    expect(versionRes.data.versionNumber).toBe(2);

    const listRes = await axios.get(`${API_BASE_URL}/documents/${documentId}/versions`, {
      headers: authHeader,
    });
    expect(listRes.data).toHaveLength(2);
    expect(listRes.data[0].versionNumber).toBe(2);
  });

  it('a user with no grant cannot upload into a folder they cannot edit', async () => {
    const adminToken = await getToken('testadmin', 'testadminpass');
    const folderRes = await axios.post(
      `${API_BASE_URL}/folders`,
      { name: `locked-folder-${Date.now()}` },
      { headers: { Authorization: `Bearer ${adminToken}` } },
    );

    const employeeToken = await getToken('testuser', 'testpass');
    const form = new FormData();
    form.append('folderId', folderRes.data.id);
    form.append('name', 'nope.txt');
    form.append('file', Buffer.from('should not be allowed'), { filename: 'nope.txt' });

    await expect(
      axios.post(`${API_BASE_URL}/documents`, form, {
        headers: { Authorization: `Bearer ${employeeToken}`, ...form.getHeaders() },
      }),
    ).rejects.toMatchObject({ response: { status: 403 } });
  });
});
```

This test uses `testadmin`/`testadminpass`, a Keycloak user this task assumes exists. If Task 8 hasn't run yet in your execution order, add a minimal `testadmin` user (role `admin`) to `keycloak/realm-export.json` as part of THIS task instead of waiting — check whether it already exists first (`grep testadmin keycloak/realm-export.json`); if not, add it now (same shape as the existing `testuser` entry, `realmRoles: ["admin"]`) and note in your report that you pulled this fixture forward from Task 8. Rebuild Keycloak (`docker compose up -d --build keycloak` — note Keycloak's dev-mode-without-a-fresh-volume caveat from Phase 1: if the realm was already imported once, you may need `docker compose rm -sf keycloak && docker compose up -d keycloak` to force a genuinely fresh import, per the precedent already documented in this project's Phase 1 report history).

Also add `form-data` as a dependency if not present: `apps/api/package.json` `devDependencies`: `"form-data": "^4.0.0"`.

- [ ] **Step 7: Rebuild and run**

Run: `docker compose up -d --build api`
Run: `cd apps/api && pnpm test:e2e -- documents-write`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add apps/api/package.json apps/api/pnpm-lock.yaml apps/api/src/documents apps/api/src/app.module.ts apps/api/test/documents-write.e2e-spec.ts keycloak/realm-export.json
git commit -m "feat(api): add document upload and versioning (ACL-enforced, real MinIO storage)"
```

---

### Task 6: Document read — metadata and download

**Files:**
- Modify: `apps/api/src/documents/documents.controller.ts`
- Modify: `apps/api/src/documents/documents.service.ts`
- Test: `apps/api/test/documents-read.e2e-spec.ts`

**Interfaces:**
- Consumes: `StorageService.getObjectStream`, `AclService.can` (both already available from Task 5).
- Produces: `GET /documents/:id` (→ `200` document metadata + current version), `GET /documents/:id/download?versionId=` (→ streams file bytes, defaults to the current version).

- [ ] **Step 1: Add methods to `DocumentsService`**

Append to `apps/api/src/documents/documents.service.ts`:

```ts
  async getMetadata(user: AuthenticatedUser, documentId: string) {
    const allowed = await this.acl.can(user, 'document', documentId, 'view');
    if (!allowed) {
      throw new ForbiddenException('You do not have view access to this document');
    }
    return this.prisma.document.findUniqueOrThrow({
      where: { id: documentId },
      include: { currentVersion: true },
    });
  }

  async getDownloadStream(user: AuthenticatedUser, documentId: string, versionId?: string) {
    const allowed = await this.acl.can(user, 'document', documentId, 'download');
    if (!allowed) {
      throw new ForbiddenException('You do not have download access to this document');
    }

    const version = versionId
      ? await this.prisma.documentVersion.findFirstOrThrow({
          where: { id: versionId, documentId },
        })
      : await this.prisma.document
          .findUniqueOrThrow({ where: { id: documentId }, include: { currentVersion: true } })
          .then((doc) => {
            if (!doc.currentVersion) {
              throw new Error(`Document ${documentId} has no current version`);
            }
            return doc.currentVersion;
          });

    const stream = await this.storage.getObjectStream(version.objectKey);
    return { stream, mimeType: version.mimeType, fileName: version.id };
  }
```

- [ ] **Step 2: Add controller routes**

Append to `apps/api/src/documents/documents.controller.ts` (add `Query`, `Res` to the imports from `@nestjs/common`, add `Response` to the `express` import):

```ts
  @Get(':id')
  async getMetadata(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    const user = await this.usersService.upsertFromToken(req.user);
    return this.documentsService.getMetadata({ id: user.id, roles: req.user.roles }, id);
  }

  @Get(':id/download')
  async download(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Query('versionId') versionId: string | undefined,
    @Res() res: Response,
  ) {
    const user = await this.usersService.upsertFromToken(req.user);
    const { stream, mimeType, fileName } = await this.documentsService.getDownloadStream(
      { id: user.id, roles: req.user.roles },
      id,
      versionId,
    );
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    stream.pipe(res);
  }
```

- [ ] **Step 3: Write the e2e test**

`apps/api/test/documents-read.e2e-spec.ts`:

```ts
import axios from 'axios';
import FormData from 'form-data';

const KEYCLOAK_TOKEN_URL = 'http://auth.drm.localhost/realms/drm/protocol/openid-connect/token';
const API_BASE_URL = 'http://api.drm.localhost';

async function getToken(username: string, password: string): Promise<string> {
  const response = await axios.post(
    KEYCLOAK_TOKEN_URL,
    new URLSearchParams({ grant_type: 'password', client_id: 'drm-web', username, password }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
  );
  return response.data.access_token;
}

describe('Documents read path (e2e)', () => {
  it('downloads the current version content correctly, and is blocked without a grant', async () => {
    const adminToken = await getToken('testadmin', 'testadminpass');
    const adminHeader = { Authorization: `Bearer ${adminToken}` };

    const folderRes = await axios.post(
      `${API_BASE_URL}/folders`,
      { name: `read-test-${Date.now()}` },
      { headers: adminHeader },
    );

    const content = `download check ${Date.now()}`;
    const form = new FormData();
    form.append('folderId', folderRes.data.id);
    form.append('name', 'readme.txt');
    form.append('file', Buffer.from(content), { filename: 'readme.txt' });
    const createRes = await axios.post(`${API_BASE_URL}/documents`, form, {
      headers: { ...adminHeader, ...form.getHeaders() },
    });
    const documentId = createRes.data.id;

    const downloadRes = await axios.get(`${API_BASE_URL}/documents/${documentId}/download`, {
      headers: adminHeader,
      responseType: 'text',
    });
    expect(downloadRes.data).toBe(content);

    const employeeToken = await getToken('testuser', 'testpass');
    await expect(
      axios.get(`${API_BASE_URL}/documents/${documentId}/download`, {
        headers: { Authorization: `Bearer ${employeeToken}` },
      }),
    ).rejects.toMatchObject({ response: { status: 403 } });
  });
});
```

- [ ] **Step 4: Rebuild and run**

Run: `docker compose up -d --build api`
Run: `cd apps/api && pnpm test:e2e -- documents-read`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/documents apps/api/test/documents-read.e2e-spec.ts
git commit -m "feat(api): add document metadata and download endpoints (ACL-enforced streaming)"
```

---

### Task 7: PermissionsModule — grant, list, revoke

**Files:**
- Create: `apps/api/src/permissions/permissions.controller.ts`
- Create: `apps/api/src/permissions/permissions.service.ts`
- Create: `apps/api/src/permissions/permissions.module.ts`
- Modify: `apps/api/src/app.module.ts`
- Test: `apps/api/test/permissions.e2e-spec.ts`

**Interfaces:**
- Consumes: `AclService.can`, `PrismaService`, `UsersService.upsertFromToken`.
- Produces: `POST /folders/:id/permissions` and `POST /documents/:id/permissions` (body `{ principalType: 'user' | 'group'; principalId: string; permissionLevel: PermissionLevel }` → `201` created grant, `400` if `principalType` is `group`), `GET .../permissions` (→ `200` list), `DELETE .../permissions/:permissionId` (→ `204`) — all requiring `manage` on the target resource.

- [ ] **Step 1: Create `apps/api/src/permissions/permissions.service.ts`**

```ts
import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { PermissionLevel, PrincipalType, ResourceType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AclService } from '../acl/acl.service';

interface AuthenticatedUser {
  id: string;
  roles: string[];
}

@Injectable()
export class PermissionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly acl: AclService,
  ) {}

  async grant(
    user: AuthenticatedUser,
    resourceType: ResourceType,
    resourceId: string,
    principalType: PrincipalType,
    principalId: string,
    permissionLevel: PermissionLevel,
  ) {
    if (principalType === 'group') {
      throw new BadRequestException('group principals are not yet supported');
    }

    const allowed = await this.acl.can(user, resourceType, resourceId, 'manage');
    if (!allowed) {
      throw new ForbiddenException('You do not have manage access to this resource');
    }

    return this.prisma.permission.upsert({
      where: {
        resourceType_resourceId_principalType_principalId: {
          resourceType,
          resourceId,
          principalType,
          principalId,
        },
      },
      update: { permissionLevel, grantedBy: user.id },
      create: {
        resourceType,
        resourceId,
        principalType,
        principalId,
        permissionLevel,
        grantedBy: user.id,
      },
    });
  }

  async list(user: AuthenticatedUser, resourceType: ResourceType, resourceId: string) {
    const allowed = await this.acl.can(user, resourceType, resourceId, 'manage');
    if (!allowed) {
      throw new ForbiddenException('You do not have manage access to this resource');
    }
    return this.prisma.permission.findMany({ where: { resourceType, resourceId } });
  }

  async revoke(
    user: AuthenticatedUser,
    resourceType: ResourceType,
    resourceId: string,
    permissionId: string,
  ) {
    const allowed = await this.acl.can(user, resourceType, resourceId, 'manage');
    if (!allowed) {
      throw new ForbiddenException('You do not have manage access to this resource');
    }
    await this.prisma.permission.delete({ where: { id: permissionId } });
  }
}
```

`upsert` is used for `grant` rather than a plain `create` because the schema's `@@unique([resourceType, resourceId, principalType, principalId])` means granting a second, different level to the same principal on the same resource should update the existing row, not throw a unique-constraint error — this is the natural, expected behavior for "change someone's access level."

- [ ] **Step 2: Create `apps/api/src/permissions/permissions.controller.ts`**

```ts
import { Body, Controller, Delete, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Request } from 'express';
import { PermissionLevel, PrincipalType } from '@prisma/client';
import { PermissionsService } from './permissions.service';
import { UsersService } from '../users/users.service';

interface AuthenticatedRequest extends Request {
  user: { sub: string; email: string; name: string; roles: string[] };
}

interface GrantBody {
  principalType: PrincipalType;
  principalId: string;
  permissionLevel: PermissionLevel;
}

@UseGuards(AuthGuard('jwt'))
@Controller()
export class PermissionsController {
  constructor(
    private readonly permissionsService: PermissionsService,
    private readonly usersService: UsersService,
  ) {}

  @Post('folders/:id/permissions')
  async grantOnFolder(@Req() req: AuthenticatedRequest, @Param('id') id: string, @Body() body: GrantBody) {
    const user = await this.usersService.upsertFromToken(req.user);
    return this.permissionsService.grant(
      { id: user.id, roles: req.user.roles },
      'folder',
      id,
      body.principalType,
      body.principalId,
      body.permissionLevel,
    );
  }

  @Get('folders/:id/permissions')
  async listOnFolder(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    const user = await this.usersService.upsertFromToken(req.user);
    return this.permissionsService.list({ id: user.id, roles: req.user.roles }, 'folder', id);
  }

  @Delete('folders/:id/permissions/:permissionId')
  async revokeOnFolder(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Param('permissionId') permissionId: string,
  ) {
    const user = await this.usersService.upsertFromToken(req.user);
    await this.permissionsService.revoke({ id: user.id, roles: req.user.roles }, 'folder', id, permissionId);
    return { success: true };
  }

  @Post('documents/:id/permissions')
  async grantOnDocument(@Req() req: AuthenticatedRequest, @Param('id') id: string, @Body() body: GrantBody) {
    const user = await this.usersService.upsertFromToken(req.user);
    return this.permissionsService.grant(
      { id: user.id, roles: req.user.roles },
      'document',
      id,
      body.principalType,
      body.principalId,
      body.permissionLevel,
    );
  }

  @Get('documents/:id/permissions')
  async listOnDocument(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    const user = await this.usersService.upsertFromToken(req.user);
    return this.permissionsService.list({ id: user.id, roles: req.user.roles }, 'document', id);
  }

  @Delete('documents/:id/permissions/:permissionId')
  async revokeOnDocument(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Param('permissionId') permissionId: string,
  ) {
    const user = await this.usersService.upsertFromToken(req.user);
    await this.permissionsService.revoke({ id: user.id, roles: req.user.roles }, 'document', id, permissionId);
    return { success: true };
  }
}
```

- [ ] **Step 3: Create `apps/api/src/permissions/permissions.module.ts`**

```ts
import { Module } from '@nestjs/common';
import { PermissionsController } from './permissions.controller';
import { PermissionsService } from './permissions.service';
import { AclModule } from '../acl/acl.module';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [AclModule, UsersModule],
  controllers: [PermissionsController],
  providers: [PermissionsService],
})
export class PermissionsModule {}
```

- [ ] **Step 4: Wire into `AppModule`**

Add `PermissionsModule` to `apps/api/src/app.module.ts`.

- [ ] **Step 5: Write the e2e test**

`apps/api/test/permissions.e2e-spec.ts`:

```ts
import axios from 'axios';

const KEYCLOAK_TOKEN_URL = 'http://auth.drm.localhost/realms/drm/protocol/openid-connect/token';
const API_BASE_URL = 'http://api.drm.localhost';

async function getToken(username: string, password: string): Promise<string> {
  const response = await axios.post(
    KEYCLOAK_TOKEN_URL,
    new URLSearchParams({ grant_type: 'password', client_id: 'drm-web', username, password }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
  );
  return response.data.access_token;
}

async function whoami(token: string) {
  const res = await axios.get(`${API_BASE_URL}/whoami`, { headers: { Authorization: `Bearer ${token}` } });
  return res.data as { id: string };
}

describe('Permissions (e2e)', () => {
  it('grants view access to another user, who can then see the folder but not manage it', async () => {
    const adminToken = await getToken('testadmin', 'testadminpass');
    const adminHeader = { Authorization: `Bearer ${adminToken}` };

    const folderRes = await axios.post(
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
    const folderRes = await axios.post(
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
});
```

- [ ] **Step 6: Rebuild and run**

Run: `docker compose up -d --build api`
Run: `cd apps/api && pnpm test:e2e -- permissions`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/permissions apps/api/src/app.module.ts apps/api/test/permissions.e2e-spec.ts
git commit -m "feat(api): add permissions module (grant/list/revoke, manage-gated)"
```

---

### Task 8: Seed a second test identity and run full-suite verification

**Files:**
- Modify: `keycloak/realm-export.json` (only if Task 5 didn't already add `testadmin` — check first)
- Create: `docs/superpowers/plans/2026-08-01-phase2b-verification.md`

**Interfaces:**
- Consumes: everything from Tasks 1-7.
- Produces: a written, repeatable verification record for Phase 2B, plus confirmation every automated suite passes together (not just individually, task by task).

- [ ] **Step 1: Confirm `testadmin` exists in the realm**

Run: `grep -A3 testadmin keycloak/realm-export.json`
If it's missing (Task 5's implementer didn't need to add it because they seeded the folder differently, or you're executing tasks out of order), add it now to the `users` array in `keycloak/realm-export.json`, matching the existing `testuser` entry's shape but with `"username": "testadmin"`, `"email": "testadmin@example.com"`, a `password` credential of `testadminpass`, and `"realmRoles": ["admin"]`. Force a fresh Keycloak realm import (`docker compose rm -sf keycloak && docker compose up -d keycloak`, per the established precedent for realm-config changes in this project) and confirm via a token request that `testadmin` can log in and carries the `admin` role.

- [ ] **Step 2: Run every automated suite together, fresh**

Run: `docker compose down -v && docker compose up -d --build`
Wait for all services healthy (Keycloak cold start ~90-170s under host load).
Run: `./scripts/smoke-test.sh`
Run: `pnpm --filter api test`
Run: `pnpm --filter api test:e2e`
Run: `pnpm --filter web test`

All must pass. If anything that passed in isolation during its own task now fails when run alongside everything else (e.g., test data collisions between `folders.e2e-spec.ts` and `documents-write.e2e-spec.ts` both creating folders with similar names, or Testcontainers port conflicts under load), fix it — this is exactly the kind of integration issue individual task-level testing can miss.

- [ ] **Step 3: Manual end-to-end walkthrough**

Using `curl` or a REST client, walk through the full flow once by hand as a sanity check beyond the automated suites: log in as `testadmin`, create a root folder, upload a document into it, download it back and confirm the bytes match, upload a second version, grant `view` to `testuser`, log in as `testuser` and confirm they can view but not edit or manage, revoke the grant, confirm `testuser` is locked out again.

- [ ] **Step 4: Write `docs/superpowers/plans/2026-08-01-phase2b-verification.md`**

Record what was checked in Steps 2-3 (suite results, and a short narrative of the manual walkthrough), following the same format as `docs/superpowers/plans/2026-07-31-phase1-verification.md`.

- [ ] **Step 5: Commit**

```bash
git add keycloak/realm-export.json docs/superpowers/plans/2026-08-01-phase2b-verification.md
git commit -m "docs: add Phase 2B verification record, confirm testadmin fixture"
```

---

## Self-Review Notes

- **Spec coverage:** Covers the design spec's folders/documents/document_versions/permissions tables and the "上傳"/"檢視/下載"/"版本管理" workflows for the scope this phase owns. Explicitly deferred (per the design spec's own phasing, agreed earlier): audit logging (`audit_logs` table, Phase 3), watermarking, Office-to-PDF conversion, expiration/auto-invalidation, virus scanning (all Phase 4 — none of `documents.expires_at`/`documents.watermark_enabled` are added to the schema yet, since nothing in this phase reads or writes them; adding unused columns now would be speculative).
- **Placeholder scan:** One intentional soft spot flagged explicitly rather than silently guessed: Task 4's second e2e test is written as a documented placeholder with clear instructions to either seed via Prisma directly or wait for Task 8's `testadmin` fixture — the plan requires it be resolved for real before that task is considered done, not left as dead code.
- **Type consistency:** `AclService.can(user, resourceType, resourceId, required)` signature is defined once in Task 3 and used identically by `FoldersService`, `DocumentsService`, and `PermissionsService`. The `{ id: string; roles: string[] }` authenticated-user shape is consistent across every service. `PermissionLevel`/`ResourceType`/`PrincipalType` enum values (`view`/`download`/`edit`/`manage`, `folder`/`document`, `user`/`group`) are defined once in Task 1's schema and referenced identically everywhere.
- **Scope:** Business logic only, built entirely on Phase 2A's already-verified storage chain and Phase 1's already-verified auth — no new infrastructure services introduced in this plan.
