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
: "${MINIO_API_ACCESS_KEY:?MINIO_API_ACCESS_KEY must be set}"
: "${MINIO_API_SECRET_KEY:?MINIO_API_SECRET_KEY must be set}"

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

# Phase 2B's document upload/download/versioning API needs its own MinIO
# credential scoped to only the 'documents' bucket, not the MINIO_ROOT_USER/
# PASSWORD root credential used above (which has full admin rights over the
# whole server). All three `mc admin` calls below are idempotent -- verified
# live against this minio/mc:latest image: `admin user add` re-run with the
# same access/secret key pair succeeds again rather than erroring, `admin
# policy create` re-run with the same policy document just re-applies it,
# and `admin policy attach` re-run with an already-attached policy succeeds
# again as a no-op -- so this is safe to run on every container start, same
# as `mc mb --ignore-existing` above.
#
# NOTE: `mc admin policy` subcommand syntax has changed across mc versions
# (older releases used `mc admin policy set/add`); confirmed via `docker run
# --rm minio/mc:latest admin policy --help` that this image's version
# (RELEASE.2025-08-13) uses `create` + `attach`/`detach`.
echo "Creating IAM policy 'drm-api-documents-rw' (documents bucket only, no admin/wildcard access)..."
mc admin policy create local drm-api-documents-rw /policy/drm-api-policy.json

echo "Creating scoped MinIO user for the Phase 2B API service..."
mc admin user add local "$MINIO_API_ACCESS_KEY" "$MINIO_API_SECRET_KEY"

echo "Attaching 'drm-api-documents-rw' policy to the API user..."
mc admin policy attach local drm-api-documents-rw --user "$MINIO_API_ACCESS_KEY"

echo "MinIO bucket provisioning complete."
