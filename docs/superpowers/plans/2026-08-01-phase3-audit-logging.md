# Phase 3: Audit Logging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every sensitive action against a folder, document, or permission grant is recorded in a tamper-evident, hash-chained `audit_logs` table, and the chain can be independently verified end-to-end.

**Architecture:** A new `AuditModule` (`AuditService` + `AuditController`) sits alongside the existing `FoldersModule`/`DocumentsModule`/`PermissionsModule`. Each of those services gets an `AuditService` dependency and calls `record(...)` after a state-changing or sensitive-read operation succeeds. Hash-chain writes are serialized with a Postgres advisory lock so concurrent requests can never fork the chain. Real client IP capture requires trusting Traefik as this app's sole reverse proxy (`app.set('trust proxy', true)` in `main.ts`).

**Tech Stack:** NestJS 10, Prisma 5, Node's built-in `crypto` (SHA-256), Jest + Testcontainers (chain integrity, including a concurrency test).

## Global Constraints

- **Action taxonomy is a concrete mapping of the design spec's seven Chinese categories (上傳/檢視/下載/編輯/刪除/權限變更/到期) onto this codebase's actual operations**, not a literal transcription — deliberately scoped to only what exists after Phase 2B:
  - `folder_create`, `folder_view` (folder creation and `GET /folders/:id`)
  - `document_create`, `document_version_upload` (both "上傳"), `document_view` (covers both `GET /documents/:id` metadata and `GET /documents/:id/versions` — both are read operations on the same resource, not split into two actions), `document_download` ("下載")
  - `permission_grant`, `permission_revoke` (both "權限變更")
  - "刪除" (delete) and "到期" (expire) are explicitly NOT in this enum — no delete or expiration endpoint exists anywhere in the codebase yet (delete is out of scope entirely so far; expiration is Phase 4). Adding audit actions for operations that can't happen yet would be speculative. Extend the enum when those operations are actually built.
  - Listing permissions (`GET .../permissions`) is deliberately NOT audited in this phase — the state-changing grant/revoke events are what matters most for compliance; auditing every read of the ACL list is a reasonable future addition, not required now.
- **The hash chain must be strictly linear under concurrency.** Two simultaneous audit writes must never both read the same "latest" hash and insert two rows claiming the same `prevHash` — that would fork the chain and break end-to-end verification. Every write acquires a Postgres advisory lock (`pg_advisory_xact_lock`, held for the transaction) before reading the current chain tip and inserting, serializing all audit writes application-wide. Audit writes are not this app's throughput bottleneck, so global serialization is an acceptable, simple correctness guarantee — do not replace it with an unserialized "good enough" version.
- **Ordering for the chain must not depend on `createdAt` alone** (timestamp collisions are possible under load, and this project has already observed a single-CPU host running under contention from unrelated processes). `AuditLog` gets an auto-incrementing `sequence` column used for both "find the chain tip" and "walk the chain in order" — never `orderBy: { createdAt: ... }` for chain-critical operations.
- **Hash input is a fixed, deterministic, pipe-delimited string** — `id|actorId|action|resourceType|resourceId|ipAddress|createdAt(ISO)|prevHash` — not JSON (JSON key-ordering determinism is a real footgun; avoiding it entirely is simpler than getting it right). `createdAt` is generated in application code (`new Date()`) before the insert, not left to a DB `@default(now())`, so the exact timestamp used in the hash matches what's stored byte-for-byte.
- **IP capture requires `app.set('trust proxy', true)` in `main.ts`.** This project's Phase 1 final review flagged this exact gap ("`req.ip` reflects Traefik's address, not the real client") as deferred until IP was actually consumed by something — it's consumed now. Traefik is the sole entry point into the `api` service (confirmed: no other route reaches it directly, `docker-compose.yml`'s `api` service has no published port), so trusting all proxies is safe here — document this reasoning in a code comment, since `trust proxy: true` is a footgun in a topology with untrusted intermediate proxies (not this one).
- Real integration tests: `AclService`-style Testcontainers tests for `AuditService`'s chain logic (including a genuine concurrency test — fire multiple `record()` calls concurrently and confirm the chain is still strictly linear afterward), e2e tests against the live stack for the audit trail actually being populated by real operations.
- Docker daemon on this host is sometimes under load from unrelated processes, and this session has repeatedly hit disk-space stalls during `docker compose build` — check `df -h /` and `docker builder prune -f` if a build hangs unusually long. Verify a container was actually recreated after any rebuild (check image ID/start time), not just that the build command exited 0.

