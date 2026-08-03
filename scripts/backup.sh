#!/usr/bin/env bash
# Daily backup of the DRM stack's full state (Postgres metadata + MinIO's
# encrypted objects + the OpenBao key material needed to decrypt them).
# See docs/superpowers/specs/2026-08-03-backup-disaster-recovery-design.md
# for the full design rationale.
#
# Run from the repo root (docker compose resolves service/volume names
# relative to the compose file here). Intended to be triggered by the
# drm-backup.timer systemd unit (see scripts/systemd/), not run by hand
# except for testing.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
source .env
source scripts/lib/backup-notify.sh

: "${BACKUP_SSH_TARGET:?set BACKUP_SSH_TARGET in .env}"
: "${BACKUP_SSH_KEY_PATH:?set BACKUP_SSH_KEY_PATH in .env}"
: "${BACKUP_RETENTION_DAYS:?set BACKUP_RETENTION_DAYS in .env}"
: "${BACKUP_LOCAL_RETENTION_DAYS:?set BACKUP_LOCAL_RETENTION_DAYS in .env}"

LOCK_FILE="${LOCK_FILE:-/var/lock/drm-backup.lock}"
STAGING_ROOT="${STAGING_ROOT:-/var/backups/drm-staging}"
LOG_FILE="${LOG_FILE:-/var/log/drm-backup.log}"
DATE=$(date -u +%F)
STAGING_DIR="$STAGING_ROOT/$DATE"
PASSPHRASE_FILE="secrets/backup-passphrase"

log() {
  echo "[$(date -u +%FT%TZ)] $*" | tee -a "$LOG_FILE"
}

fail() {
  local step="$1"
  shift
  local detail="$*"
  log "FAIL at $step: $detail"
  notify_failure "$step" "$detail" || log "notify_failure itself failed"
  exit 1
}

# Docker Compose labels every volume it manages with
# com.docker.compose.volume=<short-name>, regardless of the actual
# (project-prefixed) volume name -- this avoids hardcoding the "drm_"
# prefix (confirmed via `docker volume ls --format '{{.Name}} {{.Labels}}'`
# during design; see the linked spec).
resolve_volume() {
  local short_name="$1" full_name
  full_name=$(docker volume ls --filter "label=com.docker.compose.volume=${short_name}" --format '{{.Name}}' | head -1)
  if [ -z "$full_name" ]; then
    fail "resolve_volume" "could not find a volume with label com.docker.compose.volume=${short_name}"
  fi
  echo "$full_name"
}

tar_volume() {
  local short_name="$1" out_file="$2" full_name
  full_name=$(resolve_volume "$short_name")
  docker run --rm -v "${full_name}:/source:ro" -v "${STAGING_DIR}:/backup" alpine \
    tar czf "/backup/${out_file}" -C /source . \
    || fail "tar_volume:${short_name}" "tar of volume ${full_name} failed"
}

exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  log "another backup run is already in progress, exiting"
  exit 0
fi

mkdir -p "$STAGING_DIR"

STACK_STOPPED=0
restore_stack() {
  if [ "$STACK_STOPPED" = "1" ]; then
    log "restoring api/worker after backup (or after failure)"
    docker compose start api worker || log "WARNING: failed to restart api/worker -- manual intervention required"
    STACK_STOPPED=0
  fi
}
# Runs on ANY exit path (normal, `fail`'s `exit 1`, or an unexpected error
# under `set -e`) -- service recovery must never depend on the rest of the
# script reaching its own restart step. Restoring service always outranks
# the backup itself succeeding.
trap restore_stack EXIT

log "starting backup for $DATE"

log "stopping api/worker (entering maintenance window)"
docker compose stop api worker || fail "stop-services" "docker compose stop api worker failed"
STACK_STOPPED=1

log "dumping Postgres..."
docker compose exec -T postgres pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -F custom \
  > "$STAGING_DIR/postgres.dump" \
  || fail "pg_dump" "pg_dump failed"

log "backing up MinIO/OpenBao volumes..."
tar_volume minio_data minio_data.tar.gz
tar_volume openbao_data openbao_data.tar.gz
tar_volume openbao_init openbao_init.tar.gz
tar_volume openbao_approle openbao_approle.tar.gz

log "backing up KES/MinIO mTLS certs..."
tar czf "$STAGING_DIR/kes-secrets.tar.gz" -C secrets/kes . \
  || fail "tar-kes-secrets" "tar of secrets/kes failed"

log "restarting api/worker (leaving maintenance window)"
restore_stack

log "waiting for api to respond healthy (best-effort, does not abort the backup)..."
API_HEALTHY=0
for i in $(seq 1 30); do
  if curl -sf http://api.drm.localhost/health >/dev/null 2>&1; then
    API_HEALTHY=1
    break
  fi
  sleep 2
done
if [ "$API_HEALTHY" = "0" ]; then
  log "WARNING: api did not respond healthy within 60s of restart -- backup data is already safe, but the live service may need manual attention"
  notify_failure "post-restart-health-check" "api did not respond healthy within 60s of restart; backup itself continues" \
    || log "notify_failure itself failed"
fi

log "writing manifest and checksums..."
GIT_COMMIT=$(git rev-parse HEAD)
(
  cd "$STAGING_DIR"
  sha256sum -- *.tar.gz postgres.dump > checksums.sha256
  {
    echo "date: $DATE"
    echo "git_commit: $GIT_COMMIT"
  } > manifest.txt
) || fail "manifest" "writing manifest.txt/checksums.sha256 failed"

log "backup packaging complete (encryption/upload happen in a later step)"
