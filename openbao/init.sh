#!/bin/sh
set -eu

SHARED_DIR=/shared
INIT_FILE="$SHARED_DIR/openbao-init.json"
APPROLE_FILE="$SHARED_DIR/kes-approle.json"

export BAO_ADDR=http://openbao:8200

# The openbao/openbao image does not ship jq, and `bao ... -format=json`
# output is pretty-printed (newlines + a space after every colon), which
# breaks naive single-line `grep -o '"key":value'` parsing. jq is far more
# robust for this than hand-rolled regexes, and this container runs as root
# (see docker-compose.yml), so install it if it isn't already present.
if ! command -v jq >/dev/null 2>&1; then
  echo "Installing jq..."
  apk add --no-cache jq >/dev/null
fi

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

if ! bao read -format=json auth/approle/role/kes >/dev/null 2>&1; then
  echo "Creating AppRole role 'kes'..."
  bao write auth/approle/role/kes policies=kes-policy token_ttl=1h token_max_ttl=4h
else
  echo "AppRole role 'kes' already exists."
fi

ROLE_ID=$(bao read -format=json auth/approle/role/kes/role-id | jq -r '.data.role_id')
SECRET_ID=$(bao write -f -format=json auth/approle/role/kes/secret-id | jq -r '.data.secret_id')

if [ -z "$ROLE_ID" ] || [ "$ROLE_ID" = "null" ] || [ -z "$SECRET_ID" ] || [ "$SECRET_ID" = "null" ]; then
  echo "Failed to obtain role_id/secret_id for AppRole role 'kes'" >&2
  exit 1
fi

jq -n --arg role_id "$ROLE_ID" --arg secret_id "$SECRET_ID" \
  '{role_id: $role_id, secret_id: $secret_id}' > "$APPROLE_FILE"
chmod 600 "$APPROLE_FILE"

echo "OpenBao init complete. AppRole credentials written to $APPROLE_FILE"
