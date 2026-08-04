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

# Everything this script writes directly (staging dir, postgres.dump,
# manifest.txt, checksums.sha256, the kes tar) is either the plaintext
# Postgres dump or key material -- default to owner-only from here on so a
# failed run doesn't leave any of it world-readable. Files created by the
# one-shot `docker run alpine tar ...` containers in tar_volume() don't
# inherit this (they get the container's own default umask), which is why
# STAGING_DIR itself is also explicitly chmod 700'd below -- directory
# permissions gate access to everything inside it regardless of individual
# file modes.
umask 077

log() {
  echo "[$(date -u +%FT%TZ)] $*" | tee -a "$LOG_FILE"
}

# Set to 1 by fail() and by every direct notify_failure call site, so the
# EXIT trap's safety net (below) knows a failure notification has already
# gone out for this run and doesn't send a redundant generic one.
NOTIFIED_FAILURE=0

fail() {
  local step="$1"
  shift
  local detail="$*"
  log "FAIL at $step: $detail"
  notify_failure "$step" "$detail"$'\n\nLast log lines:\n'"$(tail -n 10 "$LOG_FILE" 2>/dev/null)" \
    || log "notify_failure itself failed"
  NOTIFIED_FAILURE=1
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
  # tar_flags defaults to "czf" (gzip). minio_data and the openbao_* volumes
  # hold ciphertext (SSE-KMS/OpenBao-encrypted) that doesn't meaningfully
  # compress, so their call sites below pass "cf" to skip gzip and save
  # CPU time inside the stop-the-world maintenance window.
  local short_name="$1" out_file="$2" tar_flags="${3:-czf}" full_name
  full_name=$(resolve_volume "$short_name")
  docker run --rm -v "${full_name}:/source:ro" -v "${STAGING_DIR}:/backup" alpine \
    tar "$tar_flags" "/backup/${out_file}" -C /source . \
    || fail "tar_volume:${short_name}" "tar of volume ${full_name} failed"
}

exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  log "another backup run is already in progress, exiting"
  exit 0
fi

STACK_STOPPED=0
restore_stack() {
  if [ "$STACK_STOPPED" = "1" ]; then
    log "restoring api/worker/keycloak after backup (or after failure)"
    if docker compose up -d --no-deps api worker keycloak; then
      STACK_STOPPED=0
    else
      # Service recovery itself failing is the single worst outcome this
      # script can produce (backup may have failed AND the live stack is
      # now down) -- this gets its own immediate, specific notification
      # rather than relying solely on the generic unhandled-exit safety
      # net in the EXIT trap, since an operator needs to know THIS
      # specifically failed, not just that "something" did.
      log "WARNING: failed to restart api/worker/keycloak -- manual intervention required"
      notify_failure "restore-stack" "docker compose up -d --no-deps api worker keycloak failed after the backup run -- api/worker/keycloak may still be down, manual intervention required."$'\n\nLast log lines:\n'"$(tail -n 10 "$LOG_FILE" 2>/dev/null)" \
        || log "notify_failure itself failed"
      NOTIFIED_FAILURE=1
    fi
  fi
}

# Always remove the plaintext staging directory on the way out, whether the
# run succeeded or failed. The happy path also removes it explicitly and
# earlier (right after encryption, further down) to shrink the exposure
# window, so by the time this runs on a successful run it's usually already
# gone -- this is the backstop for every path that exits before reaching
# that point (pg_dump failure, a tar failure, encryption failure, etc.),
# which previously left the plaintext Postgres dump / OpenBao unseal key /
# everything else sitting on disk forever.
cleanup_staging() {
  if [ -n "${STAGING_DIR:-}" ] && [ -d "$STAGING_DIR" ]; then
    rm -rf "$STAGING_DIR"
  fi
}

# Runs on ANY exit path (normal, `fail`'s `exit 1`, or an unexpected error
# under `set -e` -- including commands that were never explicitly wrapped
# in `fail()`, like `git rev-parse` or the retention `find`). Restoring
# service always outranks the backup itself succeeding, so that happens
# first; staging cleanup always happens regardless of outcome; and finally,
# if the script is exiting non-zero and nothing has already sent a failure
# notification for this run, send a generic one so no failure mode is ever
# silent.
on_exit() {
  local exit_code=$?
  restore_stack
  cleanup_staging
  if [ "$exit_code" != "0" ] && [ "$NOTIFIED_FAILURE" = "0" ]; then
    log "FAIL: unhandled exit (status $exit_code)"
    notify_failure "unhandled-exit" "backup.sh exited with status $exit_code, see $LOG_FILE."$'\n\nLast log lines:\n'"$(tail -n 10 "$LOG_FILE" 2>/dev/null)" \
      || log "notify_failure itself failed"
    NOTIFIED_FAILURE=1
  fi
}
trap on_exit EXIT

# mkdir happens after the trap is installed (not before) so that even a
# failure to create the staging directory itself -- or anything else
# between here and the stop-services step -- is covered by on_exit's
# cleanup/notify safety net, not just steps after this point.
mkdir -p "$STAGING_DIR"
chmod 700 "$STAGING_DIR"

log "starting backup for $DATE"

log "stopping api/worker/keycloak (entering maintenance window)"
# -t 30: docker compose's default stop timeout is 10s (SIGTERM, then
# SIGKILL if the container hasn't exited). Keycloak's dev-mode embedded H2
# store was empirically observed (during this fix wave's own testing) to
# still be mid-write when SIGKILLed under the 10s default, corrupting
# keycloak_data's H2 file and crash-looping the container on next start.
# 30s gives the JVM + Infinispan cache layer + H2 enough headroom to shut
# down cleanly instead of being killed mid-write; api/worker exit quickly
# regardless, so this only adds worst-case time, not typical time.
docker compose stop -t 30 api worker keycloak || fail "stop-services" "docker compose stop api worker keycloak failed"
STACK_STOPPED=1

