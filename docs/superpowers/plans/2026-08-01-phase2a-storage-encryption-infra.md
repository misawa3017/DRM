# Phase 2A: Storage & Encryption Infrastructure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the encrypted object storage chain (`MinIO → KES → OpenBao`) so Phase 2B's document/version logic has a real, working, encrypted place to write files — verified end-to-end by actually uploading and downloading an encrypted object, not just by services reporting "healthy".

**Architecture:** OpenBao runs in real server mode (not dev-mode) with persistent file storage, properly initialized and unsealed, exposing a `kv-v2` secrets engine that MinIO KES uses as its keystore backend via AppRole authentication. KES authenticates MinIO itself via mutual TLS (a client certificate whose identity hash is allow-listed in KES's policy). MinIO is configured for SSE-KMS using KES as the external key service. All of this lives in the same `docker-compose.yml` Phase 1 already established, alongside Postgres/Keycloak/Traefik/api/web.

**Tech Stack:** OpenBao (Vault-API-compatible KMS/secrets backend), MinIO KES (key encryption service), MinIO (S3-compatible object storage), `mc` (MinIO client CLI) for verification, openssl for TLS identity generation.

## Global Constraints

- Continue extending the existing root `docker-compose.yml` and `.env`/`.env.example` — do not create a second compose file.
- **OpenBao runs in real server mode, not `-dev`.** Dev mode is in-memory and resets on every restart; for a system whose entire job is protecting encryption keys, losing the KMS's key material on every container recreation is not an acceptable simplification (Phase 1 already hit this exact class of bug with Keycloak's dev-mode identity drift — do not repeat it here with something that would be far more damaging: previously-encrypted documents becoming permanently unreadable).
- OpenBao: `storage "file"` backend (single-node, simplest correct persistent option for one internal VM), single unseal key share (`-key-shares=1 -key-threshold=1` — a deliberate simplification appropriate for an internal single-operator VM; note in code comments that a real multi-operator deployment would use a higher threshold), TLS disabled on OpenBao's own listener (internal Docker network only, matching Keycloak's `KC_HTTP_ENABLED` precedent from Phase 1).
- KES: authenticates MinIO via mTLS client certificate (identity = hash of the client's public key, computed via the `kes` CLI itself — do not hand-derive this hash). KES's own keystore backend is OpenBao's `kv-v2` engine, accessed via AppRole (role_id + secret_id), not a static root token.
- **No cryptographic secrets are ever committed to git**: OpenBao's unseal key(s) and root token, KES's TLS private key, the MinIO client's TLS private key, and the AppRole `secret_id` all live either in a gitignored local directory (`secrets/`) or in a Docker-managed volume shared only between the containers that need them. Only *templates* and *scripts that generate* these are committed. Add `secrets/` to `.gitignore` before generating anything into it.
- Image tags: `minio/minio:latest`, `minio/kes:latest`, `openbao/openbao:latest` — all three projects move fast enough that pinning a specific tag risks pinning to something already gone; `:latest` is the pragmatic choice here (unlike Postgres/Keycloak/Traefik in Phase 1, which pinned specific stable versions).
- **KES's YAML config schema is not fully certain from memory** — the plan below gives a concrete best-effort config, but before finalizing it, run `docker run --rm minio/kes:latest --help` and `docker run --rm minio/kes:latest server --help`, and use KES's own (typically explicit) config-validation error output to correct field names if the container fails to start. This is expected, normal work for this task, not a sign something is wrong with the plan.
- Docker daemon on this host is sometimes under load from unrelated processes, causing transient slowness; retry a timed-out command once before concluding something is actually broken (this was a recurring, confirmed-benign pattern throughout Phase 1).

---

### Task 1: OpenBao server — persistent, initialized, unsealed, with kv-v2 + AppRole

**Files:**
- Create: `openbao/config.hcl`
- Create: `openbao/init.sh`
- Modify: `docker-compose.yml` (add `openbao` and `openbao-init` services + `openbao_data` and `openbao_shared` volumes)
- Modify: `.gitignore` (add `secrets/`)

**Interfaces:**
- Consumes: nothing new.
- Produces: a running, unsealed OpenBao reachable at `http://openbao:8200` on the Docker network, with a `kv-v2` engine mounted at `kes/`, an AppRole role named `kes` bound to a policy permitting CRUD under `kes/data/*`, and that role's `role_id`/`secret_id` written to `/shared/kes-approle.json` inside the `openbao_shared` volume (format: `{"role_id": "...", "secret_id": "..."}`) for Task 3 to consume. Idempotent: safe to run `docker compose up -d` repeatedly without re-initializing or losing existing keys.

- [ ] **Step 1: Add `secrets/` to `.gitignore`**

```
secrets/
```

- [ ] **Step 2: Create `openbao/config.hcl`**

```hcl
ui = true
disable_mlock = true

storage "file" {
  path = "/openbao/data"
}

listener "tcp" {
  address     = "0.0.0.0:8200"
  tls_disable = true
}

api_addr = "http://openbao:8200"
```

- [ ] **Step 3: Create `openbao/init.sh`**

This script is idempotent and does three things in order: (1) initialize + unseal if not already done, persisting the unseal key and root token to the shared volume; (2) unseal using the saved key if OpenBao is initialized but currently sealed (e.g., after a container restart); (3) set up the `kv-v2` engine, AppRole auth, policy, and role if not already present, writing `role_id`/`secret_id` to the shared volume.

```bash
#!/bin/sh
set -eu

SHARED_DIR=/shared
INIT_FILE="$SHARED_DIR/openbao-init.json"
APPROLE_FILE="$SHARED_DIR/kes-approle.json"

export BAO_ADDR=http://openbao:8200

wait_for_openbao() {
  echo "Waiting for OpenBao to respond..."
  for i in $(seq 1 30); do
    if bao status >/dev/null 2>&1 || [ $? -eq 2 ]; then
      # exit code 2 means "sealed but reachable" for `bao status` — that's fine, it's up
      return 0
    fi
    sleep 2
  done
  echo "OpenBao did not become reachable in time" >&2
  exit 1
}

wait_for_openbao

INITIALIZED=$(bao status -format=json | grep -o '"initialized":[a-z]*' | cut -d: -f2)

if [ "$INITIALIZED" != "true" ]; then
  echo "Initializing OpenBao (1 key share, threshold 1 — single-operator internal VM)..."
  bao operator init -key-shares=1 -key-threshold=1 -format=json > "$INIT_FILE"
  chmod 600 "$INIT_FILE"
fi

UNSEAL_KEY=$(grep -o '"unseal_keys_b64":\["[^"]*"' "$INIT_FILE" | sed 's/.*\["//')
ROOT_TOKEN=$(grep -o '"root_token":"[^"]*"' "$INIT_FILE" | cut -d'"' -f4)

SEALED=$(bao status -format=json | grep -o '"sealed":[a-z]*' | cut -d: -f2)
if [ "$SEALED" = "true" ]; then
  echo "Unsealing OpenBao..."
  bao operator unseal "$UNSEAL_KEY"
fi

export BAO_TOKEN="$ROOT_TOKEN"

if ! bao secrets list -format=json | grep -q '"kes/"'; then
  echo "Enabling kv-v2 secrets engine at kes/..."
  bao secrets enable -path=kes -version=2 kv
fi

if ! bao auth list -format=json | grep -q '"approle/"'; then
  echo "Enabling AppRole auth..."
  bao auth enable approle
fi

cat <<'EOF' | bao policy write kes-policy -
path "kes/data/*" {
  capabilities = ["create", "read", "update", "delete"]
}
path "kes/metadata/*" {
  capabilities = ["list", "read", "delete"]
}
EOF

if ! bao read -format=json auth/approle/role/kes >/dev/null 2>&1; then
  echo "Creating AppRole role 'kes'..."
  bao write auth/approle/role/kes policies=kes-policy token_ttl=1h token_max_ttl=4h
fi

ROLE_ID=$(bao read -format=json auth/approle/role/kes/role-id | grep -o '"role_id":"[^"]*"' | cut -d'"' -f4)
SECRET_ID=$(bao write -f -format=json auth/approle/role/kes/secret-id | grep -o '"secret_id":"[^"]*"' | cut -d'"' -f4)

printf '{"role_id":"%s","secret_id":"%s"}\n' "$ROLE_ID" "$SECRET_ID" > "$APPROLE_FILE"
chmod 600 "$APPROLE_FILE"

echo "OpenBao init complete. AppRole credentials written to $APPROLE_FILE"
```

- [ ] **Step 4: Wire `openbao` and `openbao-init` into `docker-compose.yml`**

Add these services (alongside the existing `postgres`/`keycloak`/`traefik`/`api`/`web`) and the two new volumes:

```yaml
  openbao:
    image: openbao/openbao:latest
    command: server -config=/openbao/config.hcl
    cap_add:
      - IPC_LOCK
    volumes:
      - ./openbao/config.hcl:/openbao/config.hcl:ro
      - openbao_data:/openbao/data
    healthcheck:
      test: ["CMD", "wget", "-q", "-O", "-", "http://127.0.0.1:8200/v1/sys/health?standbyok=true&sealedcode=200"]
      interval: 5s
      timeout: 5s
      retries: 20

  openbao-init:
    image: openbao/openbao:latest
    entrypoint: ["/bin/sh", "/init.sh"]
    volumes:
      - ./openbao/init.sh:/init.sh:ro
      - openbao_shared:/shared
    depends_on:
      openbao:
        condition: service_healthy
    restart: "no"
```

Add to the top-level `volumes:` block:

```yaml
  openbao_data:
  openbao_shared:
```

- [ ] **Step 5: Bring the two services up and verify**

Run: `docker compose up -d openbao openbao-init`
Wait for `openbao-init` to exit successfully: `docker compose ps openbao-init` should show `Exited (0)`. If it doesn't, run `docker compose logs openbao-init` and fix the script (the `bao status`/`bao operator init` JSON parsing above uses `grep`/`cut` rather than `jq` since the base image may not have `jq` installed — if `jq` IS available in the image, feel free to swap to it for more robust parsing, but verify either way against real output).

- [ ] **Step 6: Verify idempotency**

Run: `docker compose up -d openbao-init` again (simulating a stack restart).
Expected: script logs show it skips re-initialization ("already initialized" path) and still exits 0, and `/shared/kes-approle.json` still contains valid credentials (verify: `docker compose run --rm --entrypoint cat openbao-init /shared/kes-approle.json` prints a JSON object with non-empty `role_id` and `secret_id`).

- [ ] **Step 7: Commit**

```bash
git add openbao .gitignore docker-compose.yml
git commit -m "feat(infra): stand up persistent OpenBao with kv-v2 + AppRole for KES"
```

---

### Task 2: TLS identities for KES server and MinIO client

**Files:**
- Create: `scripts/generate-kes-certs.sh`

**Interfaces:**
- Consumes: nothing new.
- Produces: `secrets/kes/kes-server.key` / `.cert`, `secrets/kes/minio-client.key` / `.cert` (all gitignored, generated locally), and `secrets/kes/minio-client-identity.txt` containing the KES identity hash of the MinIO client certificate, for Task 3's policy config to consume.

- [ ] **Step 1: Create `scripts/generate-kes-certs.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail

OUT_DIR="secrets/kes"
mkdir -p "$OUT_DIR"

if [ -f "$OUT_DIR/kes-server.cert" ] && [ -f "$OUT_DIR/minio-client.cert" ]; then
  echo "Certs already exist in $OUT_DIR — skipping generation (delete the directory to regenerate)."
else
  echo "Generating self-signed KES server certificate..."
  openssl req -x509 -newkey rsa:4096 -sha256 -days 3650 -nodes \
    -keyout "$OUT_DIR/kes-server.key" -out "$OUT_DIR/kes-server.cert" \
    -subj "/CN=kes" \
    -addext "subjectAltName=DNS:kes,DNS:localhost"

  echo "Generating self-signed MinIO client certificate..."
  openssl req -x509 -newkey rsa:4096 -sha256 -days 3650 -nodes \
    -keyout "$OUT_DIR/minio-client.key" -out "$OUT_DIR/minio-client.cert" \
    -subj "/CN=minio-client"
fi

echo "Computing KES identity hash of the MinIO client certificate..."
docker run --rm -v "$(pwd)/$OUT_DIR":/certs minio/kes:latest identity of /certs/minio-client.cert \
  | tee "$OUT_DIR/minio-client-identity.txt"

echo "Done. Identity hash saved to $OUT_DIR/minio-client-identity.txt"
```

(The exact output format of `kes identity of` — plain hash on stdout vs. a labeled line — should be checked against the real command output; adjust the `tee`/parsing in Task 3 if it prints more than a bare hash.)

- [ ] **Step 2: Run it and verify**

Run: `chmod +x scripts/generate-kes-certs.sh && ./scripts/generate-kes-certs.sh`
Expected: `secrets/kes/` now contains `kes-server.key`, `kes-server.cert`, `minio-client.key`, `minio-client.cert`, `minio-client-identity.txt`. Verify none of these are tracked by git: `git status --short` must show nothing under `secrets/`.

- [ ] **Step 3: Verify re-running is a safe no-op**

Run: `./scripts/generate-kes-certs.sh` again.
Expected: prints "Certs already exist... skipping generation" and still re-computes/prints the identity hash (cheap, idempotent, useful if you only deleted the identity file).

- [ ] **Step 4: Commit**

```bash
git add scripts/generate-kes-certs.sh
git commit -m "feat(infra): add script to generate KES/MinIO TLS identities"
```

(Nothing under `secrets/` is committed — only the script that generates it.)

---

### Task 3: KES server wired to OpenBao (AppRole) and MinIO (mTLS)

**Files:**
- Create: `kes/server-config.yaml.template`
- Create: `kes/entrypoint.sh`
- Modify: `docker-compose.yml` (add `kes` service)

**Interfaces:**
- Consumes: `secrets/kes/kes-server.{key,cert}` and `secrets/kes/minio-client-identity.txt` (Task 2); `openbao_shared` volume's `/shared/kes-approle.json` (Task 1).
- Produces: KES reachable at `https://kes:7373` on the Docker network, backed by OpenBao's `kes/` kv-v2 path, accepting requests only from the identity matching the MinIO client certificate.

- [ ] **Step 1: Inspect the real KES config schema before writing the template**

Run: `docker run --rm minio/kes:latest --help` and `docker run --rm minio/kes:latest server --help`. If the image ships an example config (check `docker run --rm --entrypoint sh minio/kes:latest -c "find / -iname '*.yaml' -o -iname '*.yml' 2>/dev/null | grep -v proc"`), inspect it. Use this to confirm or correct the field names in Step 2 below before proceeding — this plan's YAML is a best-effort starting point, not guaranteed to be byte-exact for whatever KES version `:latest` currently resolves to.

- [ ] **Step 2: Create `kes/server-config.yaml.template`**

```yaml
address: 0.0.0.0:7373

tls:
  key: /certs/kes-server.key
  cert: /certs/kes-server.cert

admin:
  identity: disabled

policy:
  minio:
    allow:
      - /v1/key/create/*
      - /v1/key/generate/*
      - /v1/key/decrypt/*
      - /v1/key/bulk/decrypt/*
      - /v1/key/list/*
    identities:
      - __MINIO_IDENTITY__

keystore:
  vault:
    endpoint: http://openbao:8200
    engine: kv-v2
    prefix: kes
    approle:
      id: __VAULT_ROLE_ID__
      secret: __VAULT_SECRET_ID__
      retry: 15s
```

- [ ] **Step 3: Create `kes/entrypoint.sh`**

Renders the template by substituting the MinIO identity hash (from Task 2's output file, bind-mounted read-only) and the AppRole credentials (from the `openbao_shared` volume, written by Task 1's init script) into a scratch config file, then execs the real KES server.

```bash
#!/bin/sh
set -eu

IDENTITY=$(cat /certs/minio-client-identity.txt | tr -d '[:space:]')
ROLE_ID=$(grep -o '"role_id":"[^"]*"' /shared/kes-approle.json | cut -d'"' -f4)
SECRET_ID=$(grep -o '"secret_id":"[^"]*"' /shared/kes-approle.json | cut -d'"' -f4)

sed -e "s/__MINIO_IDENTITY__/$IDENTITY/" \
    -e "s/__VAULT_ROLE_ID__/$ROLE_ID/" \
    -e "s/__VAULT_SECRET_ID__/$SECRET_ID/" \
    /template/server-config.yaml.template > /tmp/server-config.yaml

exec kes server --config /tmp/server-config.yaml
```

- [ ] **Step 4: Wire `kes` into `docker-compose.yml`**

```yaml
  kes:
    image: minio/kes:latest
    entrypoint: ["/bin/sh", "/entrypoint.sh"]
    volumes:
      - ./kes/entrypoint.sh:/entrypoint.sh:ro
      - ./kes/server-config.yaml.template:/template/server-config.yaml.template:ro
      - ./secrets/kes:/certs:ro
      - openbao_shared:/shared:ro
    depends_on:
      openbao-init:
        condition: service_completed_successfully
    ports:
      - "127.0.0.1:7373:7373"
```

(Loopback-only port publish for local debugging/`mc`/curl access, following the same loopback-binding discipline established for Postgres/Traefik's dashboard after Phase 1's final review.)

- [ ] **Step 5: Bring KES up and verify it's actually running against real OpenBao-backed state**

Run: `docker compose up -d --build kes` (or plain `up -d kes` if no build step applies), then `docker compose logs kes`.
Expected: no TLS or Vault-authentication errors in the log; if there are, they will name the exact problem (bad cert path, AppRole auth failure, wrong Vault engine path) — fix the template/entrypoint/OpenBao policy accordingly and retry. This is expected iterative work, not a sign of a broken plan.

Verify KES's own status endpoint: `curl -sk https://127.0.0.1:7373/v1/status --cacert secrets/kes/kes-server.cert` (or the correct status path per whatever `kes --help` showed in Step 1) returns a successful response.

- [ ] **Step 6: Commit**

```bash
git add kes docker-compose.yml
git commit -m "feat(infra): wire KES to OpenBao (AppRole) and MinIO (mTLS identity)"
```

---

### Task 4: MinIO configured for SSE-KMS via KES

**Files:**
- Modify: `docker-compose.yml` (add `minio` service)
- Modify: `.env.example` (add MinIO root credentials)

**Interfaces:**
- Consumes: KES at `https://kes:7373` (Task 3), `secrets/kes/minio-client.{key,cert}` (Task 2).
- Produces: MinIO reachable at `http://minio:9000` (S3 API) and `http://minio:9001` (console) on the Docker network, with KMS configured and online.

- [ ] **Step 1: Add MinIO root credentials to `.env.example`**

```
MINIO_ROOT_USER=drm-admin
MINIO_ROOT_PASSWORD=drm_dev_minio_password
```

Run: `cp .env.example .env` is already how this repo's `.env` gets updated (Phase 1 precedent) — since `.env` is gitignored and already exists locally, manually append the two new lines to the existing local `.env` file to match (don't blow away existing values by re-copying the whole example over it).