---

### Task 1: AuditLog schema

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/<timestamp>_audit_logs/migration.sql` (generated)

**Interfaces:**
- Consumes: nothing new.
- Produces: `AuditLog` model and `AuditAction` enum (8 values, see Global Constraints), importable from `@prisma/client`.

- [ ] **Step 1: Extend `apps/api/prisma/schema.prisma`**

```prisma
enum AuditAction {
  folder_create
  folder_view
  document_create
  document_view
  document_download
  document_version_upload
  permission_grant
  permission_revoke
}

model AuditLog {
  id           String       @id @default(uuid())
  sequence     BigInt       @default(autoincrement())
  actorId      String
  action       AuditAction
  resourceType ResourceType
  resourceId   String
  ipAddress    String?
  prevHash     String?
  hash         String
  createdAt    DateTime

  @@unique([sequence])
  @@index([resourceType, resourceId])
  @@index([actorId])
  @@map("audit_logs")
}
```

- [ ] **Step 2: Start a temporary local Postgres for migration authoring**

Run: `docker run --rm -d --name drm-dev-postgres -e POSTGRES_USER=drm -e POSTGRES_PASSWORD=drm_dev_password -e POSTGRES_DB=drm -p 5435:5432 postgres:16-alpine`

(Port 5435 — 5433 is the project's real Postgres, 5434 was used by Phase 2B's Task 1 migration authoring; check `docker compose ps` and adjust if 5435 is also taken.)

- [ ] **Step 3: Generate the migration**

Run: `cd apps/api && DATABASE_URL="postgresql://drm:drm_dev_password@localhost:5435/drm" pnpm exec prisma migrate dev --name audit_logs`

- [ ] **Step 4: Stop the temporary Postgres**

Run: `docker stop drm-dev-postgres`

- [ ] **Step 5: Regenerate the client and verify the build**

Run: `cd apps/api && pnpm exec prisma generate && pnpm run build`
Expected: no TypeScript errors.

- [ ] **Step 6: Commit**

```bash
git add apps/api/prisma
git commit -m "feat(api): add AuditLog schema with hash-chain fields"
```

---

### Task 2: AuditService — hash-chained, concurrency-safe recording and verification

**Files:**
- Create: `apps/api/src/audit/audit.service.ts`
- Create: `apps/api/src/audit/audit.module.ts`
- Test: `apps/api/src/audit/audit.service.spec.ts`

**Interfaces:**
- Consumes: `PrismaService`.
- Produces: `AuditService.record(entry: { actorId: string; action: AuditAction; resourceType: ResourceType; resourceId: string; ipAddress: string | null }): Promise<AuditLog>`, `AuditService.verifyChain(): Promise<{ valid: boolean; brokenAtId?: string }>`, `AuditService.listForResource(resourceType: ResourceType, resourceId: string): Promise<AuditLog[]>`.

- [ ] **Step 1: Write the failing tests**

`apps/api/src/audit/audit.service.spec.ts`:

```ts
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { execSync } from 'child_process';
import { PrismaClient } from '@prisma/client';
import * as path from 'path';
import { AuditService } from './audit.service';