log "dumping Postgres..."
docker compose exec -T postgres pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -F custom \
  > "$STAGING_DIR/postgres.dump" \
  || fail "pg_dump" "pg_dump failed"

log "backing up MinIO/OpenBao volumes..."
# minio_data and the openbao_* volumes hold SSE-KMS/OpenBao-encrypted
# ciphertext that doesn't meaningfully compress -- "cf" skips gzip to save
# CPU time inside the stop-the-world maintenance window. keycloak_data
# (Keycloak's own H2-backed user/realm database) is small and plausibly
# compressible, so it keeps the default gzip.
tar_volume minio_data minio_data.tar.gz cf
tar_volume openbao_data openbao_data.tar.gz cf
tar_volume openbao_init openbao_init.tar.gz cf
tar_volume openbao_approle openbao_approle.tar.gz cf
# keycloak_data holds Keycloak's own user/realm database -- every Postgres
# row that references a user (User.keycloakSub, Permission.principalId,
# Document.createdBy, AuditLog.actorId, etc.) points at a Keycloak `sub`
# UUID minted from this data. Without backing it up, a restore brings back
# documents but orphans all ownership/permission/audit data, because a
# fresh Keycloak import mints new UUIDs for every user.
tar_volume keycloak_data keycloak_data.tar.gz

log "backing up KES/MinIO mTLS certs..."
tar czf "$STAGING_DIR/kes-secrets.tar.gz" -C secrets/kes . \
  || fail "tar-kes-secrets" "tar of secrets/kes failed"

log "restarting api/worker/keycloak (leaving maintenance window)"
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
  notify_failure "post-restart-health-check" "api did not respond healthy within 60s of restart; backup itself continues."$'\n\nLast log lines:\n'"$(tail -n 10 "$LOG_FILE" 2>/dev/null)" \
    || log "notify_failure itself failed"
  NOTIFIED_FAILURE=1
fi

log "writing manifest and checksums..."
GIT_COMMIT=$(git rev-parse HEAD)
(
  cd "$STAGING_DIR"
  sha256sum -- *.tar.gz postgres.dump > checksums.sha256
  {
    echo "date: $(date -u +%FT%TZ)"
    echo "git_commit: $GIT_COMMIT"
  } > manifest.txt
) || fail "manifest" "writing manifest.txt/checksums.sha256 failed"

log "encrypting backup bundle..."
ENCRYPTED_FILE="$STAGING_ROOT/drm-backup-$DATE.tar.gpg"
tar cf - -C "$STAGING_ROOT" "$DATE" \
  | gpg --batch --yes --pinentry-mode loopback --passphrase-file "$PASSPHRASE_FILE" \
        --symmetric --cipher-algo AES256 -o "$ENCRYPTED_FILE" \
  || fail "encrypt" "gpg encryption of backup bundle failed"

log "removing unencrypted staging directory..."
rm -rf "$STAGING_DIR"

log "uploading to NAS via rsync..."
rsync -avz -e "ssh -i $BACKUP_SSH_KEY_PATH -o StrictHostKeyChecking=yes" \
  "$ENCRYPTED_FILE" "$BACKUP_SSH_TARGET/" \
  || fail "rsync" "rsync to $BACKUP_SSH_TARGET failed"

log "pruning local backups older than $BACKUP_LOCAL_RETENTION_DAYS days..."
# `-mtime +N` keeps everything from today through N days ago inclusive
# (N+1 daily copies), not N -- subtracting 1 here makes the actual file
# count match the configured day-count exactly (e.g.
# BACKUP_LOCAL_RETENTION_DAYS=7 keeps 7 daily copies, not 8).
find "$STAGING_ROOT" -maxdepth 1 -name 'drm-backup-*.tar.gpg' -mtime "+$((BACKUP_LOCAL_RETENTION_DAYS - 1))" -delete

log "pruning remote backups older than $BACKUP_RETENTION_DAYS days..."
REMOTE_HOST="${BACKUP_SSH_TARGET%%:*}"
REMOTE_PATH="${BACKUP_SSH_TARGET#*:}"
# Non-fatal: the NAS's `find` might not support `-delete` (common on
# minimal/BusyBox NAS firmware) or the SSH hop might hiccup transiently.
# Backup integrity itself is unaffected by a failed prune (only NAS disk
# usage accumulates, a slower-moving problem) -- failing the whole run
# here would just be alert fatigue on the one channel meant to carry real
# signal. So: log + a distinct failure notification, but don't call
# fail()/don't make the script exit non-zero over this alone.
if ! ssh -i "$BACKUP_SSH_KEY_PATH" -o StrictHostKeyChecking=yes "$REMOTE_HOST" \
  "find '$REMOTE_PATH' -maxdepth 1 -name 'drm-backup-*.tar.gpg' -mtime +$((BACKUP_RETENTION_DAYS - 1)) -delete"; then
  log "WARNING: pruning old backups on NAS failed -- backup+upload itself succeeded, only retention cleanup failed; NAS disk usage may accumulate if this recurs"
  notify_failure "prune-remote (non-fatal)" "Pruning old backups on the NAS failed. This does NOT affect backup integrity -- today's backup was already uploaded successfully. Only NAS disk usage will accumulate if this recurs."$'\n\nLast log lines:\n'"$(tail -n 10 "$LOG_FILE" 2>/dev/null)" \
    || log "notify_failure itself failed"
fi

SIZE=$(du -h "$ENCRYPTED_FILE" | cut -f1)
log "backup succeeded ($SIZE)"
notify_success "$SIZE" || log "notify_success failed"