- [ ] **Step 2: Wire `minio` into `docker-compose.yml`**

```yaml
  minio:
    image: minio/minio:latest
    command: server /data --console-address ":9001"
    environment:
      MINIO_ROOT_USER: ${MINIO_ROOT_USER}
      MINIO_ROOT_PASSWORD: ${MINIO_ROOT_PASSWORD}
      MINIO_KMS_KES_ENDPOINT: https://kes:7373
      MINIO_KMS_KES_CERT_FILE: /certs/minio-client.cert
      MINIO_KMS_KES_KEY_FILE: /certs/minio-client.key
      MINIO_KMS_KES_CA_PATH: /certs/kes-server.cert
      MINIO_KMS_KES_KEY_NAME: drm-default-key
    volumes:
      - minio_data:/data
      - ./secrets/kes:/certs:ro
    depends_on:
      - kes
    labels:
      - traefik.enable=true
      - traefik.http.routers.minio-console.rule=Host(`storage.drm.localhost`)
      - traefik.http.services.minio-console.loadbalancer.server.port=9001
    healthcheck:
      test: ["CMD", "curl", "-f", "http://127.0.0.1:9000/minio/health/live"]
      interval: 5s
      timeout: 5s
      retries: 20
```

Add `minio_data:` to the top-level `volumes:` block.

