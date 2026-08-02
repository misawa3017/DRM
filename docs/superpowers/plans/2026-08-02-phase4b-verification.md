# Phase 4B Verification

Full-suite verification of Phase 4B (Upload Pipeline Integration: synchronous
ClamAV virus scanning before store, asynchronous Office-to-PDF conversion via
`apps/worker` + Gotenberg), run against a completely fresh stack
(`docker compose down -v && docker compose up -d --build`) so that no state
from individual task-level testing (Tasks 1-5) carried over, with every
automated suite run together rather than in isolation, followed by a manual
walkthrough of all three upload outcomes (infected / clean Office / clean
plain-text).

## 1. Fresh full-stack rebuild

Host disk was at 82% (`df -h /`) before starting.

```
docker compose down -v && docker compose up -d --build
```

All 14 DRM containers and all named volumes (including `clamav_data`,
`postgres_data`, `keycloak_data`, `minio_data`, etc.) were destroyed —
confirmed via the `down -v` command's own output listing every volume
`Removed`. `docker compose ps --format '{{.Service}}: {{.CreatedAt}}'` after
the rebuild showed every container's `CreatedAt` at `05:54:38`-`05:54:41 UTC`,
consistent with a genuine fresh recreation (not a cached/reused container),
and matching the `down -v` timestamp of `05:46:21 UTC` plus the ~8-minute
image-build phase that preceded container creation.

**Image builds took noticeably longer than Phase 4A's** (roughly 8 minutes
for all three application images vs. a few minutes previously) — `apps/api`'s
`pnpm install` alone took 2m31s, and each image's final `exporting to image`
layer-write step took 55-100 seconds. This tracked directly with host
resource pressure: `free -h` showed swap climbing from ~1.7GiB used at the
start of the build to fully exhausted (0 free) at points during the run (see
below) on a host with only 1.9GiB of RAM, shared with several unrelated
projects also running (`isms-*`, `compassionate_elgamal`, `silly_hopper`).

**Disk hit 87% mid-rebuild**, inside the 84-88% range this project has
previously seen stall builds, coinciding with Keycloak's realm-import phase
throwing a real (if ultimately transient) H2 write error — see Section 2.
`docker builder prune -f` reclaimed 1.526GB of stale build-cache layers,
bringing disk back to 82%; this is the same precautionary step the plan's own
Global Constraints call for when disk pressure appears mid-build.

**ClamAV first-boot definition download: 9 minutes 29 seconds.** Measured
directly from `docker inspect drm-clamav-1`'s health-check log: container
created `2026-08-02T05:54:38Z`, first successful healthcheck (`Clamd is up`)
at `2026-08-02T06:04:07Z`. Within the range of both Phase 4A's 7m41s
observation and this project's prior ~13-minute observation on the same
host; well inside the 900s `start_period` budgeted in `docker-compose.yml`.

**Keycloak's cold start took 5 minutes 31 seconds** (`Keycloak 25.0.6 on JVM
... started in 331.072s`, from its own startup log) — slower than Phase 4A's
~3.5-minute observation. Immediately before finishing, Keycloak's log showed
a real, if self-recovering, error:

```
WARN [io.agroal.pool] (agroal-11) Datasource '<default>': General error:
"org.h2.mvstore.MVStoreException: Writing to sun.nio.ch.FileChannelImpl@...
failed; length 4096 at 8192 [2.2.224/2]"
```

This is Keycloak's own embedded H2 database (dev-mode `start-dev`, unrelated
to the project's Postgres) failing a write, coinciding with the disk-pressure
peak described above. It self-recovered on retry without intervention —
Keycloak's own Liquibase schema migration, master-realm init, and `drm` realm
import (from `realm-export.json`) all completed successfully moments later,
and `http://auth.drm.localhost/realms/drm/.well-known/openid-configuration`
returned `200` immediately after. The `docker builder prune -f` run in
response to the disk-pressure reading likely helped, though it's not certain
this specific H2 warning depended on it — noted here as a real, observed
symptom of this run's disk/memory pressure, not a code or config defect in
this phase's own changes.

