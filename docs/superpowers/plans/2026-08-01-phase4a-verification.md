# Phase 4A Verification

Full-suite verification of Phase 4A (Background Job Infrastructure: Redis +
BullMQ, `apps/worker`, Gotenberg, ClamAV), run against a completely fresh
stack (`docker compose down -v && docker compose up -d --build`) so that no
state from individual task-level testing (Tasks 1-5) carried over, with
every automated suite run together rather than in isolation.

## 1. Extend `scripts/smoke-test.sh`

None of Phase 4A's new services (`redis`, `gotenberg`, `clamav`, `worker`)
publish an HTTP port to the host, so the script's existing `check()`
helper (a plain HTTP GET) doesn't apply to them. Before trusting the
plan's draft `check_container_state()` snippet, its field/value
assumptions were verified live against this host's real Docker Compose
(`v5.3.1`):

```
$ docker compose ps --format '{{.Service}} {{.State}} {{.Health}}'
api running
clamav running healthy
gotenberg running healthy
...
worker running
```

Confirmed: `{{.State}}` reports `running` for every service regardless of
healthcheck; `{{.Health}}` reports `healthy`/`unhealthy`/`starting` for
services with a healthcheck defined, and is empty for services without
one. This matched the plan's expectation, so the helper was added with one
adjustment — a `field` parameter so the same function checks `Health` for
the three services that have real healthchecks (`redis`, `gotenberg`,
`clamav`) and `State` for `worker`, which has none (a pure background
BullMQ consumer, per the plan's own note):

```bash
check_container_state "redis" "Health" "healthy"
check_container_state "gotenberg" "Health" "healthy"
check_container_state "clamav" "Health" "healthy"
check_container_state "worker" "State" "running"
```

Verified against the stack that was already up (pre-rebuild) before
moving on, to catch any helper bugs before they were entangled with the
much longer fresh-rebuild cycle.

## 2. Fresh full-stack rebuild

Host disk was at 79% (`df -h /`) before starting — under the ~85%
threshold, so no pruning was needed up front.

```
docker compose down -v && docker compose up -d --build
```

All 14 DRM containers (`traefik`, `postgres`, `redis`, `keycloak`, `api`,
`worker`, `gotenberg`, `clamav`, `web`, `openbao`, `openbao-init`, `kes`,
`minio`, `minio-init`) were destroyed, including named volumes, and
recreated. Confirmed via `docker ps -a | grep drm` (empty, exit 1) and
`docker volume ls | grep drm` (empty, exit 1) that nothing survived `down
-v`, and that every container's `CreatedAt` from `docker compose ps`
matched the moment of the `up -d --build` run (all created within
01:26:03-01:26:06 UTC).

**ClamAV first-boot definition download: 7 minutes 41 seconds.**
Measured directly from `docker inspect drm-clamav-1`'s health-check log:
container created `2026-08-02T01:26:03Z`, first successful healthcheck
(`Clamd is up`, exit 0) at `2026-08-02T01:33:44Z`. Faster than Task 5's
~13-minute observation on the same host — likely freshclam CDN/network
variance rather than anything this phase changed; both are well inside the
900s `start_period` budgeted in `docker-compose.yml`. Keycloak's cold
start (fresh volume, full schema migration + realm import) took about 3.5
minutes before `/realms/drm/.well-known/openid-configuration` started
responding (`01:31:51` Quarkus augmentation done → `01:34:52` realm
import), in the same range as prior phases' observations.

## 3. Automated suites, run together — and a real integration-only failure

Per the task brief, all suites were run together rather than only
individually, specifically to surface the kind of integration-only issue
prior phases have found this way. Two were found on this run, both real,
neither hypothetical:

### 3a. `apps/api` lint failure (a genuine Task 3 gap, first exposed here)

The very first pass through `pnpm --filter api lint`, run immediately
after the fresh rebuild's `smoke-test.sh` and `api test`/`test:e2e` passed,
failed:

```
apps/api/test/jobs.e2e-spec.ts
  22:11  error  Unsafe assignment of an `any` value
  25:26  error  Unsafe member access .workerHostname on an `any` value
  26:19  error  Unsafe member access .workerHostname on an `any` value
```

`job.waitUntilFinished()` (BullMQ) returns `any` — it has no way to know
the worker processor's return shape from the queue side. Task 3's e2e test
(`jobs.e2e-spec.ts`) used that `any` value directly, which
`@typescript-eslint/no-unsafe-*` correctly flags but which `test:e2e`
itself doesn't catch (Jest doesn't type-check assertions at runtime). This
had been sitting unnoticed since Task 3 because lint had apparently never
been run in the same pass as the e2e suite that introduced the file.

