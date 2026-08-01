# Phase 2B Verification

Full-suite verification of Phase 2B (Documents, Folders & ACL), run against a
completely fresh stack (`docker compose down -v && docker compose up -d --build`)
so that no state from individual task-level testing carried over.

## 1. `testadmin` fixture

`testadmin` was already present in `keycloak/realm-export.json` (added during
Task 5), so Step 1 was a confirmation, not a modification — no changes were
made to `keycloak/realm-export.json`.

Confirmed via a password-grant token request against the freshly-imported
realm:

```
POST http://auth.drm.localhost/realms/drm/protocol/openid-connect/token
  client_id=drm-web&grant_type=password&username=testadmin&password=testadminpass
```

Decoded access token claims: `preferred_username: testadmin`,
`email: testadmin@example.com`, `realm_access.roles: ["admin"]`. Login and
role assignment both work correctly.

## 2. Fresh full-stack rebuild

```
docker compose down -v && docker compose up -d --build
```

All 10 DRM containers (`traefik`, `postgres`, `keycloak`, `api`, `web`,
`openbao`, `openbao-init`, `kes`, `minio`, `minio-init`) were destroyed
(including named volumes) and recreated from scratch — confirmed no
containers survived the `down -v` (`docker ps -a | grep drm` returned
nothing before `up`) and that the images were rebuilt (`Image ... Built`
in the compose output, unpacking a new `drm-api` image, etc.).

Keycloak's cold start (fresh volume — full Liquibase schema migration plus
realm import, not just a warm restart) took approximately 220s under host
load, above the 90-170s estimate in the task brief. `docker logs
drm-keycloak-1` showed it progressing through Quarkus augmentation → schema
migration (134 changesets) → realm import the whole time, so this was
legitimate cold-start work, not a hang.

## 3. Automated suites, run together

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

**4 suites passed, 16 tests passed** (`acl.service.spec.ts`,
`user-persistence.spec.ts`, `health.controller.spec.ts`,
`jwt.strategy.spec.ts`). Each unit spec file runs its own Testcontainers
Postgres instance and applies all 3 migrations cleanly.

### API e2e suite

```
pnpm --filter api test:e2e
```

**First run: 1 failure.** `permissions.e2e-spec.ts`'s first test ("grants
view access to another user, who can then see the folder but not manage
it") exceeded the file's 15000ms Jest test timeout while awaiting a live
HTTP round trip (token request / folder create), even though every
assertion in the test was correct. Re-running that spec file in isolation
immediately after (same stack, no code changes) passed in 2.8s for that
test, confirming this was not a logic bug or test-data collision but a
timing issue: this host has a single CPU and was running the full unit
suite (124s), five other e2e spec files, and several unrelated Docker
projects' containers immediately beforehand, and 15s was too tight a
margin for a live Keycloak + Postgres + MinIO round trip under that load.

**Fix:** bumped `testTimeout` in `apps/api/test/jest-e2e.json` from
`15000` to `30000`. This is real infrastructure under test (live Keycloak
token issuance, real Postgres, real MinIO via StorageService) rather than
mocks, so a more generous timeout is appropriate for a shared, loaded host
rather than papering over a real defect — no application code changed.

**After the fix, re-run twice for stability:**

```
Test Suites: 6 passed, 6 total
Tests:       21 passed, 21 total
```
(both runs — 38s and 46s respectively; `permissions.e2e-spec.ts`,
`whoami.e2e-spec.ts`, `folders.e2e-spec.ts`, `storage.e2e-spec.ts`,
`documents-write.e2e-spec.ts`, `documents-read.e2e-spec.ts` all green both
times.)

This was the only integration issue surfaced by running everything
together rather than task-by-task — no test-data collisions between spec
files were observed (each creates uniquely-named/`Date.now()`-suffixed
folders and documents, so no collisions were expected or seen even under
load).

### Web test suite

```
pnpm --filter web test
```

**1 file passed, 2 tests passed** (`Home.test.tsx`).

## 4. Manual end-to-end walkthrough

Performed by hand with `curl` against the same freshly-rebuilt stack,
after the automated suites above.

1. **Log in as `testadmin`.** Password grant against `drm-web` succeeded;
   `GET /whoami` returned `{"email":"testadmin@example.com","roles":["admin"]}`.
2. **Create a root folder.** `POST /folders {"name":"walkthrough-root-<ts>"}`
   as testadmin returned 201 with `"parentId":null` — a true root folder.
3. **Upload a document into it.** `POST /documents` (multipart, `folderId`
   + `name` + `file`) with a locally-generated text file returned 201 with
   `versionNumber: 1` and a `sha256` that matched the locally computed
   hash of the uploaded file.
4. **Download it back and confirm bytes match.** `GET
   /documents/:id/download` as testadmin returned the exact original
   bytes — `diff` against the source file showed no differences, and
   `sha256sum` of the original and downloaded files matched exactly.
5. **Upload a second version.** `POST /documents/:id/versions` with a
   different file succeeded, `versionNumber: 2`; `GET
   /documents/:id/versions` listed both versions (v2 first), and `GET
   /documents/:id` showed `currentVersionId` correctly repointed to the
   new version.
6. **Pre-grant lockout check.** Logged in as `testuser`; `GET
   /folders/:id` and `GET /documents/:id` both returned 403 before any
   grant existed.
7. **Grant `view` to `testuser`.** `POST /folders/:id/permissions
   {"principalType":"user","principalId":"<testuser id>","permissionLevel":"view"}`
   as testadmin returned 201 with the new permission row.
8. **Confirm testuser's access under the `view` grant.** As testuser:
   `GET /folders/:id` → 200; `GET /documents/:id` → 200 (can see the
   folder and document metadata). `POST /documents/:id/versions` (edit) →
   403. `POST /folders/:id/permissions` (manage) → 403. `GET
   /documents/:id/download` → 403 with `"You do not have download access
   to this document"`. This last one is expected, not a bug: the ACL's
   `LEVEL_ORDER` (`view: 1 < download: 2 < edit: 3 < manage: 4`, defined
   once in `AclService`) means a `view` grant intentionally does not
   include download rights — download is a strictly higher level. The
   brief's walkthrough only requires confirming view-without-edit/manage,
   which held; the download check was an extra probe that confirmed the
   hierarchy is enforced as designed.
9. **Revoke the grant.** `DELETE
   /folders/:id/permissions/:permissionId` as testadmin returned 204 with
   an empty body.
10. **Confirm testuser is locked out again.** As testuser: `GET
    /folders/:id` → 403, `GET /documents/:id` → 403. Access was fully
    revoked immediately, no caching/staleness observed.

Every step behaved as expected; no discrepancies found between the manual
walkthrough and the automated suite's coverage of the same flows.

## Files changed

- `apps/api/test/jest-e2e.json` — `testTimeout` raised from 15000ms to
  30000ms, to give live-infrastructure e2e tests enough headroom on a
  loaded/shared host when the full suite runs together (see Section 3).
- `keycloak/realm-export.json` — unchanged; `testadmin` was already present
  from Task 5, confirmed working, no edit needed.

## Result

All automated suites pass together on a fresh stack (smoke test; 4/4 unit
suites, 16/16 unit tests; 6/6 e2e suites, 21/21 e2e tests, stable across
repeated runs; 1/1 web suite, 2/2 web tests). The manual walkthrough of the
full folder → upload → download → version → grant → revoke flow, done by
hand as testadmin and testuser, matched expected behavior at every step,
including the ACL permission-level hierarchy. Phase 2B is verified.
