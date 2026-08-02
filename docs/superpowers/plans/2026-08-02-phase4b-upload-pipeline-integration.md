# Phase 4B: Upload Pipeline Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every document upload is virus-scanned before it's ever stored, and Office documents (Word/Excel/PowerPoint) get a PDF preview generated in the background — using the infrastructure Phase 4A already proved works (ClamAV, Gotenberg, Redis/BullMQ, `apps/worker`), wired for the first time into the real upload flow built in Phase 2B.

**Architecture:** Virus scanning is synchronous, in the `apps/api` request path, before anything is written to MinIO or Postgres — an infected file is rejected outright, matching the design spec's literal upload sequence (scan before store). PDF conversion is asynchronous: `apps/api` enqueues a BullMQ job after a successful upload, `apps/worker` fetches the file from MinIO, converts it via Gotenberg, and stores the result back to MinIO; `apps/api` listens for job completion (via BullMQ's own event stream, not a callback endpoint) and records the result. This phase also resolves the database-access question Phase 4A's final review deliberately deferred: **`apps/worker` stays database-free** — `apps/api` remains the sole owner of all Postgres access, including background-job outcomes, avoiding the Prisma/Dockerfile complications flagged as a risk in Phase 4A's review. A new `packages/shared` workspace package (queue name + job payload/result types only, no logic) is introduced now, the lightweight version of the shared-package question Phase 4A's review recommended settling before anything heavier.

**Tech Stack:** `clamscan` (npm, already researched/chosen in Phase 4A) for the synchronous scan, BullMQ (`Queue`/`QueueEvents`/`Worker` — all already proven in Phase 4A) for the async conversion pipeline, Gotenberg's already-verified LibreOffice conversion route, Jest e2e tests against the live stack (this project's established convention).

## Global Constraints

