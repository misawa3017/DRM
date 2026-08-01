#!/bin/sh
set -eu

# Two separate volumes (see docker-compose.yml + openbao/entrypoint.sh):
# /init holds the OpenBao unseal key/root token and is mounted ONLY into
# this container; /approle holds just the scoped AppRole role_id/secret_id
# and is also mounted read-only into kes. Never write the root
# token/unseal key anywhere under /approle.
INIT_DIR=/init
APPROLE_DIR=/approle
INIT_FILE="$INIT_DIR/openbao-init.json"
APPROLE_FILE="$APPROLE_DIR/kes-approle.json"
# Records the secret_id_accessor minted on the previous run, so this run can
# check whether it's still valid (reuse it) or, if not, destroy it before
# minting a replacement (see below). Lives in the init-only volume, not the
# approle volume KES can read -- it's operator bookkeeping, not something
# KES needs.
ACCESSOR_STATE_FILE="$INIT_DIR/kes-secret-id-accessor"

export BAO_ADDR=http://openbao:8200

# jq is baked into the openbao-init image at build time (see
# openbao/init.Dockerfile) -- the openbao/openbao base image doesn't ship
# it, and `bao ... -format=json` output is pretty-printed (newlines + a
# space after every colon), which breaks naive single-line
# `grep -o '"key":value'` parsing. jq is far more robust for this than
# hand-rolled regexes. Installing it at build time (rather than at runtime,
# as before) means the routine "container restarted, just re-unseal from
# already-persisted state" recovery path below no longer depends on live
# reachability of Alpine's package mirror.

wait_for_openbao() {
  echo "Waiting for OpenBao to respond..."
  for i in $(seq 1 30); do
    # `bao status` exits 0 (unsealed) or 2 (sealed-but-reachable) when the
    # server is up; both mean "up" for our purposes. Guard the call so a
    # non-zero exit here doesn't trip `set -e`.
    status=0
    bao status >/dev/null 2>&1 || status=$?
    if [ "$status" -eq 0 ] || [ "$status" -eq 2 ]; then
      return 0
    fi
    sleep 2
  done
  echo "OpenBao did not become reachable in time" >&2
  exit 1
}

wait_for_openbao

INITIALIZED=$(bao status -format=json | jq -r '.initialized')

if [ "$INITIALIZED" != "true" ]; then
  echo "Initializing OpenBao (1 key share, threshold 1 -- single-operator internal VM)..."
  bao operator init -key-shares=1 -key-threshold=1 -format=json > "$INIT_FILE"
  chmod 600 "$INIT_FILE"
else
  echo "OpenBao already initialized."
fi

if [ ! -f "$INIT_FILE" ]; then
  echo "OpenBao is initialized but $INIT_FILE is missing (shared volume lost its state" \
       "while openbao_data persisted). Cannot recover unseal key/root token automatically." >&2
  exit 1
fi

UNSEAL_KEY=$(jq -r '.unseal_keys_b64[0]' "$INIT_FILE")
ROOT_TOKEN=$(jq -r '.root_token' "$INIT_FILE")

if [ -z "$UNSEAL_KEY" ] || [ "$UNSEAL_KEY" = "null" ] || [ -z "$ROOT_TOKEN" ] || [ "$ROOT_TOKEN" = "null" ]; then
  echo "Failed to parse unseal key / root token from $INIT_FILE" >&2
  exit 1
fi

SEALED=$(bao status -format=json | jq -r '.sealed')
if [ "$SEALED" = "true" ]; then
  echo "Unsealing OpenBao..."
  bao operator unseal "$UNSEAL_KEY" >/dev/null
else
  echo "OpenBao already unsealed."
fi

export BAO_TOKEN="$ROOT_TOKEN"

if ! bao secrets list -format=json | jq -e 'has("kes/")' >/dev/null; then
  echo "Enabling kv-v2 secrets engine at kes/..."
  bao secrets enable -path=kes -version=2 kv
