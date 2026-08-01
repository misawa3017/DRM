#!/usr/bin/env bash
# Proves the full storage chain (MinIO -> KES -> OpenBao) actually encrypts
# and decrypts real object data, not just that each service independently
# reports healthy.
#
# Requires MINIO_ROOT_USER / MINIO_ROOT_PASSWORD in the environment (e.g.
# `source .env`) and the drm-* stack running via `docker compose up`.
set -euo pipefail

: "${MINIO_ROOT_USER:?set MINIO_ROOT_USER or export it from .env first}"
: "${MINIO_ROOT_PASSWORD:?set MINIO_ROOT_PASSWORD or export it from .env first}"

# The compose project's generated network name (verified via `docker network
# ls` -- compose derives it from the project/directory name, which is
# "drm_default" here; do not assume this without checking on other hosts).
NETWORK="drm_default"

# minio/mc's image entrypoint is already `mc` (verified via
# `docker inspect minio/mc:latest --format '{{.Config.Entrypoint}}'` -> "[mc]"),
# so invoking it is `docker run ... minio/mc <command>`, not `mc mc <command>`
# as an earlier draft of this script had it.
#
# WORKDIR must live under /tmp so it can be bind-mounted into the mc
# container below -- mc runs as a fresh --rm container each invocation, so
# the local file it copies from / downloads to has to be visible on both
# sides of the bind mount.
WORKDIR=$(mktemp -d)
trap 'rm -rf "$WORKDIR"' EXIT

# Credentials are passed via the MC_HOST_<alias> env var (a URL of the form
# http://ACCESS_KEY:SECRET_KEY@HOST:PORT) instead of `mc alias set`, which
# writes to a persistent ~/.mc/config.json -- pointless complexity here since
# every invocation below is a fresh --rm container anyway.
mc() {
  docker run --rm --network "$NETWORK" \
    -e "MC_HOST_local=http://${MINIO_ROOT_USER}:${MINIO_ROOT_PASSWORD}@minio:9000" \
    -v "$WORKDIR:$WORKDIR" \
    minio/mc "$@"
}

echo "Creating 'documents' bucket if it doesn't exist..."
mc mb --ignore-existing local/documents

echo "Setting default SSE-KMS encryption on the bucket..."
mc encrypt set sse-kms drm-default-key local/documents

echo "Uploading a test object..."
echo "phase 2a verification $(date -u +%FT%TZ)" > "$WORKDIR/verify-test.txt"
mc cp "$WORKDIR/verify-test.txt" local/documents/verify-test.txt

echo "Confirming the object reports server-side encryption..."
# Real `mc stat` output looks like:
#   Encryption: SSE-KMS (arn:aws:kms:drm-default-key)
# (there is no literal "Encrypted" field -- an earlier draft of this script
# grepped for that and always failed even on a genuinely encrypted object).
STAT_OUTPUT=$(mc stat local/documents/verify-test.txt)
echo "$STAT_OUTPUT"
echo "$STAT_OUTPUT" | grep -q "Encryption.*SSE-KMS" || {
  echo "FAIL: object does not report SSE-KMS encryption metadata" >&2
  exit 1
}
echo "$STAT_OUTPUT" | grep -q "drm-default-key" || {
  echo "FAIL: object is not encrypted with the expected KMS key (drm-default-key)" >&2
  exit 1
}

echo "Downloading and verifying content round-trips correctly..."
mc cat local/documents/verify-test.txt > "$WORKDIR/verify-test-downloaded.txt"
diff "$WORKDIR/verify-test.txt" "$WORKDIR/verify-test-downloaded.txt"

echo "Cleaning up test object..."
mc rm local/documents/verify-test.txt

echo "Encrypted storage verification passed."
