# Phase 4A: Background Job Infrastructure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the background-job processing chain — Redis, BullMQ, a new `apps/worker` process, Gotenberg (Office→PDF conversion), and ClamAV (virus scanning) — verified end-to-end by actually enqueueing a job and confirming the worker processes it, actually converting a test document through Gotenberg, and actually detecting a known test-virus signature through ClamAV. No document-upload business logic changes here — this phase is infrastructure only, the same split Phase 2A/2B used for storage.

**Architecture:** A new NestJS process, `apps/worker`, runs alongside `apps/api` — no HTTP server, just a BullMQ `Worker` (via `@nestjs/bullmq`) consuming jobs from Redis. `apps/api` gains a `JobsModule` that can enqueue jobs onto named BullMQ queues. Gotenberg and ClamAV are added as their own Docker Compose services, reachable from `apps/worker` (Phase 4B will be the one that actually calls them as part of the real upload pipeline — this phase just proves they work).

**Tech Stack:** Redis 7, BullMQ (`bullmq` + `@nestjs/bullmq`), Gotenberg (`gotenberg/gotenberg`), ClamAV (`clamav/clamav`, daemon mode), Jest e2e tests hitting the real running services (this project's established testing convention — no mocked infrastructure).

## Global Constraints

- **This phase adds infrastructure only.** No changes to `FoldersService`/`DocumentsService`/`PermissionsService`, no new columns on `Document` (`watermarkEnabled`/`expiresAt` are Phase 4C's job), no upload-pipeline wiring to Gotenberg/ClamAV (Phase 4B's job). The only new business-facing surface is a `health-check` BullMQ queue used purely to prove the pipeline works — it has no product purpose beyond this phase's own verification.
- **`apps/worker` has no Prisma/database access in this phase**, deliberately. Phase 4B's jobs (document conversion, virus scan) will need to read/write `Document`/`DocumentVersion` rows and talk to MinIO — whether that means duplicating `apps/api`'s Prisma schema into `apps/worker` or extracting a shared `packages/database` workspace package is a real design decision with a moderate-sized refactor either way, and is explicitly **deferred to Phase 4B**, not decided here. Keeping this phase DB-free avoids making that call prematurely.
- **Redis, Gotenberg, and ClamAV are new Docker Compose services.** Redis is published to the host loopback on port `6380` (not `6379` — that port is already used by an unrelated project's container on this host, `isms-redis-1`; matches the project's existing pattern of picking an alternate port for Postgres when `5432` was already taken in Phase 1). Gotenberg and ClamAV are internal-only (no host port publish needed — nothing outside the Docker network talks to them directly; verification scripts run as one-off containers on the same Docker network, matching the pattern already established by `scripts/verify-encrypted-storage.sh`).
- **`@nestjs/bullmq`'s exact API (decorator names, `BullModule.forRoot`/`registerQueue` option shapes) is not guaranteed correct from memory** — this plan gives a concrete best-effort starting point, but verify against the actually-installed package's types/docs before trusting it, the same disclosed-uncertainty approach Phase 2A used for KES's config schema.
- **ClamAV's clamd wire protocol is not hand-rolled.** Use an established npm client library for the `INSTREAM` protocol rather than implementing the length-prefixed chunk framing by hand — verify a suitable package actually exists and works before committing to it; if none does, hand-rolling is a fallback, not the default.
- **ClamAV's first startup downloads virus definitions from an external mirror and can be slow** (multiple minutes, network-dependent) — this is a real, disclosed operational risk, not a bug if the container takes a while to become ready the first time. Don't assume a fast healthcheck timeout will work without checking real startup behavior first.
- Real integration tests: the worker's job processing is proven by an e2e test that talks to the real Redis (via BullMQ's `Queue` class directly, bypassing HTTP — following the same "test the real thing, not a wrapper" pattern as `storage.e2e-spec.ts`) and confirms the real `apps/worker` container actually processed the job, not just that it was enqueued.
- Docker daemon on this host is sometimes under load from unrelated processes, and this session has repeatedly hit disk-space stalls during `docker compose build` — check `df -h /` and prune (`docker builder prune -f`, `docker image prune -f`, or more aggressively `docker image prune -a -f --filter "until=48h"` if plain prune reclaims 0B) if a build hangs unusually long. Verify a container was actually recreated after any rebuild (image ID/start-time comparison), not just that the build command exited 0 — this has been a real, recurring issue in this project.