else
  echo "kv-v2 engine already enabled at kes/."
fi

if ! bao auth list -format=json | jq -e 'has("approle/")' >/dev/null; then
  echo "Enabling AppRole auth..."
  bao auth enable approle
else
  echo "AppRole auth already enabled."
fi

cat <<'EOF' | bao policy write kes-policy -
path "kes/data/*" {
  capabilities = ["create", "read", "update", "delete"]
}
path "kes/metadata/*" {
  capabilities = ["list", "read", "delete"]
}
EOF

# Written unconditionally (not just on first creation) so config changes
# here -- e.g. the secret_id_ttl bound added below -- take effect on
# existing roles too, not just brand-new ones. This is the same idempotent
# "just re-apply every run" pattern already used above for kes-policy.
# secret_id_ttl bounds how long a minted secret_id stays valid at all (a
# safety net now that we actually revoke+rotate it every run below);
# secret_id_num_uses is deliberately left at its default of 0 (unlimited)
# -- KES re-authenticates via AppRole periodically as its token_max_ttl
# (4h) expires, reusing the SAME secret_id each time, so a single-use
# secret_id would break KES's login a few hours after every restart with a
# confusing symptom (intermittent decrypt failures, not a clean startup
# error).
echo "Configuring AppRole role 'kes'..."
bao write auth/approle/role/kes \
  policies=kes-policy \
  token_ttl=1h \
  token_max_ttl=4h \
  secret_id_ttl=90d

ROLE_ID=$(bao read -format=json auth/approle/role/kes/role-id | jq -r '.data.role_id')

if [ -f "$ACCESSOR_STATE_FILE" ]; then
  OLD_ACCESSOR=$(cat "$ACCESSOR_STATE_FILE")
else
  OLD_ACCESSOR=""
fi

# Minting is "sticky": only mint (and only destroy the previous accessor)
# when the currently-recorded secret_id is actually gone/invalid. A plain
# `docker compose up -d` on an already-running, healthy stack re-runs this
# script every time (openbao-init has no other trigger), but the live `kes`
# container is NOT recreated just because its dependency re-ran -- it keeps
# holding the secret_id it read from $APPROLE_FILE at its own container
# start, in memory, for its entire lifetime, and reuses it to re-login
# whenever its Vault/OpenBao token hits token_max_ttl (4h; see the AppRole
# role config above). If every run unconditionally destroyed the previous
# accessor and minted a new one, a routine `docker compose up -d` would
# silently invalidate the credential `kes` is currently using -- `kes`
# keeps working fine until its current token expires (up to 4h later), then
# fails to re-authenticate with no clean startup error. So: reuse the
# existing secret_id whenever it's still valid, and only destroy+replace it
# when it's actually gone -- this still guarantees at most one live, valid
# accessor per run (the original problem this whole revoke-before-mint
# scheme was added for: `bao list auth/approle/role/kes/secret-id` once
# showed 16 accumulated, never-revoked accessors from repeated restarts).
REUSE_EXISTING=false

