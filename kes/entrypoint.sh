#!/bin/sh
set -eu

# NOTE: minio/kes:latest is a minimal image with coreutils + bash but no
# sed, grep, or jq (verified via `docker run --rm --entrypoint sh
# minio/kes:latest -c "ls /bin /usr/bin"`). /bin/sh is a symlink to bash
# there, so this script relies only on bash builtins: [[ =~ ]] regex
# matching to pull role_id/secret_id out of the AppRole JSON (which
# jq -n pretty-prints across multiple lines with a space after each
# colon, e.g. `"role_id": "..."`, not the compact single-line form a
# naive sed/grep one-liner would assume), and ${var//search/replace}
# parameter expansion in place of sed for template substitution.

IDENTITY=$(tr -d '[:space:]' < /certs/minio-client-identity.txt)

APPROLE_JSON=$(cat /shared/kes-approle.json)

if [[ "$APPROLE_JSON" =~ \"role_id\"[[:space:]]*:[[:space:]]*\"([^\"]*)\" ]]; then
  ROLE_ID="${BASH_REMATCH[1]}"
else
  echo "entrypoint.sh: failed to parse role_id from /shared/kes-approle.json" >&2
  exit 1
fi

if [[ "$APPROLE_JSON" =~ \"secret_id\"[[:space:]]*:[[:space:]]*\"([^\"]*)\" ]]; then
  SECRET_ID="${BASH_REMATCH[1]}"
else
  echo "entrypoint.sh: failed to parse secret_id from /shared/kes-approle.json" >&2
  exit 1
fi

if [ -z "$IDENTITY" ] || [ -z "$ROLE_ID" ] || [ -z "$SECRET_ID" ]; then
  echo "entrypoint.sh: one or more required values (identity/role_id/secret_id) is empty" >&2
  exit 1
fi

CONFIG=$(cat /template/server-config.yaml.template)
CONFIG="${CONFIG//__MINIO_IDENTITY__/$IDENTITY}"
CONFIG="${CONFIG//__VAULT_ROLE_ID__/$ROLE_ID}"
CONFIG="${CONFIG//__VAULT_SECRET_ID__/$SECRET_ID}"
printf '%s\n' "$CONFIG" > /tmp/server-config.yaml

exec /kes server --config /tmp/server-config.yaml