Total wall time from `down -v` to the `docker compose up -d --build` command
itself returning (`EXIT:0`, once every `depends_on: condition: service_healthy`
chain — including `api`'s wait on `clamav`'s health — was satisfied): **~18.5
minutes**, dominated by the image-build phase (~8 min) and ClamAV's
definition download (~9.5 min, run in parallel with Keycloak's cold start).

## 2. Automated suites, run together — three real integration-only issues found

Per the task brief, all eight suites (`smoke-test.sh`, `api test`,
`api test:e2e`, `api lint`, `worker lint`, `web test`,
`verify-gotenberg.sh`, `verify-clamav.sh`) were run together, repeatedly,
specifically to surface integration-only issues. Three distinct, real issues
were found this way — none of them visible in any prior task's individual
testing — plus two occurrences of ClamAV crashing under memory pressure
(the same class of infrastructure issue Phase 4A first documented, not a new
code defect).

### 2a. `document-conversion.e2e-spec.ts`'s 40s test timeout, too tight for real infrastructure latency under combined load

The first full combined run's `api test:e2e` failed:

```
FAIL test/document-conversion.e2e-spec.ts
  thrown: "Exceeded timeout of 40000 ms for a test."
```

Investigation: the conversion pipeline had **not** actually failed. Gotenberg's
own access log recorded a genuine `200` response with `"latency_human":
"17.702273582s"` for this exact conversion — and a direct Postgres query for
the test's `documentVersionId` moments later showed `previewObjectKey` had
in fact been populated with a real object key. The full pipeline (enqueue →
worker pickup → MinIO fetch → Gotenberg convert → MinIO store → BullMQ
`completed` event over Redis → Prisma update) had genuinely completed — just
slower than the test's 40-second budget (30 x 1s poll + Jest's own 40000ms
timeout), because this run's real, concurrent load (other e2e suites running
in parallel, right after the fresh rebuild's residual memory/swap pressure)
made Gotenberg itself take over 4x longer than its typical sub-5s conversion
of a trivial document.

**Fix:** widened the poll loop to 90 x 1s and the Jest test timeout to
100000ms in `apps/api/test/document-conversion.e2e-spec.ts`, with a comment
explaining the real, measured latency that justified the change (not an
arbitrary bump). Re-ran `api test:e2e` immediately after: 13/13 suites,
31/31 tests, with `document-conversion.e2e-spec.ts` completing in 31.987s —
comfortably inside the new budget, confirming the pipeline itself was never
broken.

### 2b. `virus-scan.e2e-spec.ts` lint failure (the same class of gap Phase 4A's Task 6 found)

```
apps/api/test/virus-scan.e2e-spec.ts
  65:35  error  Unsafe member access .documents on an `any` value
```

`axios.get(...)` without a generic type parameter returns `AxiosResponse<any>`;
the test's `folderContentsRes.data.documents` access on that untyped `any`
correctly tripped `@typescript-eslint/no-unsafe-member-access`. This mirrors
Phase 4A's Task 6 finding almost exactly (an e2e test file that had never
been run through lint in the same pass as `test:e2e`).

**Fix:** extended the file's existing `FolderResponse` interface with an
`documents?: unknown[]` field (matching the identical pattern already used in
`folders.e2e-spec.ts`) and typed the `axios.get<FolderResponse>(...)` call
explicitly, rather than disabling the rule. Re-ran `api lint`: clean.

### 2c. `afterAll` hook timeout too tight for `container.stop()` under real memory pressure, across three testcontainer-based unit specs

During a later full combined run, `api test` failed:

```
FAIL src/prisma/user-persistence.spec.ts
  thrown: "Exceeded timeout of 5000 ms for a hook."
    at prisma/user-persistence.spec.ts:21:3  (afterAll)
```

