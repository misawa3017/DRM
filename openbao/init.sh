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
# Records the secret_id_accessor minted on the previous run, so it can be
# destroyed before minting a new one (see below). Lives in the init-only
# volume, not the approle volume KES can read -- it's operator bookkeeping,
# not something KES needs.
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

# Before minting a new secret_id, destroy the accessor recorded from the
# previous run (if any). Without this, every `docker compose up` /
# container restart mints another secret_id that defaults to never
# expiring (secret_id_ttl was 0 until this change) and unlimited uses, and
# nothing ever revokes the old ones -- they just accumulate forever with no
# inventory. Confirmed live against this stack's OpenBao before this fix:
# `bao list auth/approle/role/kes/secret-id` already showed 16 accumulated,
# never-revoked accessors from repeated restarts during development.
if [ -f "$ACCESSOR_STATE_FILE" ]; then
  OLD_ACCESSOR=$(cat "$ACCESSOR_STATE_FILE")
else
  OLD_ACCESSOR=""
fi

if [ -n "$OLD_ACCESSOR" ]; then
  echo "Revoking previous AppRole secret_id (accessor $OLD_ACCESSOR)..."
  # Confirmed live: `bao write -f auth/approle/role/<role>/secret-id-accessor/destroy
  # secret_id_accessor=<accessor>` is the real API (param name is
  # secret_id_accessor, NOT `accessor`); destroying an accessor that's
  # already gone returns a 500 "failed to find accessor entry" error, so
  # this is best-effort/non-fatal -- a stale/already-destroyed accessor
  # here shouldn't block bringing the stack up.
  if ! bao write -f auth/approle/role/kes/secret-id-accessor/destroy secret_id_accessor="$OLD_ACCESSOR" >/dev/null 2>&1; then
    echo "Warning: could not revoke previous secret_id accessor $OLD_ACCESSOR (it may already be gone)." >&2
  fi
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
