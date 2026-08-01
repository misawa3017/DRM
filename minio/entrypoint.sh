#!/bin/sh
set -eu

# Idempotently provisions the 'documents' bucket with default SSE-KMS
# encryption (via KES's drm-default-key), so it exists automatically on
# every fresh `docker compose up` instead of only as a side effect of
# someone happening to run scripts/verify-encrypted-storage.sh. Phase 2B's
# application code needs this bucket + encryption policy to exist
# reliably, not conditionally.
#
# minio/mc's image entrypoint is already `mc` (confirmed via
# `docker inspect minio/mc:latest --format '{{.Config.Entrypoint}}'` ->
# "[mc]", same as the note in scripts/verify-encrypted-storage.sh), so this
# script is installed as a full entrypoint override -- same pattern as
# openbao-init and kes.

: "${MINIO_ROOT_USER:?MINIO_ROOT_USER must be set}"
: "${MINIO_ROOT_PASSWORD:?MINIO_ROOT_PASSWORD must be set}"

# `mc alias set` writes to this container's own ~/.mc/config.json, which is
# fine here (unlike scripts/verify-encrypted-storage.sh's mc() helper,
# which spawns a fresh --rm container per invocation and so uses
# MC_HOST_<alias> instead) -- this is a single one-shot container that runs
# once and exits.
mc alias set local http://minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null

echo "Creating 'documents' bucket if it doesn't exist..."
mc mb --ignore-existing local/documents

echo "Setting default SSE-KMS encryption (drm-default-key) on 'documents'..."
mc encrypt set sse-kms drm-default-key local/documents

echo "MinIO bucket provisioning complete."