if [ -f "$APPROLE_FILE" ] && [ -n "$OLD_ACCESSOR" ]; then
  EXISTING_ROLE_ID=$(jq -r '.role_id // empty' "$APPROLE_FILE" 2>/dev/null || echo "")
  EXISTING_SECRET_ID=$(jq -r '.secret_id // empty' "$APPROLE_FILE" 2>/dev/null || echo "")

  if [ -n "$EXISTING_ROLE_ID" ] && [ -n "$EXISTING_SECRET_ID" ]; then
    echo "Checking whether the previously-minted secret_id (accessor $OLD_ACCESSOR) is still valid..."
    # Confirmed live against this stack's OpenBao: `bao write
    # auth/approle/role/<role>/secret-id-accessor/lookup
    # secret_id_accessor=<accessor>` (a POST/write endpoint -- the accessor
    # is a body param, not a path segment or GET query param) exits 0 with
    # the secret_id's metadata (creation/expiration time etc.) when the
    # accessor is still live, and exits non-zero with a 404 "failed to find
    # accessor entry" error when it's expired/revoked/unknown. There's no
    # separate "is it valid" boolean field to check -- success/failure of
    # the call itself IS the validity signal.
    if bao write -format=json auth/approle/role/kes/secret-id-accessor/lookup \
        secret_id_accessor="$OLD_ACCESSOR" >/dev/null 2>&1; then
      echo "Existing secret_id is still valid; reusing it unchanged (not minting a new one)."
      REUSE_EXISTING=true
    else
      echo "Existing secret_id accessor is no longer valid (expired, revoked, or not found); minting a fresh one."
    fi
  else
    echo "$APPROLE_FILE exists but is missing role_id/secret_id; minting a fresh secret_id."
  fi
else
  echo "No existing AppRole credential state found; minting a fresh secret_id."
fi

if [ "$REUSE_EXISTING" = "true" ]; then
  echo "OpenBao init complete. Reused existing AppRole credentials at $APPROLE_FILE (unchanged)."
  exit 0
fi

if [ -n "$OLD_ACCESSOR" ]; then
  echo "Revoking previous AppRole secret_id (accessor $OLD_ACCESSOR)..."
  # Confirmed live: `bao write auth/approle/role/<role>/secret-id-accessor/destroy
  # secret_id_accessor=<accessor>` is the real API (param name is
  # secret_id_accessor, NOT `accessor`). No `-f` here -- unlike the
  # data-less mint call below, this call DOES pass data
  # (secret_id_accessor=...), so `-f` (which exists only to force a write
  # with no data) is unnecessary noise. Destroying an accessor that's
  # already gone returns a 500 "failed to find accessor entry" error, so
  # this is best-effort/non-fatal -- a stale/already-destroyed accessor
  # here shouldn't block bringing the stack up. Capture the output (rather
  # than discarding it) so a genuine failure (permission denied, connection
  # refused) is visible in the warning instead of looking identical to the
  # benign "already gone" case.
  DESTROY_OUTPUT=$(bao write auth/approle/role/kes/secret-id-accessor/destroy secret_id_accessor="$OLD_ACCESSOR" 2>&1) || \
    echo "Warning: could not revoke previous secret_id accessor $OLD_ACCESSOR (it may already be gone): $DESTROY_OUTPUT" >&2
fi

echo "Minting new AppRole secret_id..."
SECRET_ID_JSON=$(bao write -f -format=json auth/approle/role/kes/secret-id)
SECRET_ID=$(echo "$SECRET_ID_JSON" | jq -r '.data.secret_id')
SECRET_ID_ACCESSOR=$(echo "$SECRET_ID_JSON" | jq -r '.data.secret_id_accessor')

if [ -z "$ROLE_ID" ] || [ "$ROLE_ID" = "null" ] || [ -z "$SECRET_ID" ] || [ "$SECRET_ID" = "null" ] \
  || [ -z "$SECRET_ID_ACCESSOR" ] || [ "$SECRET_ID_ACCESSOR" = "null" ]; then
  echo "Failed to obtain role_id/secret_id/secret_id_accessor for AppRole role 'kes'" >&2
  exit 1
fi

# Record the new accessor so next run can revoke it before minting again.
printf '%s' "$SECRET_ID_ACCESSOR" > "$ACCESSOR_STATE_FILE"
chmod 600 "$ACCESSOR_STATE_FILE"

jq -n --arg role_id "$ROLE_ID" --arg secret_id "$SECRET_ID" \
  '{role_id: $role_id, secret_id: $secret_id}' > "$APPROLE_FILE"
chmod 600 "$APPROLE_FILE"

echo "OpenBao init complete. AppRole credentials written to $APPROLE_FILE"