and, in the same run, `audit/audit.service.spec.ts` hit the identical
failure at its own `afterAll`. Both files' `beforeAll` (which starts a real
`PostgreSqlContainer` via testcontainers) already carried an explicit
60000ms timeout — but `afterAll` (`prisma.$disconnect()` +
`container.stop()`) had no explicit timeout and fell back to Jest's default
5000ms. `container.stop()` is a real Docker operation, and this run's host
was under the same documented memory/swap pressure as everywhere else in
this task — 5 seconds proved genuinely too tight for it, twice, in two
different files.

**Fix:** added an explicit `60000` timeout to `afterAll` in all three
testcontainer-based unit spec files that share this exact pattern —
`apps/api/src/prisma/user-persistence.spec.ts`,
`apps/api/src/acl/acl.service.spec.ts`, and
`apps/api/src/audit/audit.service.spec.ts` — matching `beforeAll`'s existing
budget rather than inventing a new one, since teardown is the same class of
Docker operation as setup. Re-ran `api test` after the fix: all three files'
`afterAll` hooks completed well within budget across two subsequent runs
(30/30 tests passing each time).

**A fourth, distinct occurrence during the same investigation is not treated
as a fourth bug**: in a later run, `acl.service.spec.ts` failed again — this
time in `beforeAll` itself (`PostgreSqlContainer.start()` exceeding its
existing 60000ms budget), at a moment `free -h` showed swap at **exactly
0 bytes free** (3.8/3.8GiB used) — the single worst resource-pressure reading
observed across this entire task. This is a genuine, extreme host-level
resource exhaustion event, not a tunable-timeout gap like 2a/2c above:
`beforeAll`'s budget already matched the project's established convention,
and the same spec file passed cleanly (in 52.7s) on the very next run once
memory pressure eased. No code change was made for this occurrence — bumping
an already-generous timeout further would not fix a container genuinely
unable to start because the host had no memory left, and the two other real
fixes above already address every case where a *reasonable* timeout was
provably too tight for genuine (not exhausted) infrastructure latency.

### 2d. ClamAV crashed under memory pressure — twice, both times recovered per Phase 4A's established procedure

Twice during this task's repeated combined runs, `verify-clamav.sh` and/or
`api test:e2e`'s `virus-scan`/`document-conversion` suites failed with:

```
Error: connect ECONNREFUSED 172.19.0.5:3310
```

Both times, `docker exec drm-clamav-1 ps -eo pid,stat,args` confirmed the
root cause identically to Phase 4A: `clamd`'s process had gone to state `Z`
(zombie) under host memory pressure — a real crash, not a slowdown. Both
times, `docker compose ps`'s cached `healthy` status was stale (the 30s
healthcheck interval / 10-retry threshold hadn't yet caught the crash),
which is exactly why `verify-clamav.sh`'s direct scan attempt is a more
reliable check than trusting compose's cached health field alone.

**Fix (both times): `docker compose restart clamav`** — the same established
recovery Phase 4A documented. Recovery took longer on this run than Phase
4A's ~5-second observation (roughly 1-3 minutes each time, including one
stretch where `clamd`/`freshclam` sat in uninterruptible-sleep (`D`) state
while swap was fully exhausted) — consistent with this run's overall higher
memory pressure, not a change in ClamAV's own behavior. Both times, no fresh
virus-definition download was needed (the `clamav_data` volume persists
across a plain `restart`, only wiped by `down -v`), and both times
`./scripts/verify-clamav.sh` and the affected `api test:e2e` suites were
re-run immediately after and passed cleanly. No application or
infrastructure config change was made — this remains a real, recurring
operational characteristic of running this stack on a ~2GB-RAM host under
concurrent load, now observed in two consecutive phases (4A: once; 4B:
twice in one task), reinforcing Phase 4A's own carried-forward finding:
**future CI or dev-host sizing for this stack should budget more than
~2GB RAM.**