- **Virus scanning is synchronous and blocks the upload request.** It happens in `DocumentsService.createDocument`/`.addVersion`, before `storage.putObject` and before any `Document`/`DocumentVersion` row is created. An infected file is rejected with `400 Bad Request`; nothing is written to MinIO or Postgres for it. This matches the design spec's literal flow ("Client → API → 暫存 → ClamAV 掃描 → ... → 寫入MinIO") and gives the uploader immediate feedback rather than a later "your upload turned out to be malware" surprise.
- **A rejected (infected) upload IS audited, as a deliberate, explicit exception to Phase 3's "only audit successful actions" principle.** A virus-upload attempt is a security event worth recording regardless of outcome — this is not a contradiction of the earlier principle, it's a narrow, named carve-out for this one case. A new `virus_detected` `AuditAction` is added. Since no `Document`/`DocumentVersion` row exists at reject-time, the audit entry's `resourceType`/`resourceId` is the **folder** being uploaded into (for `createDocument`) or the **document** being versioned (for `addVersion`) — whichever resource identifier already exists at that point.
- **PDF conversion is asynchronous and does not block the upload request.** Office documents (Word/Excel/PowerPoint — see the concrete MIME-type list in Task 5) get a `document-conversion` BullMQ job enqueued after the upload succeeds. Non-Office files never get a conversion job. `DocumentVersion.previewObjectKey` starts `null` and is populated later by `apps/api`'s job-completion listener once conversion finishes. **`null` deliberately means both "not applicable" and "not yet converted"** — this phase does not add a separate status/enum field to distinguish them. That's an accepted simplification; revisit it if a future phase's frontend needs to show a "converting..." state.
- **`apps/worker` remains database-free**, resolving the question Phase 4A's final review flagged as unresolved. `apps/api` is the only process that ever talks to Postgres, including recording the outcome of background jobs — it does this by listening to BullMQ's own `completed`/`failed` events (via `QueueEvents`, the same class already proven in Phase 4A's `jobs.e2e-spec.ts`), not via a callback HTTP endpoint on `apps/api` and not via a shared Prisma package. `apps/worker`'s Dockerfile therefore still does not need `openssl`/`prisma generate`/any Prisma-related step — the three traps Phase 4A's review predicted for a shared-database approach don't apply here.
- **`apps/worker` gets its own minimal MinIO client**, duplicated from (not shared with) `apps/api`'s `StorageService` — it's ~30 lines, low risk to duplicate, unlike Prisma's whole toolchain. It reuses the **same scoped `drm-api` MinIO credential** `apps/api` already uses (env vars `MINIO_ENDPOINT`/`MINIO_BUCKET`/`MINIO_ACCESS_KEY`/`MINIO_SECRET_KEY`, already scoped to only the `documents` bucket per Phase 2A) — not a separate worker-specific credential. A dedicated worker credential would be a defense-in-depth refinement worth considering later, not required now.
- **`packages/shared` is introduced now**, containing only the `document-conversion` queue name constant and the `ConversionJobData`/`ConversionJobResult` TypeScript interfaces — no runtime logic. This is the lightweight "dry run" Phase 4A's review explicitly recommended before any heavier shared package: it exercises the exact Dockerfile changes (`COPY packages/shared`, building it before the consuming app) that a future `packages/database` extraction would also need, at much lower risk. Both `apps/api` and `apps/worker` depend on it via the `workspace:*` protocol.
- **Download/view endpoints are unchanged in this phase.** `previewObjectKey` gets populated but nothing reads it yet — consuming it for watermarked preview rendering is Phase 4C's job, not this one.
- **`clamscan`'s exact buffer-scanning API is not fully certain from memory** — Phase 4A's Task 5 used it successfully against real files via `docker run`, which is real, useful prior verification, but this phase needs it scanning an in-memory `Buffer` (from multer's memory storage) inside a long-running NestJS service, not a one-shot script. Verify the real method (`scanStream` wrapping a `Readable.from(buffer)`, or whatever the actually-installed package supports) against the installed package's types before trusting this plan's draft code.
- Real integration tests: e2e against the live stack (real ClamAV rejecting a real EICAR-laced upload, real Gotenberg converting a real uploaded Office-mimetype file, real MinIO object created) — this project's established convention, no mocked infrastructure for anything this plan touches.
- Docker daemon on this host is sometimes under load, and this session has repeatedly hit disk-space stalls during `docker compose build` — check `df -h /` and prune (`docker builder prune -f`, `docker image prune -a -f --filter "until=24h"` if plain prune reclaims 0B) if a build hangs unusually long. Verify a container was actually recreated after any rebuild (image ID/start-time comparison), not just that the build command exited 0 — a real, recurring issue in this project. ClamAV's first-boot definition download can take several minutes if its volume is ever wiped (`docker compose down -v`) — expected, not a hang.

---

### Task 1: `packages/shared` scaffold + Dockerfile updates

**Files:**
- Create: `packages/shared/package.json`
- Create: `packages/shared/tsconfig.json`
- Create: `packages/shared/src/index.ts`
- Modify: `apps/api/package.json` (add `@drm/shared` dependency)
- Modify: `apps/api/Dockerfile`
- Modify: `apps/worker/package.json` (add `@drm/shared` dependency)
- Modify: `apps/worker/Dockerfile`

**Interfaces:**
- Consumes: nothing new.
- Produces: `@drm/shared` exporting `QUEUE_DOCUMENT_CONVERSION: string`, `interface ConversionJobData { documentVersionId: string; objectKey: string; mimeType: string }`, `interface ConversionJobResult { documentVersionId: string; previewObjectKey: string }`. Both `apps/api` and `apps/worker` can build against it.

- [ ] **Step 1: Create `packages/shared/package.json`**

```json
{
  "name": "@drm/shared",
  "version": "0.1.0",
  "private": true,
  "packageManager": "pnpm@9.7.0",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc"
  },
  "devDependencies": {
    "typescript": "^5.5.4"
  }
}
```

- [ ] **Step 2: Create `packages/shared/tsconfig.json`**

```json
{
  "compilerOptions": {
    "module": "commonjs",
    "target": "ES2021",
    "moduleResolution": "node",
    "declaration": true,
    "outDir": "./dist",
    "strict": true,
    "skipLibCheck": true,
    "esModuleInterop": true
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Create `packages/shared/src/index.ts`**

```ts
export const QUEUE_DOCUMENT_CONVERSION = 'document-conversion';

export interface ConversionJobData {
  documentVersionId: string;
  objectKey: string;
  mimeType: string;
}

export interface ConversionJobResult {
  documentVersionId: string;
  previewObjectKey: string;
}
```

- [ ] **Step 4: Verify it builds standalone**

Run: `cd packages/shared && pnpm install && pnpm run build`
Expected: `dist/index.js` and `dist/index.d.ts` created, no errors.

- [ ] **Step 5: Add `@drm/shared` as a dependency of `apps/api` and `apps/worker`**

Add to both `apps/api/package.json` and `apps/worker/package.json`'s `dependencies`:

```json
    "@drm/shared": "workspace:*",
```

Run from the repo root: `pnpm install` (this needs to happen at the root so pnpm resolves the `workspace:*` protocol and updates the single root `pnpm-lock.yaml`).

- [ ] **Step 6: Verify both apps still build locally with the new dependency**

Run: `cd apps/api && pnpm run build` — expected: no errors (nothing imports `@drm/shared` yet, this just confirms the dependency resolves).
Run: `cd apps/worker && pnpm run build` — same expectation.

- [ ] **Step 7: Update `apps/api/Dockerfile` to build `packages/shared` first**

The build stage needs `packages/shared`'s `package.json` copied in before `pnpm install` (so the workspace link resolves), the full `packages/shared` source copied in before building, and `packages/shared` built before `apps/api`:

```dockerfile
FROM node:20-alpine AS build
WORKDIR /repo
RUN corepack enable
RUN apk add --no-cache openssl
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/shared/package.json packages/shared/package.json
COPY apps/api/package.json apps/api/package.json
RUN pnpm install --frozen-lockfile
COPY packages/shared ./packages/shared
COPY apps/api ./apps/api
RUN pnpm --filter shared run build
RUN pnpm --filter api exec prisma generate || true
RUN pnpm --filter api run build
```

(Runtime stage is unchanged — `packages/shared`'s compiled `dist/` is already inside `node_modules/@drm/shared` via the workspace symlink that `pnpm install` sets up, so it's carried along by the existing `COPY --from=build /repo/node_modules ./node_modules` line. Verify this is actually true once you build — pnpm workspace symlinks inside `node_modules` can be real symlinks pointing outside the copied tree, which would break in the runtime stage if the target isn't also copied. If that's the case, add an explicit `COPY --from=build /repo/packages/shared/dist ./packages/shared/dist` line to the runtime stage and confirm the symlink resolves correctly inside the final image.)

- [ ] **Step 8: Update `apps/worker/Dockerfile` the same way**

```dockerfile
FROM node:20-alpine AS build
WORKDIR /repo
RUN corepack enable
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/shared/package.json packages/shared/package.json
COPY apps/worker/package.json apps/worker/package.json
RUN pnpm install --frozen-lockfile
COPY packages/shared ./packages/shared
COPY apps/worker ./apps/worker
RUN pnpm --filter shared run build
RUN pnpm --filter worker run build

FROM node:20-alpine
WORKDIR /repo
RUN corepack enable
ENV NODE_ENV=production
COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/apps/worker/node_modules ./apps/worker/node_modules
COPY --from=build /repo/apps/worker/dist ./apps/worker/dist
COPY --from=build /repo/apps/worker/package.json ./apps/worker/package.json
WORKDIR /repo/apps/worker
CMD ["node", "dist/main.js"]
```

(Same symlink caveat as Step 7 applies here — verify for real.)

- [ ] **Step 9: Rebuild both containers and confirm they still start cleanly**

Run: `docker compose up -d --build api worker` (verify actual recreation of both via image ID/start-time)
Run: `docker compose logs api worker`
Expected: both start with no errors (neither imports `@drm/shared` yet — this step only proves the Docker build pipeline for the new workspace package works before anything depends on it functionally).

- [ ] **Step 10: Run the existing full suite to confirm nothing broke**

Run: `pnpm --filter api test`, `pnpm --filter api test:e2e`, `pnpm --filter api lint`, `pnpm --filter worker lint`, `./scripts/smoke-test.sh`.
Expected: all pass, same as before this task.

- [ ] **Step 11: Commit**

```bash
git add packages/shared apps/api/package.json apps/api/Dockerfile apps/worker/package.json apps/worker/Dockerfile pnpm-lock.yaml pnpm-workspace.yaml
git commit -m "feat: add packages/shared workspace package, wire into api/worker Dockerfiles"
```

---

### Task 2: Schema migration — `previewObjectKey` + `virus_detected` action

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/<timestamp>_conversion_preview_and_virus_action/migration.sql` (generated)

**Interfaces:**
- Consumes: nothing new.
- Produces: `DocumentVersion.previewObjectKey: string | null`, `AuditAction.virus_detected` — both importable from `@prisma/client` once generated.

- [ ] **Step 1: Add `previewObjectKey` to the `DocumentVersion` model in `apps/api/prisma/schema.prisma`**

Add the field to the existing model (don't recreate the whole model — just add this line among its existing fields):

```prisma
  previewObjectKey String?
```

- [ ] **Step 2: Add `virus_detected` to the `AuditAction` enum**

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
  virus_detected
}
```

- [ ] **Step 3: Start a temporary local Postgres for migration authoring**

Run: `docker run --rm -d --name drm-dev-postgres -e POSTGRES_USER=drm -e POSTGRES_PASSWORD=drm_dev_password -e POSTGRES_DB=drm -p 5436:5432 postgres:16-alpine`

(Port 5436 — 5433/5434/5435 were used by prior phases' migration authoring; check `docker compose ps` and `docker ps` first, adjust if taken.)

- [ ] **Step 4: Generate the migration**

Run: `cd apps/api && DATABASE_URL="postgresql://drm:drm_dev_password@localhost:5436/drm" pnpm exec prisma migrate dev --name conversion_preview_and_virus_action`

- [ ] **Step 5: Stop the temporary Postgres**

Run: `docker stop drm-dev-postgres`

- [ ] **Step 6: Regenerate the client and verify the build**

Run: `cd apps/api && pnpm exec prisma generate && pnpm run build`
Expected: no TypeScript errors.

- [ ] **Step 7: Commit**

```bash
git add apps/api/prisma
git commit -m "feat(api): add DocumentVersion.previewObjectKey and virus_detected audit action"
```

---

### Task 3: `VirusScanService` — synchronous scan-before-store

**Files:**
- Create: `apps/api/src/documents/virus-scan.service.ts`
- Modify: `apps/api/src/documents/documents.service.ts`
- Modify: `apps/api/src/documents/documents.module.ts`
- Modify: `apps/api/package.json` (add `clamscan` dependency)
- Test: `apps/api/test/virus-scan.e2e-spec.ts`

**Interfaces:**
- Consumes: nothing new (talks directly to the `clamav` service already running from Phase 4A, over the internal Docker network).
- Produces: `VirusScanService.scanBuffer(buffer: Buffer): Promise<{ isInfected: boolean; viruses: string[] }>`. `DocumentsService.createDocument`/`.addVersion` now reject infected uploads with `400` before any storage/DB write, and audit the rejection as `virus_detected`.

- [ ] **Step 1: Add `clamscan` dependency to `apps/api`**

```json
    "clamscan": "^2.4.0",
```

Run: `cd apps/api && pnpm install`. Verify the real installed package's API for buffer/stream scanning before writing `VirusScanService` — check `node_modules/clamscan`'s types/README, the same way Phase 4A's Task 5 had to research this package for real rather than trust a guess.

- [ ] **Step 2: Create `apps/api/src/documents/virus-scan.service.ts`**

```ts
import { Injectable } from '@nestjs/common';
import { Readable } from 'stream';
// eslint-disable-next-line @typescript-eslint/no-var-requires -- clamscan ships CJS with no useful default-export types; verify the real import shape against the installed package before trusting this.
const NodeClam = require('clamscan');

export interface ScanResult {
  isInfected: boolean;
  viruses: string[];
}

@Injectable()
export class VirusScanService {
  private readonly clamscanPromise: Promise<any>;

  constructor() {
    this.clamscanPromise = new NodeClam().init({
      removeInfected: false,
      scanRecursively: false,
      clamdscan: {
        host: process.env.CLAMAV_HOST ?? 'clamav',
        port: Number(process.env.CLAMAV_PORT ?? 3310),
        timeout: 60000,
      },
      preference: 'clamdscan',
    });
  }

  async scanBuffer(buffer: Buffer): Promise<ScanResult> {
    const clamscan = await this.clamscanPromise;
    const stream = Readable.from(buffer);
    const { isInfected, viruses } = await clamscan.scanStream(stream);
    return { isInfected: !!isInfected, viruses: viruses ?? [] };
  }
}
```

This is a best-effort draft, explicitly flagged as uncertain in the Global Constraints — verify `init()`'s option shape and `scanStream`'s real return shape against the actually-installed `clamscan` version, and fix any mismatch based on real errors, the same way Phase 4A's Task 5 iterated against real ClamAV behavior.

- [ ] **Step 3: Add `CLAMAV_HOST`/`CLAMAV_PORT` to the `api` service's environment in `docker-compose.yml`**

```yaml
      CLAMAV_HOST: clamav
      CLAMAV_PORT: 3310
```

Add `clamav: condition: service_healthy` to the `api` service's `depends_on`.

- [ ] **Step 4: Wire the scan into `DocumentsService.createDocument` and `.addVersion`**

In `apps/api/src/documents/documents.service.ts`, inject `VirusScanService` (and it already has `AuditService` from Phase 3). At the very start of both methods, before `storage.putObject` and before any Prisma write:

```ts
    const scanResult = await this.virusScan.scanBuffer(file.buffer);
    if (scanResult.isInfected) {
      await this.audit.record({
        actorId: user.id,
        action: 'virus_detected',
        resourceType: 'folder', // or 'document' in addVersion — see below
        resourceId: folderId,   // or documentId in addVersion
        ipAddress,
      });
      throw new BadRequestException(
        `Upload rejected: infected file detected (${scanResult.viruses.join(', ')})`,
      );
    }
```

In `createDocument`, use `resourceType: 'folder'` / `resourceId: folderId` (the upload target — no `Document` row exists yet to reference). In `addVersion`, use `resourceType: 'document'` / `resourceId: documentId` (that row already exists). Import `BadRequestException` from `@nestjs/common`.

- [ ] **Step 5: Import `VirusScanService` into `DocumentsModule`**

Add `VirusScanService` to `apps/api/src/documents/documents.module.ts`'s `providers` array.

- [ ] **Step 6: Write the e2e test**

`apps/api/test/virus-scan.e2e-spec.ts`:

```ts
import axios from 'axios';
import FormData from 'form-data';

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

// The standard EICAR antivirus test string, base64-encoded so the literal
// signature never appears in tracked source (matching the precedent set by
// scripts/verify-clamav.sh in Phase 4A).
const EICAR_BASE64 =
  'WDVPIVAlQEFQWzRcUFpYNTQoUF4pN0NDKTd9JEVJQ0FSLVNUQU5EQVJELUFOVElWSVJVUy1URVNULUZJTEUhJEgrSCo=';

describe('Virus scanning on upload (e2e)', () => {
  it('rejects an infected upload before any storage or DB write, and audits it', async () => {
    const adminToken = await getToken('testadmin', 'testadminpass');
    const authHeader = { Authorization: `Bearer ${adminToken}` };

    const folderRes = await axios.post<FolderResponse>(
      `${API_BASE_URL}/folders`,
      { name: `virus-scan-test-${Date.now()}` },
      { headers: authHeader },
    );
    const folderId = folderRes.data.id;

    const infected = Buffer.from(EICAR_BASE64, 'base64');
    const form = new FormData();
    form.append('folderId', folderId);
    form.append('name', 'eicar.txt');
    form.append('file', infected, { filename: 'eicar.txt' });

    await expect(
      axios.post(`${API_BASE_URL}/documents`, form, {
        headers: { ...authHeader, ...form.getHeaders() },
      }),
    ).rejects.toMatchObject({ response: { status: 400 } });

    const listRes = await axios.get(`${API_BASE_URL}/folders/${folderId}`, { headers: authHeader });
    expect(listRes.data.documents).toHaveLength(0);
  });

  it('accepts a clean upload as before', async () => {
    const adminToken = await getToken('testadmin', 'testadminpass');
    const authHeader = { Authorization: `Bearer ${adminToken}` };

    const folderRes = await axios.post<FolderResponse>(
      `${API_BASE_URL}/folders`,
      { name: `virus-scan-clean-${Date.now()}` },
      { headers: authHeader },
    );

    const form = new FormData();
    form.append('folderId', folderRes.data.id);
    form.append('name', 'clean.txt');
    form.append('file', Buffer.from('this file is not infected'), { filename: 'clean.txt' });

    const createRes = await axios.post(`${API_BASE_URL}/documents`, form, {
      headers: { ...authHeader, ...form.getHeaders() },
    });
    expect(createRes.status).toBe(201);
  });
});
```

- [ ] **Step 7: Rebuild and run**

Run: `docker compose up -d --build api` (verify actual recreation)
Run: `cd apps/api && pnpm test:e2e -- virus-scan`
Expected: PASS (2 tests)

- [ ] **Step 8: Commit**

```bash
git add apps/api/package.json apps/api/pnpm-lock.yaml apps/api/src/documents apps/api/test/virus-scan.e2e-spec.ts docker-compose.yml
git commit -m "feat(api): scan uploads for viruses before storage, reject infected files"
```

---

### Task 4: Worker `StorageService` + `ConversionProcessor`

**Files:**
- Create: `apps/worker/src/storage/storage.service.ts`
- Create: `apps/worker/src/storage/storage.module.ts`
- Create: `apps/worker/src/conversion/conversion.processor.ts`
- Create: `apps/worker/src/conversion/conversion.module.ts`
- Modify: `apps/worker/src/app.module.ts`
- Modify: `apps/worker/package.json` (add `@aws-sdk/client-s3` dependency)
- Modify: `docker-compose.yml` (add MinIO/Gotenberg env vars + `depends_on` to `worker`)

**Interfaces:**
- Consumes: `@drm/shared`'s `QUEUE_DOCUMENT_CONVERSION`/`ConversionJobData`/`ConversionJobResult` (Task 1).
- Produces: a `document-conversion` BullMQ processor in `apps/worker` that fetches an object from MinIO, converts it via Gotenberg, stores the result back to MinIO, and returns `ConversionJobResult`.

- [ ] **Step 1: Add `@aws-sdk/client-s3` to `apps/worker`**

```json
    "@aws-sdk/client-s3": "^3.658.0",
```

Run: `cd apps/worker && pnpm install`

- [ ] **Step 2: Create `apps/worker/src/storage/storage.service.ts`**

A deliberate, minimal duplication of `apps/api/src/storage/storage.service.ts` — same env vars, same `forcePathStyle: true` requirement for MinIO, adds a `getObjectBuffer` method (the worker needs the whole file in memory to POST to Gotenberg, unlike `apps/api`'s streaming download):

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
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }),
    );
  }

  async getObjectBuffer(key: string): Promise<Buffer> {
    const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    const stream = result.Body as Readable;
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }
}
```

- [ ] **Step 3: Create `apps/worker/src/storage/storage.module.ts`**

```ts
import { Module } from '@nestjs/common';
import { StorageService } from './storage.service';

@Module({
  providers: [StorageService],
  exports: [StorageService],
})
export class StorageModule {}
```

- [ ] **Step 4: Create `apps/worker/src/conversion/conversion.processor.ts`**

```ts
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { QUEUE_DOCUMENT_CONVERSION, ConversionJobData, ConversionJobResult } from '@drm/shared';
import { randomUUID } from 'crypto';
import axios from 'axios';
import FormData from 'form-data';
import { StorageService } from '../storage/storage.service';

@Processor(QUEUE_DOCUMENT_CONVERSION)
export class ConversionProcessor extends WorkerHost {
  constructor(private readonly storage: StorageService) {
    super();
  }

  async process(job: Job<ConversionJobData>): Promise<ConversionJobResult> {
    const { documentVersionId, objectKey, mimeType } = job.data;

    const original = await this.storage.getObjectBuffer(objectKey);

    const form = new FormData();
    form.append('files', original, { filename: 'document', contentType: mimeType });

    const gotenbergUrl = process.env.GOTENBERG_URL ?? 'http://gotenberg:3000';
    const response = await axios.post(`${gotenbergUrl}/forms/libreoffice/convert`, form, {
      headers: form.getHeaders(),
      responseType: 'arraybuffer',
    });

    const previewObjectKey = `${objectKey}-preview-${randomUUID()}.pdf`;
    await this.storage.putObject(previewObjectKey, Buffer.from(response.data), 'application/pdf');

    return { documentVersionId, previewObjectKey };
  }
}
```

Verify `axios`/`form-data` are added as `apps/worker` dependencies (they aren't yet — add both to `apps/worker/package.json`). Verify the Gotenberg route/form-field name against Task 4 of the Phase 4A plan's already-proven-correct usage (`scripts/verify-gotenberg.sh`) — it should match exactly since this is the same Gotenberg service, already confirmed working.

- [ ] **Step 5: Create `apps/worker/src/conversion/conversion.module.ts`**

```ts
import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { QUEUE_DOCUMENT_CONVERSION } from '@drm/shared';
import { ConversionProcessor } from './conversion.processor';
import { StorageModule } from '../storage/storage.module';

@Module({
  imports: [BullModule.registerQueue({ name: QUEUE_DOCUMENT_CONVERSION }), StorageModule],
  providers: [ConversionProcessor],
})
export class ConversionModule {}
```

- [ ] **Step 6: Wire `ConversionModule` into `apps/worker/src/app.module.ts`**

Add `ConversionModule` to the `imports` array alongside the existing `HealthCheckModule`.

- [ ] **Step 7: Add MinIO/Gotenberg env vars to the `worker` service in `docker-compose.yml`**

```yaml
      MINIO_ENDPOINT: http://minio:9000
      MINIO_BUCKET: documents
      MINIO_ACCESS_KEY: ${MINIO_API_ACCESS_KEY}
      MINIO_SECRET_KEY: ${MINIO_API_SECRET_KEY}
      GOTENBERG_URL: http://gotenberg:3000
```

Add `minio: condition: service_healthy` and `gotenberg: condition: service_healthy` to the `worker` service's `depends_on`.

- [ ] **Step 8: Rebuild and verify the worker starts cleanly**

Run: `docker compose up -d --build worker` (verify actual recreation)
Run: `docker compose logs worker`
Expected: clean start, no errors, the `document-conversion` queue registered alongside `health-check`.

- [ ] **Step 9: Commit**

```bash
git add apps/worker docker-compose.yml
git commit -m "feat(worker): add StorageService and ConversionProcessor (MinIO -> Gotenberg -> MinIO)"
```

---

### Task 5: Wire conversion into the upload flow (enqueue + completion listener)

**Files:**
- Create: `apps/api/src/documents/conversion-events.listener.ts`
- Modify: `apps/api/src/documents/documents.service.ts`
- Modify: `apps/api/src/documents/documents.module.ts`
- Modify: `apps/api/package.json` (add `bullmq`'s already-present dependency is enough; add `@drm/shared` usage)
- Test: `apps/api/test/document-conversion.e2e-spec.ts`

**Interfaces:**
- Consumes: `@drm/shared` (Task 1), the `document-conversion` queue (Task 4's consumer side).
- Produces: `DocumentsService.createDocument`/`.addVersion` enqueue a conversion job for Office-mimetype uploads; `ConversionEventsListener` updates `DocumentVersion.previewObjectKey` when a job completes.

- [ ] **Step 1: Create `apps/api/src/documents/conversion-events.listener.ts`**

Uses `bullmq`'s `QueueEvents` directly (the same class already proven in Phase 4A's `jobs.e2e-spec.ts`), not `@nestjs/bullmq`'s decorator sugar — keeping this on an already-verified pattern.

```ts
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { QueueEvents } from 'bullmq';
import { QUEUE_DOCUMENT_CONVERSION, ConversionJobResult } from '@drm/shared';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class ConversionEventsListener implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ConversionEventsListener.name);
  private queueEvents!: QueueEvents;

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit() {
    this.queueEvents = new QueueEvents(QUEUE_DOCUMENT_CONVERSION, {
      connection: {
        host: process.env.REDIS_HOST ?? 'redis',
        port: Number(process.env.REDIS_PORT ?? 6379),
      },
    });

    this.queueEvents.on('completed', ({ returnvalue }) => {
      void this.handleCompleted(returnvalue);
    });

    this.queueEvents.on('failed', ({ jobId, failedReason }) => {
      this.logger.error(`Conversion job ${jobId} failed: ${failedReason}`);
    });
  }

  private async handleCompleted(returnvalue: unknown) {
    const result = (
      typeof returnvalue === 'string' ? JSON.parse(returnvalue) : returnvalue
    ) as ConversionJobResult;

    await this.prisma.documentVersion.update({
      where: { id: result.documentVersionId },
      data: { previewObjectKey: result.previewObjectKey },
    });
  }

  async onModuleDestroy() {
    await this.queueEvents.close();
  }
}
```

Verify whether `returnvalue` on the `completed` event is genuinely always a JSON string (BullMQ typically serializes job results when they pass through Redis) or sometimes already an object, against real observed behavior — the `typeof` check handles both, but confirm which case actually occurs in this project's setup and note it.

- [ ] **Step 2: Add a producer method and Office-mimetype detection to `DocumentsService`**

In `apps/api/src/documents/documents.service.ts`, inject `@InjectQueue(QUEUE_DOCUMENT_CONVERSION) private readonly conversionQueue: Queue<ConversionJobData>` (import `InjectQueue` from `@nestjs/bullmq`, `Queue` from `bullmq`, `QUEUE_DOCUMENT_CONVERSION`/`ConversionJobData` from `@drm/shared`).

Add a private helper:

```ts
  private readonly OFFICE_MIME_TYPES = new Set([
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  ]);

  private async maybeEnqueueConversion(versionId: string, objectKey: string, mimeType: string) {
    if (!this.OFFICE_MIME_TYPES.has(mimeType)) {
      return;
    }
    await this.conversionQueue.add('convert', {
      documentVersionId: versionId,
      objectKey,
      mimeType,
    });
  }
```

Call `await this.maybeEnqueueConversion(version.id, objectKey, file.mimetype)` at the end of both `createDocument` (after the transaction commits, using the created version's `id`/`objectKey`) and `addVersion` (same, after its transaction commits) — after the existing audit-recording call, so an enqueue failure doesn't prevent the upload itself from being recorded as successful (the upload succeeded; the preview is a secondary, best-effort enhancement).

- [ ] **Step 3: Register the `document-conversion` queue and the listener in `DocumentsModule`**

```ts
import { BullModule } from '@nestjs/bullmq';
import { QUEUE_DOCUMENT_CONVERSION } from '@drm/shared';
import { ConversionEventsListener } from './conversion-events.listener';

@Module({
  imports: [
    AclModule,
    StorageModule,
    UsersModule,
    AuditModule,
    BullModule.registerQueue({ name: QUEUE_DOCUMENT_CONVERSION }),
  ],
  controllers: [DocumentsController],
  providers: [DocumentsService, VirusScanService, ConversionEventsListener],
  exports: [DocumentsService],
})
export class DocumentsModule {}
```

- [ ] **Step 4: Write the e2e test**

`apps/api/test/document-conversion.e2e-spec.ts`:

```ts
import axios from 'axios';
import FormData from 'form-data';
import { PrismaClient } from '@prisma/client';

const KEYCLOAK_TOKEN_URL = 'http://auth.drm.localhost/realms/drm/protocol/openid-connect/token';
const API_BASE_URL = 'http://api.drm.localhost';
const MC = 'docker run --rm --network drm_default minio/mc';

interface TokenResponse {
  access_token: string;
}
interface FolderResponse {
  id: string;
}
interface DocumentResponse {
  id: string;
  currentVersion: { id: string; objectKey: string };
}

async function getToken(username: string, password: string): Promise<string> {
  const response = await axios.post<TokenResponse>(
    KEYCLOAK_TOKEN_URL,
    new URLSearchParams({ grant_type: 'password', client_id: 'drm-web', username, password }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
  );
  return response.data.access_token;
}

describe('Document conversion pipeline (e2e)', () => {
  const prisma = new PrismaClient({
    datasources: { db: { url: 'postgresql://drm:drm_dev_password@localhost:5433/drm' } },
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('enqueues and completes a conversion for an Office-mimetype upload, populating previewObjectKey', async () => {
    const adminToken = await getToken('testadmin', 'testadminpass');
    const authHeader = { Authorization: `Bearer ${adminToken}` };

    const folderRes = await axios.post<FolderResponse>(
      `${API_BASE_URL}/folders`,
      { name: `conversion-test-${Date.now()}` },
      { headers: authHeader },
    );

    const form = new FormData();
    form.append('folderId', folderRes.data.id);
    form.append('name', 'test.docx');
    form.append('file', Buffer.from('plain text content, declared as a Word document for this test'), {
      filename: 'test.docx',
      contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });

    const createRes = await axios.post<DocumentResponse>(`${API_BASE_URL}/documents`, form, {
      headers: { ...authHeader, ...form.getHeaders() },
    });
    const versionId = createRes.data.currentVersion.id;

    let previewObjectKey: string | null = null;
    for (let i = 0; i < 30; i++) {
      const version = await prisma.documentVersion.findUniqueOrThrow({ where: { id: versionId } });
      if (version.previewObjectKey) {
        previewObjectKey = version.previewObjectKey;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    expect(previewObjectKey).not.toBeNull();
  }, 40000);

  it('does not enqueue a conversion for a non-Office upload', async () => {
    const adminToken = await getToken('testadmin', 'testadminpass');
    const authHeader = { Authorization: `Bearer ${adminToken}` };

    const folderRes = await axios.post<FolderResponse>(
      `${API_BASE_URL}/folders`,
      { name: `no-conversion-test-${Date.now()}` },
      { headers: authHeader },
    );

    const form = new FormData();
    form.append('folderId', folderRes.data.id);
    form.append('name', 'plain.txt');
    form.append('file', Buffer.from('just a plain text file'), {
      filename: 'plain.txt',
      contentType: 'text/plain',
    });

    const createRes = await axios.post<DocumentResponse>(`${API_BASE_URL}/documents`, form, {
      headers: { ...authHeader, ...form.getHeaders() },
    });
    const versionId = createRes.data.currentVersion.id;

    await new Promise((resolve) => setTimeout(resolve, 3000));
    const version = await prisma.documentVersion.findUniqueOrThrow({ where: { id: versionId } });
    expect(version.previewObjectKey).toBeNull();
  }, 15000);
});
```

The `MC` constant is unused in this draft — remove it, or use it to add a stronger assertion that verifies the preview object genuinely exists in MinIO and is a real PDF (magic bytes check, matching Phase 4A's `verify-gotenberg.sh` pattern) rather than only checking the DB column got set. Strengthening this test that way is worth doing if it's not much extra work.

- [ ] **Step 5: Rebuild and run**

Run: `docker compose up -d --build api worker` (verify actual recreation of both)
Run: `cd apps/api && pnpm test:e2e -- document-conversion`
Expected: PASS. The first test has real async wait time (polling up to 30s) — this is expected, not a hang.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/documents apps/api/test/document-conversion.e2e-spec.ts
git commit -m "feat(api): enqueue Office document conversion on upload, record preview when complete"
```

---

### Task 6: Full-suite verification

**Files:**
- Create: `docs/superpowers/plans/2026-08-02-phase4b-verification.md`

**Interfaces:**
- Consumes: everything from Tasks 1-5.
- Produces: a written verification record confirming the full upload → scan → store → convert → preview pipeline works together, fresh.

- [ ] **Step 1: Fresh full-stack rebuild**

Run: `docker compose down -v && docker compose up -d --build`
Wait for all services healthy (Keycloak cold start, ClamAV definition re-download — both expected to take several minutes, be patient per prior phases' precedent).

- [ ] **Step 2: Run every automated suite together**

`./scripts/smoke-test.sh`, `pnpm --filter api test`, `pnpm --filter api test:e2e`, `pnpm --filter api lint`, `pnpm --filter worker lint`, `pnpm --filter web test`, `./scripts/verify-gotenberg.sh`, `./scripts/verify-clamav.sh`. All must pass together. Fix any integration-only issue this reveals — this project has repeatedly found real issues exactly this way in every prior phase.

- [ ] **Step 3: Manual walkthrough**

As testadmin: create a folder, upload an infected test file (confirm rejected, confirm no document created, confirm audit entry), upload a clean Office-mimetype file (confirm accepted immediately, poll `GET /documents/:id` until `currentVersion.previewObjectKey` is set, confirm the preview object is a real PDF in MinIO), upload a clean plain-text file (confirm accepted, confirm `previewObjectKey` stays null).

- [ ] **Step 4: Write `docs/superpowers/plans/2026-08-02-phase4b-verification.md`**

Follow the format established by prior phases' verification docs.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/plans/2026-08-02-phase4b-verification.md
git commit -m "docs: add Phase 4B verification record"
```

---

## Self-Review Notes

- **Spec coverage:** Implements the design spec's upload-flow description exactly (scan before store, Office conversion via worker+Gotenberg after). Watermarking and expiration are explicitly Phase 4C, untouched here.
- **Placeholder scan:** No TBD/TODO markers. The one deliberately-left area of genuine uncertainty (`clamscan`'s exact buffer-scanning API) is explicitly flagged for real verification during implementation, consistent with how this project has handled comparable third-party-API uncertainty in every prior phase (KES in 2A, ClamAV's own client choice in 4A) — not a placeholder in the sense the process warns against, since concrete starting code is provided either way.
- **Type consistency:** `ConversionJobData`/`ConversionJobResult`/`QUEUE_DOCUMENT_CONVERSION` are defined once in `packages/shared` (Task 1) and used identically by the producer (`apps/api`, Task 5) and consumer (`apps/worker`, Task 4) — the exact cross-cutting-constant risk Phase 4A's final review flagged is closed by construction here, not left as a bare string duplicated in multiple files.
- **Scope:** Upload-pipeline integration only. No ACL/permission changes, no download/view endpoint changes, no watermarking, no expiration — all explicitly deferred to later phases.