- [ ] **Step 3: Bring MinIO up and verify KMS is actually online (not just configured)**

Run: `docker compose up -d minio`, wait for healthy, then `docker compose logs minio`.
Expected: startup log includes a line confirming KMS/encryption is enabled (MinIO's startup banner typically prints an "Encryption" or "KMS" status line — check for it; if instead there's a connection error to KES, fix the cert paths/CA/endpoint and retry).

Cross-check directly: `docker compose exec minio mc admin kms status local` (or `docker run --rm --network drm_default minio/mc ...` if `mc` isn't bundled in the server image — check which is the case) should report the KMS as reachable and show the default key name.

- [ ] **Step 4: Commit**

```bash
git add docker-compose.yml .env.example
git commit -m "feat(infra): add MinIO configured for SSE-KMS via KES"
```

---

### Task 5: End-to-end encrypted upload/download verification

**Files:**
- Create: `scripts/verify-encrypted-storage.sh`
- Modify: `scripts/smoke-test.sh` (add MinIO/KES/OpenBao checks)

**Interfaces:**
- Consumes: the full storage chain from Tasks 1-4.
- Produces: a `documents` bucket in MinIO with default SSE-KMS encryption enabled, and a script proving a real object round-trips through real encryption — this is what Phase 2B's application code will write into.

- [ ] **Step 1: Create `scripts/verify-encrypted-storage.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail

MC="docker run --rm --network drm_default -v $(pwd)/secrets:/secrets minio/mc"
ALIAS_SETUP="mc alias set local http://minio:9000 ${MINIO_ROOT_USER:-drm-admin} ${MINIO_ROOT_PASSWORD:?set MINIO_ROOT_PASSWORD or export it from .env first}"

echo "Configuring mc alias..."
$MC sh -c "$ALIAS_SETUP"

echo "Creating 'documents' bucket if it doesn't exist..."
$MC mc mb --ignore-existing local/documents

echo "Setting default SSE-KMS encryption on the bucket..."
$MC mc encrypt set sse-kms drm-default-key local/documents

echo "Uploading a test object..."
echo "phase 2a verification $(date -u +%FT%TZ)" > /tmp/verify-test.txt
$MC mc cp /tmp/verify-test.txt local/documents/verify-test.txt

echo "Confirming the object reports server-side encryption..."
$MC mc stat local/documents/verify-test.txt | grep -i "Encrypted" || {
  echo "FAIL: object does not report encryption metadata" >&2
  exit 1
}

echo "Downloading and verifying content round-trips correctly..."
$MC mc cat local/documents/verify-test.txt > /tmp/verify-test-downloaded.txt
diff /tmp/verify-test.txt /tmp/verify-test-downloaded.txt

echo "Cleaning up test object..."
$MC mc rm local/documents/verify-test.txt

echo "Encrypted storage verification passed."
```

(Adjust the exact `mc` invocation — command name inside the `minio/mc` image is typically just `mc`, not `mc mc` — this plan's draft has a likely duplication; fix based on what `docker run --rm minio/mc --help` actually shows before finalizing. Also adjust the network name if `docker compose` generated a different project network name than `drm_default` — check with `docker network ls`.)

- [ ] **Step 2: Run it**

Run: `chmod +x scripts/verify-encrypted-storage.sh && source .env && ./scripts/verify-encrypted-storage.sh`
Expected: "Encrypted storage verification passed." with no errors.

- [ ] **Step 3: Confirm real key material exists in OpenBao (not just that MinIO/KES claim success)**

Run: `docker compose exec openbao sh -c "BAO_TOKEN=\$(grep -o '\"root_token\":\"[^\"]*\"' /shared/openbao-init.json | cut -d'\"' -f4) bao kv list kes/"` (adjust path to wherever the shared init file actually lives from OpenBao's own container perspective — Task 1's `openbao-init` service wrote it into the `openbao_shared` volume, which is NOT mounted into the `openbao` service itself in this plan; either temporarily mount `openbao_shared` read-only into `openbao` for this check, or run the equivalent `bao kv list` command from a one-off container that has both the volume and network access. Use your judgment on the cleanest way to prove this without permanently widening the `openbao` service's mounts.)
Expected: at least one entry is listed, proving KES actually created and stored key material in OpenBao — the full chain is real, not just three services independently reporting "OK".

- [ ] **Step 4: Extend `scripts/smoke-test.sh`**

Add these checks alongside the existing three:

```bash
check "http://storage.drm.localhost/"
```

(MinIO console should respond even before login; a 200 or a redirect-to-login is fine — adjust the `check` function's expected status code handling if MinIO's console returns something other than a bare 200, e.g. a 200 with an HTML login page is what's expected here.)

Also add a direct MinIO health check that doesn't depend on Traefik:

```bash
check "http://127.0.0.1:9000/minio/health/live"
```

(Requires exposing MinIO's API port to loopback in `docker-compose.yml` similar to Postgres/Traefik-dashboard's existing loopback-only publishing — add `"127.0.0.1:9000:9000"` to the `minio` service's `ports:` if not already reachable from the host; check whether Task 4 already did this or if it's still needed here.)

- [ ] **Step 5: Run the full smoke test**

Run: `./scripts/smoke-test.sh`
Expected: all checks pass, including the two new ones.

- [ ] **Step 6: Commit**

```bash
git add scripts/verify-encrypted-storage.sh scripts/smoke-test.sh docker-compose.yml
git commit -m "test(infra): verify encrypted upload/download round-trip through MinIO+KES+OpenBao"
```

---

## Self-Review Notes

- **Spec coverage:** This plan covers exactly the "加密上傳/下載" (encrypted upload/download) infrastructure prerequisite named in the original Phase 2 scope, split out as agreed with the user. Document/folder/version/ACL business logic is explicitly out of scope here — that's Phase 2B, which will consume the `documents` bucket this plan creates.
- **Placeholder scan:** No TBD/TODO markers. Genuine areas of tool-specific uncertainty (KES's exact YAML schema, `mc`'s exact CLI invocation shape, the Docker Compose project's generated network name) are explicitly flagged as "verify against the real running tool" rather than silently guessed — this is a deliberate, disclosed choice given real uncertainty about fast-moving third-party tool syntax, not a placeholder in the sense the plan-writing process warns against (no vague "add appropriate config" — every step has concrete draft content to start from and iterate against real tool output).
- **Type consistency:** The `documents` bucket name, the `drm-default-key` KMS key name, and the `openbao_shared` volume's file paths (`/shared/kes-approle.json`, `/shared/openbao-init.json`) are each defined once and referenced identically everywhere they're used across tasks.
- **Scope:** Single cohesive deliverable — a working encrypted storage chain — with no document/ACL logic folded in.