### Final clean runs, suite by suite

```
./scripts/smoke-test.sh
```
```
OK: http://api.drm.localhost/health
OK: http://auth.drm.localhost/realms/drm/.well-known/openid-configuration
OK: http://app.drm.localhost/
OK: http://storage.drm.localhost/
OK: http://127.0.0.1:9000/minio/health/live
OK: redis Health is healthy
OK: gotenberg Health is healthy
OK: clamav Health is healthy
OK: worker State is running
Smoke test passed.
```

```
pnpm --filter api test
```
**5 suites passed, 30 tests passed** (`user-persistence.spec.ts`,
`audit.service.spec.ts`, `acl.service.spec.ts`, `jwt.strategy.spec.ts`,
`health.controller.spec.ts`) — confirmed clean on the final run, completing
in 120s (vs. 257-259s on the runs that hit Section 2c's resource pressure).

```
pnpm --filter api test:e2e
```
**13 suites passed, 31 tests passed**, including both of Phase 4B's new
suites: `virus-scan.e2e-spec.ts` (real EICAR rejection + audit entry, real
clean-file acceptance) and `document-conversion.e2e-spec.ts` (real
Office-mimetype upload → real worker pickup → real Gotenberg conversion →
real MinIO PDF, verified by magic bytes, not just a DB column).

```
pnpm --filter api lint
```
Clean — no errors, no warnings.

```
pnpm --filter worker lint
```
Clean — no errors, no warnings.

```
pnpm --filter web test
```
**1 file passed, 2 tests passed** (`Home.test.tsx`).

```
./scripts/verify-gotenberg.sh
```
```
Converting test.txt to PDF via Gotenberg...
Confirming the output is a real PDF...
Gotenberg verification passed. Output size: 15097 bytes.
```

```
./scripts/verify-clamav.sh
```
```
Scanning the EICAR test file (must be detected)...
{"isInfected":true,"viruses":["Eicar-Test-Signature"]}
Scanning the clean file (must pass)...
{"isInfected":false,"viruses":[]}
ClamAV verification passed: EICAR detected, clean file passed.
```

All eight checks pass, with both real code fixes (Sections 2a, 2c) and the
lint fix (2b) confirmed in place, and ClamAV's `healthy` status confirmed
immediately before and after the final sequence.

## 3. Manual walkthrough

Performed as `testadmin` (the seeded admin user from
`keycloak/realm-export.json`) against the live, freshly-rebuilt stack, via
direct HTTP calls (not the automated suites) — a folder was created first
(`POST /folders`), then three uploads into it:

**3a. Infected upload (EICAR test string, base64-decoded at runtime, never
committed as a literal):**
```
POST /documents  ->  400 Bad Request
{"message":"Upload rejected: infected file detected (Eicar-Test-Signature)", ...}
```
Confirmed via `GET /folders/:id`: `"documents": []` — no `Document` row was
ever created. Confirmed via `GET /folders/:id/audit-logs`: a `virus_detected`
entry was recorded (`resourceType: "folder"`, `resourceId` matching the
folder), sequenced correctly into the hash chain between the `folder_create`
and subsequent `folder_view` entries.

**3b. Clean Office-mimetype upload** (`application/vnd.openxmlformats-officedocument.wordprocessingml.document`):
```
POST /documents  ->  201 Created
"currentVersion": {"previewObjectKey": null, ...}
```
Accepted immediately, `previewObjectKey` starts `null` as expected.
`GET /documents/:id` was polled once per second; `previewObjectKey` was
populated after **1 second** (`...-preview-e500e4cd-....pdf`). The preview
object was then fetched directly from MinIO (`docker run ... minio/mc cat`,
using the `drm-api` scoped credential) and confirmed to be a genuine PDF: its
first bytes were `%PDF-1.7`, 14,690 bytes total — not merely a string in the
`previewObjectKey` column, but a real, retrievable PDF object in the
`documents` bucket.

**3c. Clean plain-text upload** (`text/plain`):
```
POST /documents  ->  201 Created
"currentVersion": {"previewObjectKey": null, ...}
```
Accepted, and `previewObjectKey` was confirmed still `null` via
`GET /documents/:id` after a 6-second wait (no conversion job is enqueued
for a non-Office mimetype, per `DocumentsService`'s `OFFICE_MIME_TYPES`
allow-list — a plain-text upload never touches the queue at all).

All three manual-walkthrough cases from the task brief were exercised and
matched expectations exactly, against a stack that had not been touched by
any of this task's own automated test runs moments before (fresh folder,
fresh documents, real HTTP calls).