describe('AuditService', () => {
  let container: StartedPostgreSqlContainer;
  let prisma: PrismaClient;
  let audit: AuditService;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    process.env.DATABASE_URL = container.getConnectionUri();
    execSync('pnpm exec prisma migrate deploy', {
      cwd: path.join(__dirname, '..', '..'),
      env: { ...process.env },
      stdio: 'inherit',
    });
    prisma = new PrismaClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument -- constructing AuditService directly against a raw PrismaClient for the test, matching this project's established AclService test pattern
    audit = new AuditService(prisma as any);
  }, 60000);

  afterAll(async () => {
    await prisma.$disconnect();
    await container.stop();
  });

  it('the first entry has a null prevHash and a real hash', async () => {
    const entry = await audit.record({
      actorId: 'user-a',
      action: 'folder_create',
      resourceType: 'folder',
      resourceId: 'folder-1',
      ipAddress: '10.0.0.1',
    });
    expect(entry.prevHash).toBeNull();
    expect(entry.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('chains each subsequent entry to the previous one\'s hash', async () => {
    const first = await audit.record({
      actorId: 'user-b',
      action: 'folder_create',
      resourceType: 'folder',
      resourceId: 'folder-2',
      ipAddress: null,
    });
    const second = await audit.record({
      actorId: 'user-b',
      action: 'folder_view',
      resourceType: 'folder',
      resourceId: 'folder-2',
      ipAddress: null,
    });
    expect(second.prevHash).toBe(first.hash);
  });

  it('verifyChain reports valid for an untampered chain', async () => {
    await audit.record({
      actorId: 'user-c',
      action: 'document_view',
      resourceType: 'document',
      resourceId: 'doc-1',
      ipAddress: '10.0.0.2',
    });
    const result = await audit.verifyChain();
    expect(result.valid).toBe(true);
  });

  it('verifyChain detects a tampered row', async () => {
    const entry = await audit.record({
      actorId: 'user-d',
      action: 'document_download',
      resourceType: 'document',
      resourceId: 'doc-2',
      ipAddress: '10.0.0.3',
    });

    await prisma.auditLog.update({
      where: { id: entry.id },
      data: { actorId: 'user-d-tampered' },
    });

    const result = await audit.verifyChain();
    expect(result.valid).toBe(false);
    expect(result.brokenAtId).toBe(entry.id);
  });

  it('serializes concurrent writes into a single strictly linear chain', async () => {
    const concurrentWrites = Array.from({ length: 10 }, (_, i) =>
      audit.record({
        actorId: `concurrent-user-${i}`,
        action: 'folder_view',
        resourceType: 'folder',
        resourceId: 'folder-concurrent',
        ipAddress: null,
      }),
    );
    await Promise.all(concurrentWrites);

    const result = await audit.verifyChain();
    expect(result.valid).toBe(true);
  });

  it('listForResource returns only entries for that resource, in order', async () => {
    await audit.record({
      actorId: 'user-e',
      action: 'document_view',
      resourceType: 'document',
      resourceId: 'doc-list-test',
      ipAddress: null,
    });
    await audit.record({
      actorId: 'user-e',
      action: 'document_download',
      resourceType: 'document',
      resourceId: 'doc-list-test',
      ipAddress: null,
    });
    await audit.record({
      actorId: 'user-e',
      action: 'document_view',
      resourceType: 'document',
      resourceId: 'doc-unrelated',
      ipAddress: null,
    });

    const entries = await audit.listForResource('document', 'doc-list-test');
    expect(entries).toHaveLength(2);
    expect(entries[0].action).toBe('document_view');
    expect(entries[1].action).toBe('document_download');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/api && pnpm test -- audit.service`
Expected: FAIL — `Cannot find module './audit.service'`

- [ ] **Step 3: Implement `AuditService`**

`apps/api/src/audit/audit.service.ts`:

```ts
import { Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'crypto';
import { AuditAction, AuditLog, Prisma, ResourceType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

const AUDIT_CHAIN_LOCK_KEY = 727310;

interface RecordAuditEntry {
  actorId: string;
  action: AuditAction;
  resourceType: ResourceType;
  resourceId: string;
  ipAddress: string | null;
}

interface HashInput {
  id: string;
  actorId: string;
  action: AuditAction;
  resourceType: ResourceType;
  resourceId: string;
  ipAddress: string | null;
  createdAt: Date;
  prevHash: string | null;
}

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async record(entry: RecordAuditEntry): Promise<AuditLog> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${AUDIT_CHAIN_LOCK_KEY})`;

      const last = await tx.auditLog.findFirst({ orderBy: { sequence: 'desc' } });
      const prevHash = last?.hash ?? null;

      const id = randomUUID();
      const createdAt = new Date();
      const hash = this.computeHash({ id, ...entry, createdAt, prevHash });

      return tx.auditLog.create({
        data: { id, ...entry, createdAt, prevHash, hash },
      });
    });
  }

  async verifyChain(): Promise<{ valid: boolean; brokenAtId?: string }> {
    const rows = await this.prisma.auditLog.findMany({ orderBy: { sequence: 'asc' } });
    let expectedPrevHash: string | null = null;

    for (const row of rows) {
      if (row.prevHash !== expectedPrevHash) {
        return { valid: false, brokenAtId: row.id };
      }
      const recomputed = this.computeHash({
        id: row.id,
        actorId: row.actorId,
        action: row.action,
        resourceType: row.resourceType,
        resourceId: row.resourceId,
        ipAddress: row.ipAddress,
        createdAt: row.createdAt,
        prevHash: row.prevHash,
      });
      if (recomputed !== row.hash) {
        return { valid: false, brokenAtId: row.id };
      }
      expectedPrevHash = row.hash;
    }

    return { valid: true };
  }

  async listForResource(resourceType: ResourceType, resourceId: string): Promise<AuditLog[]> {
    return this.prisma.auditLog.findMany({
      where: { resourceType, resourceId },
      orderBy: { sequence: 'asc' },
    });
  }

  private computeHash(input: HashInput): string {
    const raw = [
      input.id,
      input.actorId,
      input.action,
      input.resourceType,
      input.resourceId,
      input.ipAddress ?? '',
      input.createdAt.toISOString(),
      input.prevHash ?? '',
    ].join('|');
    return createHash('sha256').update(raw).digest('hex');
  }
}
```

`Prisma` is imported but only used for its namespace types if your editor/tsc flags an unused import — remove it if `tx`'s inferred type doesn't need an explicit `Prisma.TransactionClient` annotation; keep the code compiling cleanly either way.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/api && pnpm test -- audit.service`
Expected: PASS (6 tests). The concurrency test is the one most likely to reveal a real bug if the advisory lock isn't actually serializing writes — if it fails intermittently, that's a real correctness problem to fix, not a flaky test to retry away.

- [ ] **Step 5: Create `apps/api/src/audit/audit.module.ts`**

```ts
import { Module } from '@nestjs/common';
import { AuditService } from './audit.service';

@Module({
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
```

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/audit
git commit -m "feat(api): add AuditService with concurrency-safe hash-chained recording"
```

---

### Task 3: Trust proxy config + wire audit logging into FoldersModule

**Files:**
- Modify: `apps/api/src/main.ts`
- Modify: `apps/api/src/folders/folders.controller.ts`
- Modify: `apps/api/src/folders/folders.service.ts`
- Modify: `apps/api/src/folders/folders.module.ts`
- Test: `apps/api/test/audit-folders.e2e-spec.ts`

**Interfaces:**
- Consumes: `AuditService.record` (Task 2).
- Produces: `req.ip` across the whole app now reflects the real client IP (not Traefik's) — set up once here, reused by Tasks 4-5 without repeating the config. `FoldersService.create`/`.getWithContents` now accept a trailing `ipAddress: string | null` parameter and record `folder_create`/`folder_view` audit entries after success.

This task does the trust-proxy setup AND the first module's audit wiring together (not as two separate tasks), specifically so there's no intermediate commit where the code doesn't compile — `req.ip` capture and the service methods that consume it land in the same task.

- [ ] **Step 1: Configure trust proxy in `apps/api/src/main.ts`**

Add before `app.listen(...)`:

```ts
  // Traefik is the sole entry point into this service — docker-compose.yml
  // publishes no other route directly to `api`, so trusting all proxies is
  // safe here and lets req.ip reflect the real client address (forwarded by
  // Traefik via X-Forwarded-For) instead of Traefik's own container IP.
  app.set('trust proxy', true);
```

- [ ] **Step 2: Update `FoldersService` to accept `ipAddress` and record audit entries**

```ts
import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
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
    }

    const folder = await this.prisma.folder.create({
      data: { name, parentId: parentId ?? null, createdBy: user.id },
    });

    await this.audit.record({
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
        children: true,
        documents: { include: { currentVersion: true } },
      },
    });
    if (!folder) {
      throw new NotFoundException('Folder not found');
    }

    await this.audit.record({
      actorId: user.id,
      action: 'folder_view',
      resourceType: 'folder',
      resourceId: id,
      ipAddress,
    });

    return folder;
  }
}
```

Note the audit call happens AFTER the operation succeeds (after `create`/after the `NotFoundException` check), not before — a failed or unauthorized attempt is not logged as if it happened. This is a deliberate scope decision for this phase: only successful actions are audited, matching the design spec's framing of the audit log as a record of what was done, not an access-attempt log. (Logging denied attempts is a reasonable future addition, not built here.)

- [ ] **Step 3: Update `FoldersController` to capture and pass `req.ip`**

```ts
  @Post()
  async create(@Req() req: AuthenticatedRequest, @Body() body: CreateFolderDto) {
    const user = await this.usersService.upsertFromToken(req.user);
    return this.foldersService.create(
      { id: user.id, roles: req.user.roles },
      body.name,
      body.parentId ?? null,
      req.ip ?? null,
    );
  }

  @Get(':id')
  async get(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    const user = await this.usersService.upsertFromToken(req.user);
    return this.foldersService.getWithContents({ id: user.id, roles: req.user.roles }, id, req.ip ?? null);
  }
```

- [ ] **Step 4: Import `AuditModule` into `FoldersModule`**

```ts
import { Module } from '@nestjs/common';
import { FoldersController } from './folders.controller';
import { FoldersService } from './folders.service';
import { AclModule } from '../acl/acl.module';
import { UsersModule } from '../users/users.module';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [AclModule, UsersModule, AuditModule],
  controllers: [FoldersController],
  providers: [FoldersService],
  exports: [FoldersService],
})
export class FoldersModule {}
```

- [ ] **Step 5: Write the e2e test**

`apps/api/test/audit-folders.e2e-spec.ts`:

```ts
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
    expect(entries[0].ipAddress).not.toBe('::ffff:127.0.0.1');
  });
});
```

The last assertion (`ipAddress` isn't the loopback-wrapped address) is a real check that `trust proxy` is actually doing something — if it weren't configured, every request would show Traefik's or the raw socket's address rather than a forwarded one. Adjust the exact "wrong" value you assert against based on what you actually observe in a failing run before the trust-proxy fix (temporarily comment out Step 1's `main.ts` change locally, run the test, note the IP it captures, then restore the fix) — don't just guess at the string; verify it.

- [ ] **Step 6: Rebuild and run**

Run: `docker compose up -d --build api` (verify actual container recreation)
Run: `cd apps/api && pnpm test:e2e -- audit-folders`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/main.ts apps/api/src/folders apps/api/test/audit-folders.e2e-spec.ts
git commit -m "feat(api): trust Traefik as sole proxy, audit-log folder create and view"
```

---

### Task 4: Wire audit logging into DocumentsModule

**Files:**
- Modify: `apps/api/src/documents/documents.service.ts`
- Modify: `apps/api/src/documents/documents.controller.ts`
- Modify: `apps/api/src/documents/documents.module.ts`
- Test: `apps/api/test/audit-documents.e2e-spec.ts`

**Interfaces:**
- Consumes: `AuditService.record` (Task 2).
- Produces: `DocumentsService.createDocument`/`.addVersion`/`.getMetadata`/`.getDownloadStream` now accept a trailing `ipAddress` parameter and record `document_create`/`document_version_upload`/`document_view`/`document_download` respectively.

- [ ] **Step 1: Add `AuditService` to `DocumentsService`'s constructor, add `ipAddress` params, and record after each success**

Update `apps/api/src/documents/documents.service.ts`:
- Add `private readonly audit: AuditService` to the constructor (import from `'../audit/audit.service'`).
- `createDocument(user, folderId, name, file, ipAddress: string | null)` — after the `$transaction` resolves successfully, call `this.audit.record({ actorId: user.id, action: 'document_create', resourceType: 'document', resourceId: documentId, ipAddress })`.
- `addVersion(user, documentId, file, ipAddress: string | null)` — after the transaction resolves, `action: 'document_version_upload'`.
- `getMetadata(user, documentId, ipAddress: string | null)` — after the successful fetch, `action: 'document_view'`. (Also apply this to the version-list read if you choose to route it through the same method path — per the plan's Global Constraints, `document_view` covers both; if `listVersions` remains a separate method, you may leave it unaudited per the constraints, or audit it too under `document_view` for completeness — either is acceptable, just be consistent and note your choice in the commit.)
- `getDownloadStream(user, documentId, versionId, ipAddress: string | null)` — after ACL passes and the version is resolved (but the audit write doesn't need to wait for the stream to finish transferring — record it once you know the download is authorized and about to start, not after the client finishes receiving bytes), `action: 'document_download'`.

- [ ] **Step 2: Update `DocumentsController` to pass `req.ip`**

Thread `req.ip ?? null` as the trailing argument into each of the four calls above, matching the pattern established in Task 3/4.

- [ ] **Step 3: Import `AuditModule` into `DocumentsModule`**

Add `AuditModule` to the `imports` array in `apps/api/src/documents/documents.module.ts`.

- [ ] **Step 4: Write the e2e test**

`apps/api/test/audit-documents.e2e-spec.ts` — follow the exact structure of `audit-folders.e2e-spec.ts` (Task 4), but: create a folder, upload a document (expect `document_create`), fetch metadata (expect `document_view`), download it (expect `document_download`), upload a second version (expect `document_version_upload`). Assert the full chain of 4 entries for that document's `resourceId` is present, in order, each correctly linked to the previous via `prevHash`. Use typed axios calls throughout (this project's established convention — see `documents-read.e2e-spec.ts` for the pattern) and `form-data` for the multipart uploads (see `documents-write.e2e-spec.ts`).

- [ ] **Step 5: Rebuild and run**

Run: `docker compose up -d --build api` (verify actual recreation)
Run: `cd apps/api && pnpm test:e2e -- audit-documents`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/documents apps/api/test/audit-documents.e2e-spec.ts
git commit -m "feat(api): audit-log document create, view, download, and version upload"
```

---

### Task 5: Wire audit logging into PermissionsModule

**Files:**
- Modify: `apps/api/src/permissions/permissions.service.ts`
- Modify: `apps/api/src/permissions/permissions.controller.ts`
- Modify: `apps/api/src/permissions/permissions.module.ts`
- Test: `apps/api/test/audit-permissions.e2e-spec.ts`

**Interfaces:**
- Consumes: `AuditService.record` (Task 2).
- Produces: `PermissionsService.grant`/`.revoke` accept a trailing `ipAddress` parameter and record `permission_grant`/`permission_revoke`.

- [ ] **Step 1: Add `AuditService` to `PermissionsService`, thread `ipAddress`, record after success**

- `grant(user, resourceType, resourceId, principalType, principalId, permissionLevel, ipAddress: string | null)` — after the group-rejection check and the `manage` ACL check both pass and the `upsert` completes, record `permission_grant` against `(resourceType, resourceId)` (the resource being granted on, not the principal receiving it — a grant is an event on the resource's ACL, and that's also the `resourceType`/`resourceId` the caller was already authorized against).
- `revoke(user, resourceType, resourceId, permissionId, ipAddress: string | null)` — after the scoped `deleteMany` succeeds (count > 0), record `permission_revoke`.

- [ ] **Step 2: Update `PermissionsController` to pass `req.ip`**

Thread `req.ip ?? null` into all four grant/revoke handlers (both folder and document variants).

- [ ] **Step 3: Import `AuditModule` into `PermissionsModule`**

- [ ] **Step 4: Write the e2e test**

`apps/api/test/audit-permissions.e2e-spec.ts` — create a folder, grant a permission (expect `permission_grant`), revoke it (expect `permission_revoke`), assert both entries exist against the folder's `resourceId`, correctly chained.

- [ ] **Step 5: Rebuild and run**

Run: `docker compose up -d --build api` (verify actual recreation)
Run: `cd apps/api && pnpm test:e2e -- audit-permissions`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/permissions apps/api/test/audit-permissions.e2e-spec.ts
git commit -m "feat(api): audit-log permission grant and revoke"
```

---

### Task 6: Audit log read endpoints and chain-verification endpoint

**Files:**
- Create: `apps/api/src/audit/audit.controller.ts`
- Modify: `apps/api/src/audit/audit.module.ts`
- Modify: `apps/api/src/app.module.ts`
- Test: `apps/api/test/audit-endpoints.e2e-spec.ts`

**Interfaces:**
- Consumes: `AuditService.listForResource`, `AuditService.verifyChain`, `AclService.can`, `UsersService.upsertFromToken`.
- Produces: `GET /folders/:id/audit-logs` and `GET /documents/:id/audit-logs` (both require `manage` on the resource → `200 AuditLog[]`), `GET /audit-logs/verify` (admin-only → `200 { valid: boolean; brokenAtId?: string }`).

- [ ] **Step 1: Create `apps/api/src/audit/audit.controller.ts`**

```ts
import { Controller, ForbiddenException, Get, Param, Req, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Request } from 'express';
import { AuditService } from './audit.service';
import { AclService } from '../acl/acl.service';
import { UsersService } from '../users/users.service';

interface AuthenticatedRequest extends Request {
  user: { sub: string; email: string; name: string; roles: string[] };
}

@UseGuards(AuthGuard('jwt'))
@Controller()
export class AuditController {
  constructor(
    private readonly auditService: AuditService,
    private readonly aclService: AclService,
    private readonly usersService: UsersService,
  ) {}

  @Get('folders/:id/audit-logs')
  async folderAuditLogs(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    const user = await this.usersService.upsertFromToken(req.user);
    const allowed = await this.aclService.can({ id: user.id, roles: req.user.roles }, 'folder', id, 'manage');
    if (!allowed) {
      throw new ForbiddenException('You do not have manage access to this folder');
    }
    return this.auditService.listForResource('folder', id);
  }

  @Get('documents/:id/audit-logs')
  async documentAuditLogs(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    const user = await this.usersService.upsertFromToken(req.user);
    const allowed = await this.aclService.can({ id: user.id, roles: req.user.roles }, 'document', id, 'manage');
    if (!allowed) {
      throw new ForbiddenException('You do not have manage access to this document');
    }
    return this.auditService.listForResource('document', id);
  }

  @Get('audit-logs/verify')
  async verify(@Req() req: AuthenticatedRequest) {
    if (!req.user.roles.includes('admin')) {
      throw new ForbiddenException('Only admins can verify the audit chain');
    }
    return this.auditService.verifyChain();
  }
}
```

- [ ] **Step 2: Update `apps/api/src/audit/audit.module.ts`**

```ts
import { Module } from '@nestjs/common';
import { AuditController } from './audit.controller';
import { AuditService } from './audit.service';
import { AclModule } from '../acl/acl.module';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [AclModule, UsersModule],
  controllers: [AuditController],
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
```

(`AclModule`/`UsersModule` are now needed here since `AuditController` uses them directly — this is a new dependency direction, but no circular import: `AclModule` and `UsersModule` don't import `AuditModule`.)

- [ ] **Step 3: Wire `AuditModule` into `AppModule`**

Add `AuditModule` to the `imports` array in `apps/api/src/app.module.ts` (it's likely already imported transitively via `FoldersModule`/`DocumentsModule`/`PermissionsModule`, but it needs to be imported directly too since it now has its own `controllers`).

- [ ] **Step 4: Write the e2e test**

`apps/api/test/audit-endpoints.e2e-spec.ts` — create a folder as testadmin, grant `view` (not `manage`) to testuser, confirm testuser gets `403` on `GET /folders/:id/audit-logs`, confirm testadmin gets `200` with the `folder_create` entry present. Confirm a non-admin gets `403` on `GET /audit-logs/verify`, and testadmin gets `200 { valid: true }`.

- [ ] **Step 5: Rebuild and run**

Run: `docker compose up -d --build api` (verify actual recreation)
Run: `cd apps/api && pnpm test:e2e -- audit-endpoints`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/audit apps/api/src/app.module.ts apps/api/test/audit-endpoints.e2e-spec.ts
git commit -m "feat(api): add audit log read endpoints and chain-verification endpoint"
```

---

### Task 7: Full-suite verification

**Files:**
- Create: `docs/superpowers/plans/2026-08-01-phase3-verification.md`

**Interfaces:**
- Consumes: everything from Tasks 1-7.
- Produces: a written verification record confirming the audit trail and hash chain hold up under the full test suite and a real manual walkthrough.

- [ ] **Step 1: Fresh full-stack rebuild**

Run: `docker compose down -v && docker compose up -d --build`
Wait for all services healthy.

- [ ] **Step 2: Run every automated suite together**

`./scripts/smoke-test.sh`, `pnpm --filter api test`, `pnpm --filter api test:e2e`, `pnpm --filter api lint`, `pnpm --filter web test`. All must pass. Fix any integration-only failure (test data collisions, timing under load) that individual task-level testing couldn't have caught — this project has hit exactly this class of issue before (Phase 2B's final verification task).

- [ ] **Step 3: Manual walkthrough**

As testadmin: create a folder, upload a document, view its metadata, download it, upload a second version, grant `view` to testuser, revoke it. After each step, query `GET /folders/:id/audit-logs` or `GET /documents/:id/audit-logs` and confirm the expected entry appears with a correctly linked `prevHash`. Finally call `GET /audit-logs/verify` and confirm `{ valid: true }`.

Then, as a deliberate tamper check: connect directly to Postgres (`postgresql://drm:drm_dev_password@localhost:5433/drm`) and hand-edit one `audit_logs` row's `actorId` (matching the tamper-detection test from Task 2, but against the real running database this time). Call `GET /audit-logs/verify` again and confirm it now reports `{ valid: false, brokenAtId: "<the row you edited>" }`. Revert your manual edit afterward (or just leave the tampered row and note it in the verification doc — this is disposable dev data either way; document which you did).

- [ ] **Step 4: Write `docs/superpowers/plans/2026-08-01-phase3-verification.md`**

Record the suite results and the walkthrough narrative, following the format established by `docs/superpowers/plans/2026-08-01-phase2b-verification.md`.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/plans/2026-08-01-phase3-verification.md
git commit -m "docs: add Phase 3 verification record"
```

---

## Self-Review Notes

- **Spec coverage:** Implements the design spec's `audit_logs` requirement in full — every operation category the spec names that has a corresponding real endpoint is audited, with hash chaining for tamper evidence, plus a verification endpoint to actually exercise that tamper evidence (the spec says "以達防竄改效果" — evidence of tampering is only useful if something can detect it, hence Task 6's `/audit-logs/verify`). "刪除"/"到期" are explicitly out of scope since no delete or expiration operation exists yet.
- **Placeholder scan:** No TBD/TODO markers. Task 3 merges the trust-proxy config with FoldersModule's audit wiring specifically so no task leaves the build in a non-compiling state between commits.
- **Type consistency:** `AuditService.record`'s entry shape (`actorId`, `action`, `resourceType`, `resourceId`, `ipAddress`) is defined once in Task 2 and used identically by Tasks 4-6. The `ipAddress: string | null` trailing-parameter convention is introduced in Task 3 and applied consistently across all three existing services.
- **Scope:** Audit logging only. No changes to ACL semantics, storage, or any Phase 4+ feature (watermarking, expiration, virus scanning, Office conversion) — those remain untouched.
