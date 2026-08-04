#!/usr/bin/env bash
# Restores the full DRM stack (Postgres + MinIO + OpenBao key material) from
# a backup produced by scripts/backup.sh. See
# docs/superpowers/specs/2026-08-03-backup-disaster-recovery-design.md.
#
# DESTRUCTIVE: overwrites the current minio_data/openbao_data/openbao_init/
# openbao_approle/keycloak_data volumes and the current Postgres database.
# Only run this against a host you actually intend to restore onto.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
source .env

ENCRYPTED_FILE="${1:?usage: scripts/restore.sh <path-to-drm-backup-*.tar.gpg>}"
PASSPHRASE_FILE="secrets/backup-passphrase"
RESTORE_ROOT=$(mktemp -d)
trap 'rm -rf "$RESTORE_ROOT"' EXIT

echo "Decrypting $ENCRYPTED_FILE..."
gpg --batch --yes --pinentry-mode loopback --passphrase-file "$PASSPHRASE_FILE" \
  --decrypt "$ENCRYPTED_FILE" | tar xf - -C "$RESTORE_ROOT"

BACKUP_DIR=$(find "$RESTORE_ROOT" -mindepth 1 -maxdepth 1 -type d | head -1)
if [ -z "$BACKUP_DIR" ]; then
  echo "FAIL: decrypted archive did not contain the expected dated directory" >&2
  exit 1
fi
echo "Restoring from $BACKUP_DIR"
cat "$BACKUP_DIR/manifest.txt"

echo "Verifying checksums..."
(cd "$BACKUP_DIR" && sha256sum -c checksums.sha256) \
  || { echo "FAIL: checksum verification failed, refusing to restore from a possibly corrupt backup" >&2; exit 1; }

read -r -p "This will STOP the stack and OVERWRITE minio_data/openbao_data/openbao_init/openbao_approle/keycloak_data and the Postgres database. Type 'yes' to continue: " CONFIRM
[ "$CONFIRM" = "yes" ] || { echo "Aborted."; exit 1; }

echo "Stopping the stack..."
docker compose down

restore_volume() {
  # tar_flags defaults to "xzf" (gunzip); backup.sh writes minio_data and
  # the openbao_* volumes without gzip (plain "cf", since they're already
  # ciphertext that doesn't meaningfully compress), so those call sites
  # below pass "xf" to match. keycloak_data keeps the default (backup.sh
  # tars it with gzip).
  local short_name="$1" tar_file="$2" tar_flags="${3:-xzf}" full_name
  full_name=$(docker volume ls --filter "label=com.docker.compose.volume=${short_name}" --format '{{.Name}}' | head -1)
  if [ -z "$full_name" ]; then
    echo "FAIL: could not find volume for ${short_name} -- run 'docker compose up -d && docker compose down' once on a fresh host first so compose creates the named volumes" >&2
    exit 1
  fi
  echo "Restoring ${short_name} into volume ${full_name}..."
  docker run --rm -v "${full_name}:/target" -v "${BACKUP_DIR}:/backup:ro" alpine \
    sh -c "rm -rf /target/* /target/..?* /target/.[!.]* 2>/dev/null; tar ${tar_flags} /backup/${tar_file} -C /target"
}

restore_volume minio_data minio_data.tar xf
restore_volume openbao_data openbao_data.tar xf
restore_volume openbao_init openbao_init.tar xf
restore_volume openbao_approle openbao_approle.tar xf
# keycloak_data holds Keycloak's own user/realm database -- every Postgres
# row that references a user (User.keycloakSub, Permission.principalId,
# Document.createdBy, AuditLog.actorId, etc.) points at a Keycloak `sub`
# UUID minted from this data. Without restoring it, a fresh Keycloak import
# would mint new UUIDs for every user, orphaning all ownership/permission/
# audit data even though the documents themselves came back fine.
restore_volume keycloak_data keycloak_data.tar.gz

echo "Restoring secrets/kes/..."
rm -rf secrets/kes
mkdir -p secrets/kes
tar xzf "$BACKUP_DIR/kes-secrets.tar.gz" -C secrets/kes

echo "Starting Postgres only (must be restored before api/worker start against it)..."
docker compose up -d postgres

echo "Waiting for Postgres to be ready..."
for i in $(seq 1 30); do
  if docker compose exec -T postgres pg_isready -U "$POSTGRES_USER" >/dev/null 2>&1; then
    break
  fi
  if [ "$i" = 30 ]; then
    echo "FAIL: postgres did not become ready within 60s" >&2
    exit 1
  fi
  sleep 2
done

echo "Restoring Postgres database from postgres.dump..."
# --clean --if-exists drops conflicting objects first, making this restore
# safe to run against a fresh (just-created, empty-schema) database.
cat "$BACKUP_DIR/postgres.dump" | docker compose exec -T postgres \
  pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists --no-owner

echo "Starting the rest of the stack..."
docker compose up -d

echo "Waiting for api to respond healthy..."
# 500 * 2s = 1000s (~16-17 minutes). api depends_on clamav: condition:
# service_healthy, and clamav's own healthcheck start_period is 900s --
# on a genuinely fresh/destroyed host (the real disaster-recovery scenario
# this script exists for), clamav_data won't exist yet, freshclam has to
# download virus definitions from scratch, and api can't even start until
# clamav passes its healthcheck. A shorter wait here risks a false "FAIL"
# right after Postgres/MinIO/OpenBao/documents have already been correctly
# restored, which could make a supervising operator wrongly think the
# restore itself failed. This is a manual, human-supervised, infrequent,
# high-stakes operation, so it's fine to wait comfortably past clamav's
# documented worst case rather than optimize for a fast failure here.
for i in $(seq 1 500); do
  if curl -sf http://api.drm.localhost/health >/dev/null 2>&1; then
    break
  fi
  if [ "$i" = 500 ]; then
    echo "FAIL: api did not respond healthy within 1000s of restart" >&2
    exit 1
  fi
  sleep 2
done

echo "Restore complete. Now manually verify: log in, browse a folder, download a document, confirm audit logs and permissions are intact."