**Fix:** added an explicit `HealthCheckResult` interface mirroring
`apps/worker/src/health-check/health-check.processor.ts`'s real return
type (`{ pong: true; processedAt: string; workerHostname: string }`) and
cast the awaited result to it, rather than disabling the rule. Re-ran both
`test:e2e` (still 11/11 suites, 27/27 tests) and `lint` (clean) after the
change to confirm nothing regressed.

### 3b. ClamAV crashed under host memory pressure mid-run (infrastructure, not code)

Partway through a full combined run (smoke-test → api test → api
test:e2e → lint → web test → verify-gotenberg → verify-clamav, all in one
sequential pass), `verify-clamav.sh` failed:

```
Error: connect ECONNREFUSED 172.19.0.3:3310
```

and `smoke-test.sh`'s new `clamav` health check had already started
failing moments earlier in the same run (`FAIL: clamav Health is
'unhealthy'`). Investigation (`docker inspect`, `docker exec ... ps aux`,
`free -h`) found the root cause: this host has only 1.9GiB of RAM, and
swap was at 3.3/3.8GiB used (nearly exhausted) after the fresh rebuild's
docker builds plus the concurrent test/verification load. `clamd`'s
process inside the container had gone to state `Z` (zombie) — it had
actually crashed, not just slowed down. This is a host resource-contention
issue, not a bug introduced by this phase's code or config; ClamAV's own
`healthcheck` (`clamdcheck.sh`, from Task 5) correctly detected and
reported it as `unhealthy` rather than silently passing, which is exactly
what that healthcheck exists to do.

**Fix:** `docker compose restart clamav`. Recovered to `healthy` in about
5 seconds (`ERROR: Unable to contact server` at 02:18:51 →
`Clamd is up` at 02:18:56) — fast because virus definitions live on the
container's own writable layer, not the volume that `down -v` wipes, so a
plain `restart` (unlike a full recreate) didn't trigger another
multi-minute freshclam download. No application or infrastructure config
change was needed; this is a real operational characteristic of running
this stack on a memory-constrained host under concurrent load, worth
carrying forward: **future CI or dev-host sizing for this stack should
budget more than ~2GB RAM**, or expect ClamAV to be the first casualty
under memory pressure (it's the only service here holding a large
in-memory signature database).

### Final clean run, in order, after both fixes

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
`health.controller.spec.ts`).

```
pnpm --filter api test:e2e
```
**11 suites passed, 27 tests passed**, including Task 3's
`jobs.e2e-spec.ts` (the real job round-trip through Redis to the worker
container) — `whoami`, `folders`, `permissions`, `storage`,
`documents-read`, `documents-write`, `jobs`, `audit-folders`,
`audit-documents`, `audit-permissions`, `audit-endpoints`.

```
pnpm --filter api lint
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
Gotenberg verification passed. Output size: 14963 bytes.
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

All seven suites green together, in sequence, on the same freshly rebuilt
stack, with ClamAV's `healthy` status confirmed immediately before and
after the run.

## Files changed

- `scripts/smoke-test.sh` — added `check_container_state()`, a second
  helper (alongside the existing HTTP `check()`) that reads
  `docker compose ps --format`, and four new checks for `redis`,
  `gotenberg`, `clamav` (all via `Health`) and `worker` (via `State`,
  since it has no healthcheck).
- `apps/api/test/jobs.e2e-spec.ts` — added an explicit
  `HealthCheckResult` interface and cast `job.waitUntilFinished()`'s
  result to it, fixing the 3 `@typescript-eslint/no-unsafe-*` lint errors
  this integration-only run surfaced (Section 3a).
- `docs/superpowers/plans/2026-08-01-phase4a-verification.md` — this
  document.

## Result

All automated suites pass together on a fresh, fully-rebuilt stack: smoke
test (9/9 checks, including 4 new container-health checks for Phase 4A's
services); 5/5 API unit suites, 30/30 unit tests; 11/11 API e2e suites,
27/27 e2e tests (including the real Redis→worker job round-trip); API
lint clean; 1/1 web suite, 2/2 web tests; Gotenberg conversion verified
against a real document; ClamAV verified against both a real EICAR
detection and a clean-file pass. Two real, integration-only issues
surfaced by running everything together rather than in isolation, exactly
as this task's brief anticipated: a genuine lint gap in Task 3's e2e test
(fixed in code) and a host memory-pressure crash of ClamAV under
concurrent load (fixed operationally via `docker compose restart clamav`,
with the RAM-budget finding carried forward above for future host/CI
sizing). ClamAV's fresh first-boot definition download took 7m41s on this
run. Phase 4A's background-job infrastructure — Redis, BullMQ, the worker
container, Gotenberg, and ClamAV — is verified working together, from a
completely fresh `docker compose up`, alongside the full existing stack.