## Files changed

- `apps/api/test/document-conversion.e2e-spec.ts` — widened the
  preview-polling loop (30 → 90 iterations) and the test's own Jest timeout
  (40000 → 100000ms), with a comment recording the real 17.7s Gotenberg
  latency this task's combined run measured (Section 2a).
- `apps/api/test/virus-scan.e2e-spec.ts` — typed the `axios.get` folder-read
  call (`FolderResponse` extended with `documents?: unknown[]`, matching
  `folders.e2e-spec.ts`'s existing pattern), fixing the lint error Section 2b
  found (a real gap, not previously caught because lint had never run
  against this file in the same pass as `test:e2e`).
- `apps/api/src/prisma/user-persistence.spec.ts`,
  `apps/api/src/acl/acl.service.spec.ts`,
  `apps/api/src/audit/audit.service.spec.ts` — added an explicit 60000ms
  timeout to each file's `afterAll` hook (matching each file's existing
  `beforeAll` budget), fixing the real `container.stop()` timeout Section 2c
  found in two of the three files, applied preemptively to the third since
  all three share the identical testcontainers teardown pattern.
- `docs/superpowers/plans/2026-08-02-phase4b-verification.md` — this
  document.

## Result

All automated suites pass together on a fresh, fully-rebuilt stack: smoke
test (9/9 checks); 5/5 API unit suites, 30/30 unit tests; 13/13 API e2e
suites, 31/31 e2e tests (including both of this phase's new suites,
`virus-scan` and `document-conversion`, the latter verified against a real
PDF's magic bytes in MinIO, not just a DB column); API lint clean; worker
lint clean; 1/1 web suite, 2/2 web tests; Gotenberg conversion verified
against a real document; ClamAV verified against both a real EICAR detection
and a clean-file pass.

Three real, integration-only issues were found and fixed exactly as this
task's brief anticipated — a test timeout too tight for genuine (measured,
not hypothetical) infrastructure latency under combined-suite load
(Section 2a), a lint gap in an e2e test file never previously run through
lint in the same pass as `test:e2e` (Section 2b, the same class of issue
Phase 4A's Task 6 found), and an `afterAll` hook timeout gap across three
testcontainer-based unit specs (Section 2c). Additionally, ClamAV crashed
under this host's real memory pressure twice during this task's repeated
combined runs (Section 2d) — both recovered via Phase 4A's established
`docker compose restart clamav` procedure, with no code or config change,
reinforcing that finding's carried-forward conclusion that this host's
~2GB RAM is genuinely undersized for this stack's concurrent load.

The manual walkthrough confirmed all three of the design spec's upload
outcomes work correctly end-to-end on the freshly rebuilt stack: an infected
upload is rejected before any storage or database write and is audited as a
deliberate exception to Phase 3's success-only audit principle; a clean
Office-mimetype upload is accepted immediately and asynchronously gains a
real, verified PDF preview within seconds; a clean plain-text upload is
accepted and correctly never enters the conversion pipeline at all.

Phase 4B's upload pipeline — synchronous ClamAV virus scanning before any
write, and asynchronous Office-to-PDF conversion via `apps/worker` and
Gotenberg — is verified working together, from a completely fresh
`docker compose up`, alongside the full existing stack built across Phases
1 through 4A.
