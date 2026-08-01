# Phase 3 Verification

Full-suite verification of Phase 3 (Audit Logging), run against a completely
fresh stack (`docker compose down -v && docker compose up -d --build`) so
that no state from individual task-level testing carried over, followed by a
real manual walkthrough of the audit trail — including a deliberate tamper
test against the live database — that Tasks 1-6's automated tests alone
cannot exercise.

## 1. Fresh full-stack rebuild

Host disk was at 86% (`df -h /`) before the rebuild, above the ~85%
threshold flagged in the task brief. `docker builder prune -f` alone
reclaimed 0B (nothing dangling in the active cache), so `docker image prune
-a -f --filter "until=48h"` and then `docker builder prune -a -f` were run,
reclaiming enough to bring usage to 80% before starting the build.

```
docker compose down -v && docker compose up -d --build
```

All 8 DRM containers (`traefik`, `postgres`, `keycloak`, `api`, `web`,
`openbao`, `openbao-init`, `kes`, `minio`, `minio-init`) were destroyed
(including named volumes) and recreated from scratch. Confirmed no `drm-*`
containers survived `down -v` (`docker ps -a | grep drm` returned nothing,
exit code 1) and that every container's `CreatedAt` timestamp from `docker
compose ps` matched the moment of the `up -d --build` run (all created
within the same minute), not a stale/reused container.

Keycloak's cold start (fresh volume — full schema migration plus realm
import) took a little over 4 minutes under host load before
`/realms/drm/.well-known/openid-configuration` started responding, in the
same range as Phase 2B's ~220s observation. All 8 containers reported
`Up`/`healthy` afterward with no restarts.

## 2. Automated suites, run together

### Smoke test

```
./scripts/smoke-test.sh
```

```
OK: http://api.drm.localhost/health
OK: http://auth.drm.localhost/realms/drm/.well-known/openid-configuration
OK: http://app.drm.localhost/
OK: http://storage.drm.localhost/
OK: http://127.0.0.1:9000/minio/health/live
Smoke test passed.
```

### API unit suite

```
pnpm --filter api test
```

**5 suites passed, 22 tests passed** (`audit.service.spec.ts`,
`user-persistence.spec.ts`, `acl.service.spec.ts`, `jwt.strategy.spec.ts`,
`health.controller.spec.ts`). Each spec file spins up its own Testcontainers
Postgres and applies all 4 migrations (`init`,
`drop_email_unique_constraint`, `documents_folders_acl`, `audit_logs`)
cleanly. `audit.service.spec.ts`'s concurrency test (10 concurrent
`record()` calls) passed, confirming the advisory-lock serialization holds.

### API e2e suite

```
pnpm --filter api test:e2e
```

Run twice back-to-back, immediately after the 182s unit suite, to check for
the class of timing issue Phase 2B's verification hit:

```
Test Suites: 10 passed, 10 total
Tests:       26 passed, 26 total
Time:        89.21 s
```

```
Test Suites: 10 passed, 10 total
Tests:       26 passed, 26 total
Time:        50.35 s
```

Both runs green, all 10 suites (`whoami`, `folders`, `permissions`,
`storage`, `documents-read`, `documents-write`, `audit-folders`,
`audit-documents`, `audit-permissions`, `audit-endpoints`). Unlike Phase
2B's final verification, **no integration-only failure surfaced this time**
— no timeouts, no test-data collisions, no flakiness across either run.
`jest-e2e.json`'s `testTimeout` (raised to 30000ms in Phase 2B) was
apparently sufficient headroom for this phase's additional four audit e2e
spec files running alongside everything else. No application or test code
changes were needed as a result of this step.

### API lint

```
pnpm --filter api lint
```

Clean — no output, no errors.

### Web test suite

```
pnpm --filter web test
```

**1 file passed, 2 tests passed** (`Home.test.tsx`).

## 3. Manual walkthrough

Performed by hand with `curl` against the same freshly-rebuilt stack, after
the automated suites above, as `testadmin` (`id:
6ae638e9-b2f8-45c2-a7ff-4a24ececb95e`) with `testuser` (`id:
0583c9cc-ccc2-4fcb-b282-764a36b31bbb`) as the grant recipient. Full raw
request/response transcripts are in the task's scratch working directory;
narrative and audit-log excerpts below.

1. **Create a folder.** `POST /folders {"name":"phase3-walkthrough-<ts>"}`
   as testadmin → 201, `id: 0839dd2d-fc96-4954-938f-6b41ca82e64f`.
   `GET /folders/:id/audit-logs` → one entry, `folder_create` (sequence 69,
   `prevHash` linked to the prior tail of the chain left over from the
   automated e2e runs — the chain is global across all resources by
   design, not per-resource).

2. **View the folder.** `GET /folders/:id` → 200. `GET
   /folders/:id/audit-logs` → two entries now: `folder_create` (seq 69),
   `folder_view` (seq 70, `prevHash` = seq 69's `hash` exactly:
   `ee273bdce5fe3d5f1a8ff38a7e31ad31b03a0d11bdb75bf5867b061538d74897`).

3. **Upload a document into it.** `POST /documents` (multipart) with a
   locally-generated text file → 201, `id:
   c98e3353-dde9-477f-9b3e-40295fef5658`, `versionNumber: 1`, `sha256`
   matching the locally computed hash of the uploaded file
   (`c3816a78...`). `GET /documents/:id/audit-logs` → one entry,
   `document_create` (seq 71, `prevHash` = the folder's `folder_view`
   hash — confirming the chain is a single global sequence spanning
   folders and documents together, not siloed per resource type).

4. **View its metadata.** `GET /documents/:id` → 200 with the expected
   fields. `GET /documents/:id/audit-logs` → `document_view` appended
   (seq 72, correctly linked).

5. **Download it and confirm bytes match.** `GET /documents/:id/download`
   → the exact original bytes; `diff` showed no differences and
   `sha256sum` of source and downloaded files matched exactly
   (`c3816a78...` both). `GET /documents/:id/audit-logs` →
   `document_download` appended (seq 73, correctly linked).

6. **Upload a second version.** `POST /documents/:id/versions` with a
   different file → 201, `versionNumber: 2`. `GET /documents/:id` showed
   `currentVersionId` correctly repointed to the new version. `GET
   /documents/:id/audit-logs` → `document_version_upload` appended (seq
   74), plus a `document_view` (seq 75) from the follow-up `GET
   /documents/:id` call used to confirm the repoint — both correctly
   chained.

7. **Pre-grant lockout check.** As testuser: `GET /folders/:id` → 403
   before any grant existed.

8. **Grant `view` to testuser.** `POST /folders/:id/permissions
   {"principalType":"user","principalId":"<testuser id>","permissionLevel":"view"}`
   as testadmin → 201. `GET /folders/:id/audit-logs` → `permission_grant`
   appended (seq 76, correctly linked to the last document-chain entry —
   again confirming one global chain). Post-grant, testuser's `GET
   /folders/:id` → 200, which itself recorded a `folder_view` (seq 77)
   attributed to testuser's own `actorId` — the chain correctly captures
   which principal performed each action, not just the resource owner.

9. **Revoke the grant.** `DELETE /folders/:id/permissions/:permissionId`
   as testadmin → 204, empty body. `GET /folders/:id/audit-logs` →
   `permission_revoke` appended (seq 78, correctly linked). Post-revoke,
   testuser's `GET /folders/:id` → 403 again — access revoked
   immediately, no staleness.

10. **Verify the chain.** `GET /audit-logs/verify` as testadmin → `{
    "valid": true }`. As testuser (non-admin) → `403 {"message":"Only
    admins can verify the audit chain", ...}`.

Every step behaved exactly as expected: each audit entry appeared
immediately after its triggering operation, `prevHash` on each new entry
matched the previous entry's `hash` byte-for-byte, and the chain remained
valid end-to-end across resource types and actors throughout the whole
walkthrough.

## 4. Deliberate tamper test

Connected directly to the running Postgres container (`docker exec
drm-postgres-1 psql ...`, verified via `docker port drm-postgres-1` to be
the same database exposed on the host as
`postgresql://drm:drm_dev_password@localhost:5433/drm` — `5432/tcp ->
127.0.0.1:5433`; no local `psql` client was installed on the host, so the
containerized client was used to reach the identical database instead).

Identified the `document_create` row from step 3 of the walkthrough (`id:
2b2f2deb-2087-429b-b6db-1f95a231998d`, `sequence: 71`) and hand-edited its
`actorId`:

```sql
UPDATE audit_logs SET "actorId" = 'tampered-actor-id'
WHERE id = '2b2f2deb-2087-429b-b6db-1f95a231998d';
```

**Before tamper:** `GET /audit-logs/verify` → `{"valid":true}` (from step 10
above).

**After tamper:** `GET /audit-logs/verify` →
```json
{"valid":false,"brokenAtId":"2b2f2deb-2087-429b-b6db-1f95a231998d"}
```

`brokenAtId` matched the exact row edited. This is expected: `actorId` is
part of the hash input (`id|actorId|action|resourceType|resourceId|ipAddress|createdAt|prevHash`),
so mutating it in place makes the stored `hash` no longer reproduce from the
row's own fields, and `verifyChain`'s recomputation catches it at that row.

**Reverted the edit afterward:**

```sql
UPDATE audit_logs SET "actorId" = '6ae638e9-b2f8-45c2-a7ff-4a24ececb95e'
WHERE id = '2b2f2deb-2087-429b-b6db-1f95a231998d';
```

Confirmed the chain was restored: `GET /audit-logs/verify` →
`{"valid":true}` again. (The dev database is disposable either way per the
task brief, but reverting was chosen to leave the environment in a clean,
verifiably-valid state rather than a permanently tampered one.)

## Files changed

None. No integration-only failures surfaced in this run (Section 2), so no
application, test, or config code needed changes — this phase's rebuild and
full-suite run were clean on the first pass. Only this verification
document was added.

## Result

All automated suites pass together on a fresh stack (smoke test; 5/5 unit
suites, 22/22 unit tests including the concurrency test; 10/10 e2e suites,
26/26 e2e tests, stable across two consecutive runs; lint clean; 1/1 web
suite, 2/2 web tests). The manual walkthrough of the full folder → upload →
view → download → version → grant → revoke flow, done by hand as testadmin
and testuser against the live stack, produced correctly ordered,
correctly hash-linked audit entries at every step, and `GET
/audit-logs/verify` reported `{ valid: true }` throughout. The deliberate
tamper test against the live database — hand-editing one row's `actorId`
directly in Postgres — was correctly detected by `GET /audit-logs/verify`,
reporting `{ valid: false, brokenAtId: "<the exact edited row's id>" }`,
and the edit was reverted afterward, restoring `{ valid: true }`. Phase 3 is
verified: the audit trail and hash chain hold up under the full automated
suite and a real, adversarial manual check.
