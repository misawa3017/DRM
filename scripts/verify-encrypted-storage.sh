#!/usr/bin/env bash
# Proves the full storage chain (MinIO -> KES -> OpenBao) actually encrypts
# and decrypts real object data, not just that each service independently
# reports healthy.
#
# Also proves the Phase 2B scoped API credential (MINIO_API_ACCESS_KEY/
# SECRET_KEY, provisioned by minio-init -- see minio/entrypoint.sh and
# minio/drm-api-policy.json) is actually enforced by MinIO, not just
# configured: it must be able to read/write/list/delete inside 'documents',
# and must be REJECTED for creating buckets, reading/listing any other
# bucket, and admin operations. A policy that "looks scoped" in its JSON
# but isn't enforced would be a real security gap, so those forbidden
# operations are actually attempted here and their failure is asserted,
# not skipped.
#
# Requires MINIO_ROOT_USER / MINIO_ROOT_PASSWORD / MINIO_API_ACCESS_KEY /
# MINIO_API_SECRET_KEY in the environment (e.g. `source .env`) and the
# drm-* stack running via `docker compose up`.
set -euo pipefail

: "${MINIO_ROOT_USER:?set MINIO_ROOT_USER or export it from .env first}"
: "${MINIO_ROOT_PASSWORD:?set MINIO_ROOT_PASSWORD or export it from .env first}"
: "${MINIO_API_ACCESS_KEY:?set MINIO_API_ACCESS_KEY or export it from .env first}"
: "${MINIO_API_SECRET_KEY:?set MINIO_API_SECRET_KEY or export it from .env first}"

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

# Same pattern, but authenticated as the scoped Phase 2B API credential
# instead of root -- used by the "scope is actually enforced" checks below.
mcapi() {
  docker run --rm --network "$NETWORK" \
    -e "MC_HOST_apiuser=http://${MINIO_API_ACCESS_KEY}:${MINIO_API_SECRET_KEY}@minio:9000" \
    -v "$WORKDIR:$WORKDIR" \
    minio/mc "$@"
}

# Runs a command that is expected to FAIL with an access-control rejection
# (not just any failure). Fails the script if the command unexpectedly
# succeeds -- silent success would mean the policy isn't actually being
# enforced. Also fails the script if the command fails for some OTHER
# reason (malformed command, network hiccup, a future `mc` syntax change,
# etc.) -- a non-zero exit alone doesn't prove authorization was actually
# tested, so the captured output must contain an access-control-specific
# signal, not merely be non-empty.
#
# The two accepted signals were captured verbatim from a real run against
# this exact policy/mc version (see task-17-report.md): most denials say
# "Access Denied", but denying a GetObject read on a bucket the scoped
# credential has zero grants on instead produces "Insufficient permissions
# to access this path" -- both are genuine MinIO/mc access-control
# rejections, not generic errors, so both are matched.
expect_denied() {
  local desc="$1"
  shift
  if "$@" >"$WORKDIR/expect_denied.out" 2>&1; then
    echo "FAIL: '$desc' was supposed to be denied but succeeded:" >&2
    cat "$WORKDIR/expect_denied.out" >&2
    exit 1
  fi
  if ! grep -qiE "access denied|insufficient permissions" "$WORKDIR/expect_denied.out"; then
    echo "FAIL: '$desc' failed, but not with an access-denied error -- this proves nothing about policy enforcement. Actual output:" >&2
    cat "$WORKDIR/expect_denied.out" >&2
    exit 1
  fi
  echo "  correctly denied: $desc"
  echo "    -> $(tail -n1 "$WORKDIR/expect_denied.out")"
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

echo ""
echo "--- Verifying scoped API credential (MINIO_API_ACCESS_KEY) is enforced ---"

# For the "cannot access other buckets" checks below to prove anything, a
# second bucket must actually exist -- otherwise "access denied" could
# equally mean "bucket doesn't exist", which would prove nothing about the
# policy. Created/destroyed with the root credential; the scoped credential
# should never be able to see or touch it.
OTHER_BUCKET="verify-scope-other-$$"
echo "Creating a throwaway second bucket ('$OTHER_BUCKET') as root, to prove the scoped credential really can't reach buckets other than 'documents' (not just that nothing else exists)..."
mc mb --ignore-existing "local/$OTHER_BUCKET"
echo "root-owned data" > "$WORKDIR/other-bucket-object.txt"
mc cp "$WORKDIR/other-bucket-object.txt" "local/$OTHER_BUCKET/secret.txt"

echo ""
echo "Allowed operations (must succeed) using the scoped credential on 'documents':"

echo "Uploading via scoped credential..."
echo "phase 2b scope verification $(date -u +%FT%TZ)" > "$WORKDIR/scope-test.txt"
mcapi cp "$WORKDIR/scope-test.txt" apiuser/documents/scope-test.txt

echo "Listing 'documents' via scoped credential..."
mcapi ls apiuser/documents/ | grep -q "scope-test.txt" || {
  echo "FAIL: scoped credential could not list its own upload in 'documents'" >&2
  exit 1
}

echo "Downloading via scoped credential..."
mcapi cat apiuser/documents/scope-test.txt > "$WORKDIR/scope-test-downloaded.txt"
diff "$WORKDIR/scope-test.txt" "$WORKDIR/scope-test-downloaded.txt"

echo "Deleting via scoped credential..."
mcapi rm apiuser/documents/scope-test.txt

echo "  allowed operations all succeeded (upload, list, download, delete on 'documents')"

echo ""
echo "Forbidden operations (must be denied) using the scoped credential:"

expect_denied "create a new bucket" \
  mcapi mb "apiuser/verify-scope-should-not-exist-$$"

expect_denied "list a bucket other than 'documents'" \
  mcapi ls "apiuser/$OTHER_BUCKET"

expect_denied "read an object in a bucket other than 'documents'" \
  mcapi cat "apiuser/$OTHER_BUCKET/secret.txt"

expect_denied "delete a bucket" \
  mcapi rb "apiuser/$OTHER_BUCKET" --force

expect_denied "run an admin operation (list users)" \
  mcapi admin user list apiuser

expect_denied "run an admin operation (list policies)" \
  mcapi admin policy list apiuser

# Belt-and-suspenders: the top-level bucket listing MinIO returns for a user
# without s3:ListAllMyBuckets only includes buckets that user's policy
# explicitly grants s3:ListBucket on (confirmed live) -- it must show
# 'documents' and must NOT leak the existence of $OTHER_BUCKET.
echo "Confirming top-level bucket listing via scoped credential only shows 'documents'..."
TOP_LEVEL=$(mcapi ls apiuser)
echo "$TOP_LEVEL"
echo "$TOP_LEVEL" | grep -q "documents/" || {
  echo "FAIL: scoped credential's bucket listing does not include 'documents'" >&2
  exit 1
}
echo "$TOP_LEVEL" | grep -q "$OTHER_BUCKET" && {
  echo "FAIL: scoped credential's bucket listing leaked '$OTHER_BUCKET'" >&2
  exit 1
}
echo "  top-level listing correctly scoped to 'documents' only"

echo "Cleaning up throwaway second bucket..."
mc rm "local/$OTHER_BUCKET/secret.txt"
mc rb "local/$OTHER_BUCKET"

echo ""
echo "Encrypted storage verification passed (including scoped-credential enforcement)."