---

### Task 1: Redis service + BullMQ producer in `apps/api`

**Files:**
- Modify: `docker-compose.yml` (add `redis` service + volume)
- Modify: `.env.example` (if any Redis credentials are needed — plain Redis with no auth is fine for this internal-only dev/single-VM deployment, matching the project's existing posture for internal services; note this explicitly rather than silently deciding it)
- Create: `apps/api/src/jobs/jobs.module.ts`
- Create: `apps/api/src/jobs/health-check.service.ts`
- Modify: `apps/api/src/app.module.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: a `health-check` BullMQ queue reachable from `apps/api`; `HealthCheckService.enqueuePing(): Promise<string>` (returns the enqueued job's id) for Task 3's e2e test to use.

- [ ] **Step 1: Add `redis` to `docker-compose.yml`**

```yaml
  redis:
    image: redis:7-alpine
    command: redis-server --save "" --appendonly no
    ports:
      - "127.0.0.1:6380:6379"
    volumes:
      - redis_data:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 5s
      retries: 10
    restart: unless-stopped
```

(`--save "" --appendonly no` disables persistence — this Redis instance is purely a BullMQ job queue backend, not a source of truth; losing queued-but-not-yet-processed jobs on a restart is an acceptable dev-environment tradeoff, not data loss of anything durable. `redis_data` volume is still declared for the rare case something needs inspecting, but persistence itself is off.)

Add `redis_data:` to the top-level `volumes:` block.

- [ ] **Step 2: Add BullMQ dependencies to `apps/api`**

Add to `apps/api/package.json` `dependencies`:

```json
    "@nestjs/bullmq": "^10.2.1",
    "bullmq": "^5.12.0",
```

Run: `cd apps/api && pnpm install`

Before writing any code against these packages, check their actually-installed types (`node_modules/@nestjs/bullmq/dist/*.d.ts`, or the package's README) to confirm the real API shape — the code below is a best-effort draft, not a guarantee.

- [ ] **Step 3: Create `apps/api/src/jobs/jobs.module.ts`**

```ts
import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { HealthCheckService } from './health-check.service';

@Module({
  imports: [
    BullModule.forRoot({
      connection: {
        host: process.env.REDIS_HOST ?? 'redis',
        port: Number(process.env.REDIS_PORT ?? 6379),
      },
    }),
    BullModule.registerQueue({
      name: 'health-check',
    }),
  ],
  providers: [HealthCheckService],
  exports: [HealthCheckService],
})
export class JobsModule {}
```

- [ ] **Step 4: Create `apps/api/src/jobs/health-check.service.ts`**

```ts
import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';

@Injectable()
export class HealthCheckService {
  constructor(@InjectQueue('health-check') private readonly queue: Queue) {}

  async enqueuePing(): Promise<string> {
    const job = await this.queue.add('ping', { requestedAt: new Date().toISOString() });
    return job.id!;
  }
}
```

- [ ] **Step 5: Add `REDIS_HOST`/`REDIS_PORT` to the `api` service's environment in `docker-compose.yml`**

```yaml
      REDIS_HOST: redis
      REDIS_PORT: 6379
```

(Internal Docker-network address/port — the `127.0.0.1:6380` loopback publish from Step 1 is only for host-side test access, not what the `api`/`worker` containers use to reach each other.)

Add `redis: condition: service_healthy` to the `api` service's `depends_on`.

- [ ] **Step 6: Wire `JobsModule` into `AppModule`**

Add `JobsModule` to the `imports` array in `apps/api/src/app.module.ts`.

- [ ] **Step 7: Verify the build and a real enqueue**

Run: `docker compose up -d --build api redis` (verify actual `api` container recreation via image ID/start-time)
Once both are healthy, confirm a job can actually be enqueued from inside the running container:

Run: `docker compose exec api node -e "const {Queue} = require('bullmq'); const q = new Queue('health-check', {connection: {host: 'redis', port: 6379}}); q.add('ping', {test: true}).then(j => { console.log('enqueued', j.id); process.exit(0); });"`

Expected: prints `enqueued <some-id>` and exits 0. (There's no worker running yet to consume it — that's fine, the job just sits in the queue; this step only proves the connection/enqueue path works.)

- [ ] **Step 8: Commit**

```bash
git add docker-compose.yml apps/api/package.json apps/api/pnpm-lock.yaml apps/api/src/jobs apps/api/src/app.module.ts
git commit -m "feat(infra): add Redis and BullMQ producer (health-check queue)"
```

---

### Task 2: `apps/worker` scaffold + health-check processor

**Files:**
- Create: `apps/worker/package.json`
- Create: `apps/worker/tsconfig.json`
- Create: `apps/worker/tsconfig.build.json`
- Create: `apps/worker/nest-cli.json`
- Create: `apps/worker/src/main.ts`
- Create: `apps/worker/src/app.module.ts`
- Create: `apps/worker/src/health-check/health-check.processor.ts`
- Create: `apps/worker/src/health-check/health-check.module.ts`
- Create: `apps/worker/Dockerfile`
- Modify: `docker-compose.yml` (add `worker` service)

**Interfaces:**
- Consumes: the `health-check` BullMQ queue (Task 1), the same Redis instance.
- Produces: a running `apps/worker` process that consumes `ping` jobs from the `health-check` queue and returns a distinctive, checkable result (used by Task 3's e2e test).

- [ ] **Step 1: Create `apps/worker/package.json`**

```json
{
  "name": "worker",
  "version": "0.1.0",
  "private": true,
  "packageManager": "pnpm@9.7.0",
  "scripts": {
    "build": "nest build",
    "start": "nest start",
    "start:dev": "nest start --watch"
  },
  "dependencies": {
    "@nestjs/bullmq": "^10.2.1",
    "@nestjs/common": "^10.4.0",
    "@nestjs/core": "^10.4.0",
    "bullmq": "^5.12.0",
    "reflect-metadata": "^0.2.2",
    "rxjs": "^7.8.1"
  },
  "devDependencies": {
    "@nestjs/cli": "^10.4.5",
    "@types/node": "^20.14.0",
    "typescript": "^5.5.4"
  }
}
```

(No `@nestjs/platform-express` — this process never serves HTTP, so no need for it. No `@nestjs/testing`/Jest here either — this app's own logic is exercised entirely by `apps/api`'s e2e tests in Task 3, following the plan's Global Constraint that this phase's verification lives at the integration level, not a separate unit-test harness for a process with no business logic yet.)

- [ ] **Step 2: Create `apps/worker/tsconfig.json`**

```json
{
  "compilerOptions": {
    "module": "commonjs",
    "target": "ES2021",
    "moduleResolution": "node",
    "declaration": false,
    "sourceMap": true,
    "outDir": "./dist",
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true,
    "strict": true,
    "skipLibCheck": true,
    "esModuleInterop": true
  }
}
```

- [ ] **Step 3: Create `apps/worker/tsconfig.build.json`**

```json
{
  "extends": "./tsconfig.json",
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 4: Create `apps/worker/nest-cli.json`**

```json
{
  "collection": "@nestjs/schematics",
  "sourceRoot": "src"
}
```

- [ ] **Step 5: Create `apps/worker/src/health-check/health-check.processor.ts`**

```ts
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import * as os from 'os';

@Processor('health-check')
export class HealthCheckProcessor extends WorkerHost {
  async process(job: Job): Promise<{ pong: true; processedAt: string; workerHostname: string }> {
    return {
      pong: true,
      processedAt: new Date().toISOString(),
      workerHostname: os.hostname(),
    };
  }
}
```

Verify `@nestjs/bullmq`'s real `Processor`/`WorkerHost` API against the installed package before trusting this exactly — per the Global Constraints, this is a best-effort draft.

- [ ] **Step 6: Create `apps/worker/src/health-check/health-check.module.ts`**

```ts
import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { HealthCheckProcessor } from './health-check.processor';

@Module({
  imports: [BullModule.registerQueue({ name: 'health-check' })],
  providers: [HealthCheckProcessor],
})
export class HealthCheckModule {}
```

- [ ] **Step 7: Create `apps/worker/src/app.module.ts`**

```ts
import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { HealthCheckModule } from './health-check/health-check.module';

@Module({
  imports: [
    BullModule.forRoot({
      connection: {
        host: process.env.REDIS_HOST ?? 'redis',
        port: Number(process.env.REDIS_PORT ?? 6379),
      },
    }),
    HealthCheckModule,
  ],
})
export class AppModule {}
```

- [ ] **Step 8: Create `apps/worker/src/main.ts`**

This process has no HTTP surface — it's a pure background consumer, so it uses `createApplicationContext`, not `create`.

```ts
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  await NestFactory.createApplicationContext(AppModule);
  console.log('Worker started, listening for jobs...');
}
bootstrap();
```

- [ ] **Step 9: Verify locally before containerizing**

Run: `cd apps/worker && pnpm install && pnpm run build`
Expected: no TypeScript errors.

- [ ] **Step 10: Create `apps/worker/Dockerfile`**

Follows the same root-context, multi-stage pattern established by `apps/api/Dockerfile` (repo root as build context, since the pnpm lockfile is only at the repo root).

```dockerfile
FROM node:20-alpine AS build
WORKDIR /repo
RUN corepack enable
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY apps/worker/package.json apps/worker/package.json
RUN pnpm install --frozen-lockfile
COPY apps/worker ./apps/worker
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

- [ ] **Step 11: Add `worker` service to `docker-compose.yml`**

```yaml
  worker:
    build:
      context: .
      dockerfile: apps/worker/Dockerfile
    environment:
      REDIS_HOST: redis
      REDIS_PORT: 6379
    depends_on:
      redis:
        condition: service_healthy
    restart: unless-stopped
```

(No `ports:` — this process serves nothing over HTTP, nothing outside the Docker network needs to reach it directly.)

- [ ] **Step 12: Bring it up and confirm it starts cleanly**

Run: `docker compose up -d --build worker`
Run: `docker compose logs worker`
Expected: `Worker started, listening for jobs...` with no errors. If `@nestjs/bullmq`'s real API differs from Step 5-7's draft, this is where it'll surface — fix based on the actual error, iterate against real behavior.

- [ ] **Step 13: Commit**

```bash
git add apps/worker docker-compose.yml
git commit -m "feat(worker): scaffold apps/worker with health-check job processor"
```

---

### Task 3: End-to-end job processing verification

**Files:**
- Create: `apps/api/test/jobs.e2e-spec.ts`

**Interfaces:**
- Consumes: `HealthCheckService.enqueuePing` is available but this test deliberately bypasses HTTP entirely and talks to Redis directly via `bullmq`'s `Queue` class, the same way `storage.e2e-spec.ts` bypasses HTTP to test `StorageService` directly — proving the real infrastructure works, not a wrapper around it.
- Produces: proof that a job enqueued from outside the containers is picked up and processed by the real `apps/worker` container.

- [ ] **Step 1: Add `bullmq` as a dev dependency for the test (if not already available)**

`apps/api` already depends on `bullmq` directly (Task 1), so no change needed here — the e2e test can `import { Queue, QueueEvents } from 'bullmq'` directly.

- [ ] **Step 2: Write the test**

`apps/api/test/jobs.e2e-spec.ts`:

```ts
import { Queue, QueueEvents } from 'bullmq';

const REDIS_CONNECTION = { host: '127.0.0.1', port: 6380 };

describe('Background job processing (e2e, real worker)', () => {
  let queue: Queue;
  let queueEvents: QueueEvents;

  beforeAll(() => {
    queue = new Queue('health-check', { connection: REDIS_CONNECTION });
    queueEvents = new QueueEvents('health-check', { connection: REDIS_CONNECTION });
  });

  afterAll(async () => {
    await queue.close();
    await queueEvents.close();
  });

  it('a job enqueued from the host is picked up and processed by the real worker container', async () => {
    const job = await queue.add('ping', { source: 'e2e-test', requestedAt: new Date().toISOString() });

    const result = await job.waitUntilFinished(queueEvents, 15000);

    expect(result).toMatchObject({ pong: true });
    expect(typeof result.workerHostname).toBe('string');
    expect(result.workerHostname.length).toBeGreaterThan(0);
  });
});
```

`result.workerHostname` being a real, non-empty string (in practice, the `worker` container's own hostname, which Docker sets to the container ID) is meaningful evidence this ran inside the actual `worker` container, not some other process — note the specific value you observe in your report rather than just trusting the assertion passes.

- [ ] **Step 3: Run it against the live stack**

Precondition: `docker compose ps` shows `redis` and `worker` both up (worker doesn't have a "healthy" healthcheck defined, just check it's running and its logs show no crash loop).

Run: `cd apps/api && pnpm test:e2e -- jobs`
Expected: PASS. If it times out, check `docker compose logs worker` for a crash or connection error before assuming the test itself is wrong.

- [ ] **Step 4: Commit**

```bash
git add apps/api/test/jobs.e2e-spec.ts
git commit -m "test(infra): verify a real job round-trips through Redis to the worker container"
```

---

### Task 4: Gotenberg service + conversion verification

**Files:**
- Modify: `docker-compose.yml` (add `gotenberg` service)
- Create: `scripts/verify-gotenberg.sh`

**Interfaces:**
- Consumes: nothing new.
- Produces: a running Gotenberg instance reachable at `http://gotenberg:3000` on the Docker network, verified to actually convert a document to PDF (not just report itself healthy).

- [ ] **Step 1: Add `gotenberg` to `docker-compose.yml`**

```yaml
  gotenberg:
    image: gotenberg/gotenberg:8
    healthcheck:
      test: ["CMD", "curl", "-f", "http://127.0.0.1:3000/health"]
      interval: 5s
      timeout: 5s
      retries: 20
    restart: unless-stopped
```

(No host port publish — internal Docker network only. Gotenberg's own `/health` endpoint is a real liveness check, not just "container is up.")

- [ ] **Step 2: Bring it up**

Run: `docker compose up -d gotenberg`
Wait for healthy: `docker compose ps gotenberg`

- [ ] **Step 3: Create `scripts/verify-gotenberg.sh`**

Converts a trivial plain-text fixture to PDF via Gotenberg's LibreOffice route (which handles `.txt` along with real Office formats) and confirms the response is a genuine PDF.

```bash
#!/usr/bin/env bash
set -euo pipefail

WORKDIR=$(mktemp -d)
trap 'rm -rf "$WORKDIR"' EXIT

echo "Phase 4A Gotenberg verification $(date -u +%FT%TZ)" > "$WORKDIR/test.txt"

echo "Converting test.txt to PDF via Gotenberg..."
docker run --rm --network drm_default -v "$WORKDIR:$WORKDIR" curlimages/curl:latest \
  -sf -X POST http://gotenberg:3000/forms/libreoffice/convert \
  -F "files=@$WORKDIR/test.txt" \
  -o "$WORKDIR/output.pdf"

echo "Confirming the output is a real PDF..."
if [ "$(head -c 4 "$WORKDIR/output.pdf")" != "%PDF" ]; then
  echo "FAIL: output does not start with the PDF magic bytes" >&2
  exit 1
fi

echo "Gotenberg verification passed. Output size: $(wc -c < "$WORKDIR/output.pdf") bytes."
```

(Adjust the exact form field name / route path based on what Gotenberg 8's real API expects if this draft is off — check `https://gotenberg.dev` documentation reachable from the running container's own `/health`/error responses, or Gotenberg's own error messages when a request is malformed, which are typically explicit about what's expected. The `--network drm_default` name should be verified against `docker network ls`, matching the same caution already noted in Phase 2A's verification script.)

- [ ] **Step 4: Run it**

Run: `chmod +x scripts/verify-gotenberg.sh && ./scripts/verify-gotenberg.sh`
Expected: "Gotenberg verification passed."

- [ ] **Step 5: Commit**

```bash
git add docker-compose.yml scripts/verify-gotenberg.sh
git commit -m "feat(infra): add Gotenberg, verify real document conversion"
```

---

### Task 5: ClamAV service + virus-scan verification

**Files:**
- Modify: `docker-compose.yml` (add `clamav` service)
- Create: `scripts/verify-clamav.sh`

**Interfaces:**
- Consumes: nothing new.
- Produces: a running ClamAV daemon reachable at `clamav:3310` on the Docker network, verified to actually detect a known test-virus signature (the EICAR test string) AND correctly pass a clean file.

- [ ] **Step 1: Add `clamav` to `docker-compose.yml`**

```yaml
  clamav:
    image: clamav/clamav:stable
    healthcheck:
      test: ["CMD", "sh", "-c", "clamdcheck.sh || echo unhealthy"]
      interval: 30s
      timeout: 10s
      retries: 20
      start_period: 300s
    restart: unless-stopped
```

`start_period: 300s` is deliberately generous — per the Global Constraints, first-boot definition-database download can take several minutes and is network-dependent. `clamdcheck.sh` is the image's own bundled healthcheck script; verify it actually exists in this image tag before trusting it (`docker compose exec clamav which clamdcheck.sh` or equivalent) and adjust if the real image uses a different mechanism.

- [ ] **Step 2: Bring it up and be patient**

Run: `docker compose up -d clamav`
Run: `docker compose logs -f clamav` (watch until you see it report ready / definitions loaded — this may take several minutes on first run; do not conclude something is broken just because it's slow)
Confirm healthy: `docker compose ps clamav`

- [ ] **Step 3: Find a real npm client for clamd's protocol**

Before writing `scripts/verify-clamav.sh`, check whether a maintained npm package exists for clamd's `INSTREAM` protocol (candidates to check: `clamdjs`, `clamscan` — verify actual npm registry state and pick whichever is real/maintained/simplest, rather than assuming one exists sight-unseen). If nothing suitable exists, hand-roll a minimal TCP client for the `INSTREAM` command (length-prefixed chunks of the file content, followed by a zero-length chunk, reading the response line) — the protocol is simple enough to implement directly as a fallback, but check for an existing library first.

- [ ] **Step 4: Create `scripts/verify-clamav.sh`**

Tests both directions: a known-malicious test signature is correctly flagged, and a benign file is correctly cleared. The EICAR test string is the industry-standard safe way to test antivirus detection — it is not a real virus, every AV engine (including ClamAV) is specifically designed to flag it as `Win.Test.EICAR_HDB-1` or similar, and it's safe to keep in a git-ignored test scratch location (do not commit the literal EICAR string to a tracked file — some tooling/scanners flag it on sight, which is expected and fine, just keep it out of tracked source).

```bash
#!/usr/bin/env bash
set -euo pipefail

WORKDIR=$(mktemp -d)
trap 'rm -rf "$WORKDIR"' EXIT

# The standard EICAR antivirus test string -- not a real virus, every AV
# engine is designed to flag it. Kept in a scratch tempdir, never committed.
printf 'X5O!P%%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*' > "$WORKDIR/eicar.txt"
echo "This is a clean, benign test file for Phase 4A verification." > "$WORKDIR/clean.txt"

echo "Scanning the EICAR test file (must be detected)..."
# Adjust this invocation once Step 3 has picked a real client library/approach.
# Placeholder shape -- replace with the actual chosen tool's real CLI/API:
docker run --rm --network drm_default -v "$WORKDIR:$WORKDIR" <clamav-client-image-or-tool> \
  scan --host clamav --port 3310 "$WORKDIR/eicar.txt" | tee "$WORKDIR/eicar-result.txt"

if ! grep -qi "found\|eicar" "$WORKDIR/eicar-result.txt"; then
  echo "FAIL: EICAR test file was not detected" >&2
  exit 1
fi

echo "Scanning the clean file (must pass)..."
docker run --rm --network drm_default -v "$WORKDIR:$WORKDIR" <clamav-client-image-or-tool> \
  scan --host clamav --port 3310 "$WORKDIR/clean.txt" | tee "$WORKDIR/clean-result.txt"

if grep -qi "found" "$WORKDIR/clean-result.txt"; then
  echo "FAIL: clean file was incorrectly flagged" >&2
  exit 1
fi

echo "ClamAV verification passed: EICAR detected, clean file passed."
```

This script's exact scan-invocation shape is explicitly a placeholder for Step 3's real tooling choice — fill it in for real, don't leave `<clamav-client-image-or-tool>` in the committed version. The two assertions (EICAR flagged, clean file passes) are the actual requirement; the mechanism is yours to determine correctly.

- [ ] **Step 5: Run it**

Run: `chmod +x scripts/verify-clamav.sh && ./scripts/verify-clamav.sh`
Expected: "ClamAV verification passed: EICAR detected, clean file passed."

- [ ] **Step 6: Commit**

```bash
git add docker-compose.yml scripts/verify-clamav.sh
git commit -m "feat(infra): add ClamAV, verify real virus detection and clean-file pass"
```

---

### Task 6: Full-stack verification

**Files:**
- Modify: `scripts/smoke-test.sh`
- Create: `docs/superpowers/plans/2026-08-01-phase4a-verification.md`

**Interfaces:**
- Consumes: everything from Tasks 1-5.
- Produces: confirmation the whole background-job infrastructure works together, fresh, alongside the existing stack.

- [ ] **Step 1: Extend `scripts/smoke-test.sh`**

None of this phase's new services (`redis`, `gotenberg`, `clamav`, `worker`) publish an HTTP port to the host, so the script's existing `check()` helper (which does an HTTP GET) doesn't apply to them directly. Add a second helper that checks container health/state via `docker compose ps`, and use it for the new services:

```bash
check_container_state() {
  local service=$1
  local expected=$2
  local actual
  actual=$(docker compose ps --format '{{.State}}' "$service")
  if [ "$actual" != "$expected" ]; then
    echo "FAIL: $service state is '$actual', expected '$expected'" >&2
    exit 1
  fi
  echo "OK: $service is $expected"
}

check_container_state "redis" "running"
check_container_state "gotenberg" "running"
check_container_state "clamav" "running"
check_container_state "worker" "running"
```

Adjust the exact `docker compose ps --format` field/value if `{{.State}}` doesn't report what you expect on this Docker Compose version — verify against real output (`docker compose ps --format '{{.Service}} {{.State}} {{.Health}}'`) before trusting the snippet above, and prefer checking `{{.Health}}` (`healthy`) instead of `{{.State}}` (`running`) for any of these four services that actually has a healthcheck defined (per Tasks 1/4/5, that's `redis`, `gotenberg`, `clamav` — `worker` has no healthcheck, so `running` is the right bar for it specifically).

- [ ] **Step 2: Fresh full-stack rebuild**

Run: `docker compose down -v && docker compose up -d --build`
Wait for all services healthy (Keycloak cold start ~90-170s under load; ClamAV first-boot definition download can take several minutes — be patient, per Task 5's note).

- [ ] **Step 3: Run every automated suite together**

`./scripts/smoke-test.sh`, `pnpm --filter api test`, `pnpm --filter api test:e2e`, `pnpm --filter api lint`, `pnpm --filter web test`, `./scripts/verify-gotenberg.sh`, `./scripts/verify-clamav.sh`. All must pass together, not just individually.

- [ ] **Step 4: Write `docs/superpowers/plans/2026-08-01-phase4a-verification.md`**

Record suite results and a short narrative of what was verified, following the format of `docs/superpowers/plans/2026-08-01-phase3-verification.md`. Note real observed ClamAV startup time (for future reference — this affects how patient future `docker compose up` scripts/CI need to be).

- [ ] **Step 5: Commit**

```bash
git add scripts/smoke-test.sh docs/superpowers/plans/2026-08-01-phase4a-verification.md
git commit -m "docs: add Phase 4A verification record, extend smoke test for new services"
```

---

## Self-Review Notes

- **Spec coverage:** Covers exactly the infrastructure prerequisites for Phase 4B (upload-pipeline integration: virus scanning + Office conversion) and Phase 4C (watermarking + expiration, which needs Redis/BullMQ/worker for the expiration scheduled job but not Gotenberg/ClamAV). No business logic — document upload/download/ACL flows are completely untouched.
- **Placeholder scan:** Two intentional, explicitly-flagged placeholders exist and are called out as needing real resolution during implementation, not silently guessed: the ClamAV client tooling choice (Task 5, Step 3-4) and the smoke-test extension shape (Task 6, Step 1) — both require checking real, currently-available tooling/output rather than a value this plan can responsibly hard-code from training knowledge alone. This mirrors Phase 2A's disclosed-uncertainty approach for KES's config schema, which worked well there.
- **Type consistency:** The `health-check` queue name and its `ping` job type are used identically across `apps/api` (producer) and `apps/worker` (consumer) — defined once in Task 1, consumed in Task 2, verified in Task 3.
- **Scope:** Infrastructure only, as agreed when this phase was split from the original combined Phase 4 scope. No `Document` schema changes, no upload-flow changes — both explicitly deferred to Phase 4B/4C.
