#!/usr/bin/env bash
# Shared notification helpers for scripts/backup.sh. This file is meant to
# be `source`d, not executed directly.
#
# Two channels, matching the low-noise policy from
# docs/superpowers/specs/2026-08-03-backup-disaster-recovery-design.md:
#   - notify_failure: mail + Google Chat (loud, only on failure)
#   - notify_success: Google Chat only (quiet heartbeat, no mail)
# A notification failure must never fail the backup run itself -- every
# call site in backup.sh wraps these in `|| log ...`.

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  echo "backup-notify.sh is a library, source it instead of running it" >&2
  exit 1
fi

: "${BACKUP_NOTIFY_EMAIL_TO:?set BACKUP_NOTIFY_EMAIL_TO in .env}"
: "${BACKUP_NOTIFY_EMAIL_FROM:?set BACKUP_NOTIFY_EMAIL_FROM in .env}"
: "${BACKUP_SMTP_HOST:?set BACKUP_SMTP_HOST in .env}"
: "${BACKUP_SMTP_PORT:?set BACKUP_SMTP_PORT in .env}"
: "${BACKUP_SMTP_USER:?set BACKUP_SMTP_USER in .env}"

SMTP_PASSWORD_FILE="${SMTP_PASSWORD_FILE:-secrets/backup-notify/smtp-password}"
GCHAT_WEBHOOK_FILE="${GCHAT_WEBHOOK_FILE:-secrets/backup-notify/gchat-webhook-url}"

_send_mail() {
  local subject="$1" body="$2" smtp_password
  smtp_password=$(cat "$SMTP_PASSWORD_FILE")
  curl -s --ssl-reqd \
    --url "smtp://${BACKUP_SMTP_HOST}:${BACKUP_SMTP_PORT}" \
    --mail-from "$BACKUP_NOTIFY_EMAIL_FROM" \
    --mail-rcpt "$BACKUP_NOTIFY_EMAIL_TO" \
    --user "${BACKUP_SMTP_USER}:${smtp_password}" \
    --upload-file - <<EOF
From: $BACKUP_NOTIFY_EMAIL_FROM
To: $BACKUP_NOTIFY_EMAIL_TO
Subject: $subject

$body
EOF
}

_send_gchat() {
  local text="$1" webhook_url payload
  webhook_url=$(cat "$GCHAT_WEBHOOK_FILE")
  payload=$(jq -n --arg text "$text" '{text: $text}')
  curl -s -f -X POST -H 'Content-Type: application/json' -d "$payload" "$webhook_url" >/dev/null
}

notify_failure() {
  local step="$1" detail="$2" subject body
  subject="[DRM backup] FAILED at step: $step"
  body=$(printf 'DRM backup failed.\nStep: %s\nTime: %s\n\nDetail:\n%s' \
    "$step" "$(date -u +%FT%TZ)" "$detail")
  _send_mail "$subject" "$body" || echo "notify_failure: mail send failed" >&2
  _send_gchat "${subject}"$'\n'"${detail}" || echo "notify_failure: gchat send failed" >&2
}

notify_success() {
  local size="$1"
  _send_gchat "[DRM backup] OK $(date -u +%F) - ${size}" \
    || echo "notify_success: gchat send failed" >&2
}
