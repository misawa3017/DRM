# 備份與災難復原實作計畫

> **給代理型工作者的說明：** 必要子技能：使用 superpowers:subagent-driven-development（建議）或 superpowers:executing-plans 逐一任務地實作此計畫。步驟使用核取方塊（`- [ ]`）語法進行追蹤。

**目標：** 建立一套每日執行、將系統完整狀態（Postgres 中繼資料＋MinIO 加密物件＋OpenBao 解密金鑰材料＋Keycloak 使用者身份資料）備份到區網內 NAS 的機制，備份檔案本身維持加密，並在打包期間短暫停用 `api`/`worker`/`keycloak` 以確保各元件備份彼此一致。

**架構：** 兩支主機層 shell 腳本（`scripts/backup.sh`、`scripts/restore.sh`），透過 `docker compose exec`／`docker run -v <volume>` 存取既有的 Docker named volume，不修改 `docker-compose.yml`。備份期間先 `docker compose stop api worker keycloak` 再打包，打包完立刻重啟，讓 `pg_dump` 與各 volume 的 tar 內容（含 `keycloak_data`——Postgres 的擁有權／權限／稽核紀錄都指向 Keycloak 的 `sub` UUID，這是後續一次審查補上的必要範圍）來自同一個零寫入的時間點。備份檔整包用 `gpg --symmetric` 加密後 `rsync` 到 NAS。另外在 `apps/web` 加一個固定顯示的維護提示橫幅。

**技術棧：** Bash（`set -euo pipefail`）、Docker CLI、`gpg`（對稱加密，非互動 `--batch --pinentry-mode loopback` 模式）、`rsync` over SSH、`curl`（SMTP 寄信、Google Chat webhook）、`jq`（既有專案依賴，用來組 JSON payload）、systemd timer、React（維護橫幅）。

## Global Constraints

- **MinIO／OpenBao 的備份一律走 volume 層級複製，絕不透過 S3 API**（`mc mirror` 或任何呼叫 MinIO GetObject 的方式都會讓 KES 自動解密，備份出來變成明文）。用一次性 `alpine` 容器唯讀掛載對應 volume 後直接 `tar`。
- **加密工具選用 `gpg`，不用 `age`。** `age -p` 的密碼輸入設計為互動式（需要 `/dev/tty`），不適合 systemd timer／cron 這種無終端機的排程情境；`gpg --batch --pinentry-mode loopback --passphrase-file` 則是穩定支援的全自動化路徑，且 `gpg` 幾乎所有 Linux 主機都預裝，不需額外安裝。這是本計畫在 spec 留給實作階段決定的工具選擇上鎖定的答案。
- **Docker volume 一律透過 `com.docker.compose.volume=<short-name>` 標籤查找實際名稱**，不要硬編碼 `drm_` 這個 project 前綴（已用 `docker volume ls --format '{{.Name}} {{.Labels}}'` confirmed 這個標籤存在；前綴本身若專案改名會跟著變動，標籤不會）。
- **打包步驟（`pg_dump` ＋ 6 個 volume 的 tar，含後續補上的 `keycloak_data`）必須在 `docker compose stop api worker keycloak` 之後、`docker compose start api worker keycloak` 之前執行**，確保彼此來自同一個零寫入時間點。任何步驟失敗都必須先確保 `api`／`worker`／`keycloak` 被重新啟動（用 `trap ... EXIT` 實作，不能只放在腳本正常結尾），服務復原永遠優先於備份是否成功。（`keycloak_data` 是後續一次修正補上的——Postgres 裡的使用者相關紀錄都指向 Keycloak 的 `sub` UUID，沒備份這個 volume 會讓還原後的擁有權／權限／稽核紀錄全部對不起來，詳見設計文件。）
- **排程時間固定為每日 03:00**，刻意避開 Phase 4C 到期掃描的 02:00。
- **保留天數**：本機（加密後的備份檔）保留最近 **7 天**；NAS 端保留最近 **14 天**（`BACKUP_RETENTION_DAYS=14`／`BACKUP_LOCAL_RETENTION_DAYS=7`，兩者都是 `.env` 設定值，不寫死在腳本裡）。
- **通知規則**：任何步驟失敗 → 同時寄信 ＋ 發 Google Chat；成功 → 只發 Google Chat 一則簡短訊息，不寄信。通知本身失敗絕不能讓備份腳本的 exit code 跟著失敗。
- **這台主機偶爾會有非預期的高負載**（先前幾個 Phase 都遇過），`scripts/backup.sh` 必須用 `flock` 防止前一天的執行還沒結束就被下一次排程觸發。
- `secrets/` 目錄已經整個被 `.gitignore` 排除（Phase 2A 已設定），本計畫新增的 `secrets/backup-passphrase`、`secrets/backup-ssh/`、`secrets/backup-notify/` 都在這個目錄底下，**不需要再新增 `.gitignore` 規則**。
- **還原（`scripts/restore.sh`）全程由人工觸發並在旁監看**，需要輸入 `yes` 才會真正執行，不做自動 failover。
- 對照本專案既有慣例，所有驗證都要對照真實運行中的堆疊實際跑一次，不能只憑程式碼看起來合理就假設沒問題。

---

### 任務 1：備份密碼、SSH 金鑰與 `.env` 設定

**檔案：**
- Create: `secrets/backup-passphrase`（本機產生，不進 git，因為整個 `secrets/` 已被忽略）
- Create: `secrets/backup-ssh/id_ed25519` + `.pub`
- Modify: `.env.example`（新增備份相關設定的範例值）

**介面：**
- 使用：無新增項目。
- 產出：後續所有任務會讀取的 `secrets/backup-passphrase`、`secrets/backup-ssh/id_ed25519`，以及 `.env` 中的 `BACKUP_SSH_TARGET`／`BACKUP_SSH_KEY_PATH`／`BACKUP_RETENTION_DAYS`／`BACKUP_LOCAL_RETENTION_DAYS`／`BACKUP_SMTP_HOST`／`BACKUP_SMTP_PORT`／`BACKUP_SMTP_USER`／`BACKUP_NOTIFY_EMAIL_FROM`／`BACKUP_NOTIFY_EMAIL_TO`。

- [ ] **步驟 1：產生備份加密密碼**

```bash
mkdir -p secrets/backup-notify secrets/backup-ssh
openssl rand -base64 32 > secrets/backup-passphrase
chmod 600 secrets/backup-passphrase
```

執行後**立刻把 `secrets/backup-passphrase` 的內容另外抄一份，存放在主機與 NAS 之外的地方**（保險箱、密碼管理器）——這一步不能省略，密碼只存在主機上等於備份加密沒有意義。在報告中記錄「已完成異地保管」，不要把密碼內容寫進任何 commit 或報告。

- [ ] **步驟 2：產生備份專用的 SSH 金鑰**

```bash
ssh-keygen -t ed25519 -f secrets/backup-ssh/id_ed25519 -N "" -C "drm-backup"
chmod 600 secrets/backup-ssh/id_ed25519
```

- [ ] **步驟 3：把公鑰加到 NAS 的 `authorized_keys`**

```bash
cat secrets/backup-ssh/id_ed25519.pub
```

把輸出內容加進 NAS 上備份帳號的 `~/.ssh/authorized_keys`（此步驟在 NAS 上執行，依 NAS 的實際管理介面/方式而定，不在本 repo 範圍內）。

- [ ] **步驟 4：驗證 SSH 金鑰可以連線**

執行：`ssh -i secrets/backup-ssh/id_ed25519 -o StrictHostKeyChecking=accept-new <你的 NAS 帳號@主機> echo ok`
預期結果：印出 `ok`，且第一次連線會把 NAS 的 host key 寫入 `~/.ssh/known_hosts`（之後 `backup.sh` 用 `StrictHostKeyChecking=yes` 才不會卡住）。

- [ ] **步驟 5：在 `.env.example` 新增備份相關設定**

在 `.env.example` 檔案結尾附加：

```
# Phase: Backup & Disaster Recovery
BACKUP_SSH_TARGET=backupuser@nas.internal:/backups/drm
BACKUP_SSH_KEY_PATH=secrets/backup-ssh/id_ed25519
BACKUP_RETENTION_DAYS=14
BACKUP_LOCAL_RETENTION_DAYS=7
BACKUP_SMTP_HOST=smtp.example.com
BACKUP_SMTP_PORT=587
BACKUP_SMTP_USER=backup@example.com
BACKUP_NOTIFY_EMAIL_FROM=backup@example.com
BACKUP_NOTIFY_EMAIL_TO=ops@example.com
```

- [ ] **步驟 6：把同樣的設定加進實際使用的 `.env`（依你自己的 NAS/SMTP 資訊填入真實值）**

`BACKUP_SSH_TARGET` 改成步驟 3 實際設定的帳號與路徑；`BACKUP_SMTP_*`／`BACKUP_NOTIFY_EMAIL_*` 改成你要用的 SMTP relay 與收信地址。

- [ ] **步驟 7：產生 Google Chat webhook 與 SMTP 密碼的機密檔案**

```bash
echo -n "<你的 SMTP 密碼>" > secrets/backup-notify/smtp-password
echo -n "<你的 Google Chat incoming webhook URL>" > secrets/backup-notify/gchat-webhook-url
chmod 600 secrets/backup-notify/smtp-password secrets/backup-notify/gchat-webhook-url
```

（Google Chat webhook 的取得方式：在目標聊天室的「管理 webhook」設定裡新增一個 incoming webhook，複製它給的網址。SMTP 帳密則依你實際要用的寄信服務而定。）

- [ ] **步驟 8：確認 `secrets/` 底下新檔案都不會被 git 追蹤**

執行：`git status --porcelain secrets/`
預期結果：沒有任何輸出（`secrets/` 整個被 `.gitignore` 排除，Phase 2A 已設定）。

- [ ] **步驟 9：讓 root 也能對這個 repo 執行 `git` 指令**

`scripts/backup.sh` 會呼叫 `git rev-parse HEAD` 來把當下的 commit hash 寫進 manifest，而正式環境（任務 7 的 systemd service）與後面手動測試時的 `sudo ./scripts/backup.sh` 都是以 root 身分執行。Git 有安全機制：當執行者的 uid 與 repo 目錄擁有者不同時，`git` 指令會直接失敗並印出 `detected dubious ownership in repository`，必須先讓 root 把這個 repo 路徑加進白名單：

```bash
sudo git config --global --add safe.directory "$(pwd)"
```

- [ ] **步驟 10：Commit**

```bash
git add .env.example
git commit -m "chore(backup): add .env.example settings for backup & DR"
```

（`secrets/` 底下的檔案本來就不會被加進 git，這裡只 commit `.env.example`。）

---

### 任務 2：通知函式庫 `scripts/lib/backup-notify.sh`

**檔案：**
- Create: `scripts/lib/backup-notify.sh`

**介面：**
- 使用：`secrets/backup-notify/smtp-password`、`secrets/backup-notify/gchat-webhook-url`（任務 1 產生）；環境變數 `BACKUP_SMTP_HOST`／`BACKUP_SMTP_PORT`／`BACKUP_SMTP_USER`／`BACKUP_NOTIFY_EMAIL_FROM`／`BACKUP_NOTIFY_EMAIL_TO`（任務 1 加進 `.env`）。
- 產出：`notify_failure(step, detail)`、`notify_success(size)` 兩個 shell 函式，供任務 3/4 的 `scripts/backup.sh` source 使用。

- [ ] **步驟 1：建立 `scripts/lib/backup-notify.sh`**

```bash
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
  curl -s -X POST -H 'Content-Type: application/json' -d "$payload" "$webhook_url" >/dev/null
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
```

- [ ] **步驟 2：啟動本機的 mock SMTP／webhook 接收端來手動驗證（不依賴真實外部帳號）**

```bash
docker run -d --rm --name backup-test-mailpit -p 1025:1025 -p 8025:8025 axllent/mailpit
docker run -d --rm --name backup-test-echo -p 8080:8080 mendhak/http-https-echo:31 -e HTTP_PORT=8080
```

- [ ] **步驟 3：手動驗證 `notify_failure`／`notify_success` 真的把訊息送出去**

```bash
mkdir -p secrets/backup-notify
echo -n "" > secrets/backup-notify/smtp-password
echo -n "http://localhost:8080/webhook" > secrets/backup-notify/gchat-webhook-url

export BACKUP_SMTP_HOST=localhost BACKUP_SMTP_PORT=1025 BACKUP_SMTP_USER=test \
  BACKUP_NOTIFY_EMAIL_FROM=backup@drm.localhost BACKUP_NOTIFY_EMAIL_TO=ops@drm.localhost

bash -c 'source scripts/lib/backup-notify.sh; notify_failure "test-step" "test detail"'
bash -c 'source scripts/lib/backup-notify.sh; notify_success "12MB"'
```

預期結果：
- 開啟 `http://localhost:8025` 應該看到一封主旨為 `[DRM backup] FAILED at step: test-step` 的信（`notify_success` 不寄信，所以只有一封）。
- 執行 `docker logs backup-test-echo` 應該看到兩個 POST request（一個來自 `notify_failure`、一個來自 `notify_success`），body 是合法 JSON 且 `text` 欄位內容正確。

**注意**：`--ssl-reqd` 假設 SMTP relay 走 STARTTLS（一般常見的 587 埠設定）；如果你實際要用的 SMTP relay 用的是隱式 TLS（465 埠）或完全不加密的本機 relay，這一步驗證時就會看到 curl 連線錯誤——依實際 SMTP 服務調整 `_send_mail` 裡的 `--ssl-reqd`／`smtp://` vs `smtps://`，這是 mailpit 測試環境跟你實際 relay 設定可能不同的地方，實作時要留意。

- [ ] **步驟 4：清理測試容器與測試機密檔**

```bash
docker rm -f backup-test-mailpit backup-test-echo
rm -f secrets/backup-notify/smtp-password secrets/backup-notify/gchat-webhook-url
```

（把任務 1 步驟 7 產生的真實機密檔案重新放回去，不要留著測試用的空值。）

- [ ] **步驟 5：Commit**

```bash
git add scripts/lib/backup-notify.sh
git commit -m "feat(backup): add mail + Google Chat notification library"
```

---

### 任務 3：`scripts/backup.sh` —— 停機視窗、備份打包、manifest

**檔案：**
- Create: `scripts/backup.sh`

**介面：**
- 使用：`scripts/lib/backup-notify.sh` 的 `notify_failure`（任務 2）；`.env` 中的 `POSTGRES_USER`／`POSTGRES_DB`（既有）。
- 產出：`/var/backups/drm-staging/<YYYY-MM-DD>/` 底下的 `postgres.dump`、`minio_data.tar.gz`、`openbao_data.tar.gz`、`openbao_init.tar.gz`、`openbao_approle.tar.gz`、`keycloak_data.tar.gz`（後續一次審查補上，範圍之外的說明見上方 Global Constraints）、`kes-secrets.tar.gz`、`manifest.txt`、`checksums.sha256`。此任務先不做加密／上傳／通知，下個任務接續。（`minio_data`／`openbao_*`（`openbao_data`、`openbao_init`、`openbao_approle`）這四個檔案後續改為 `.tar`，不含 gzip，見實際 `scripts/backup.sh`。）

- [ ] **步驟 1：建立 `scripts/backup.sh`（第一版，到打包+manifest 為止）**

```bash
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
# (Note: a later fix wave added `keycloak` to the stop/restart set and a
# keycloak_data tar_volume call in the same pattern as the four below, plus
# an explicit `-t 30` stop timeout -- see the real scripts/backup.sh, the
# source of truth, for the current version.)
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
source .env
source scripts/lib/backup-notify.sh

: "${BACKUP_SSH_TARGET:?set BACKUP_SSH_TARGET in .env}"
: "${BACKUP_SSH_KEY_PATH:?set BACKUP_SSH_KEY_PATH in .env}"
: "${BACKUP_RETENTION_DAYS:?set BACKUP_RETENTION_DAYS in .env}"
: "${BACKUP_LOCAL_RETENTION_DAYS:?set BACKUP_LOCAL_RETENTION_DAYS in .env}"

LOCK_FILE=/var/lock/drm-backup.lock
STAGING_ROOT=/var/backups/drm-staging
LOG_FILE=/var/log/drm-backup.log
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
```

- [ ] **步驟 2：賦予執行權限**

```bash
chmod +x scripts/backup.sh
```

- [ ] **步驟 3：手動跑一次，驗證停機視窗與打包內容**

前置：確保 dev stack 正在跑（`docker compose up -d`），且 `.env` 已依任務 1 填好。

```bash
sudo mkdir -p /var/backups/drm-staging /var/lock
sudo touch /var/log/drm-backup.log

# Run with sudo here (not chowned to the current user) because the systemd
# service in Task 7 runs backup.sh as root by default (no `User=` set) --
# testing under the same privilege level it will actually run under avoids
# a false pass now followed by a permissions surprise once the timer is
# installed.
sudo ./scripts/backup.sh
```

預期結果：
- log 顯示 `stopping api/worker`，接著 `restarting api/worker`，中間沒有其他錯誤。
- 執行期間用另一個終端機跑 `docker compose ps api worker`，應該能看到兩者短暫變成 `Exited`／消失，之後又回到 `Up`。
- `ls /var/backups/drm-staging/$(date -u +%F)/` 應該看到 `postgres.dump`、`minio_data.tar.gz`、`openbao_data.tar.gz`、`openbao_init.tar.gz`、`openbao_approle.tar.gz`、`keycloak_data.tar.gz`（後續修正補上）、`kes-secrets.tar.gz`、`manifest.txt`、`checksums.sha256` 共 9 個檔案。（`minio_data`／`openbao_*`（`openbao_data`、`openbao_init`、`openbao_approle`）這四個檔案後續改為 `.tar`，不含 gzip，見實際 `scripts/backup.sh`。）
- `cat /var/backups/drm-staging/$(date -u +%F)/manifest.txt` 內容包含正確的日期與目前的 git commit hash。
- `(cd /var/backups/drm-staging/$(date -u +%F) && sha256sum -c checksums.sha256)` 全部顯示 `OK`。

- [ ] **步驟 4：驗證停機期間確實零寫入（資料一致性）**

```bash
curl -X POST http://api.drm.localhost/folders \
  -H "Authorization: Bearer <一個有效的 testuser token>" \
  -H "Content-Type: application/json" \
  -d '{"name":"backup-consistency-check"}'
```

在 `./scripts/backup.sh` 執行「期間」（趁停機視窗那幾秒）嘗試呼叫上面這個請求，預期結果是連線被拒絕／逾時（因為 `api` 容器已停止），而不是成功建立資料夾——這證明停機視窗確實阻擋了寫入，不是只做半套。

- [ ] **步驟 5：清理測試產生的暫存目錄**

```bash
sudo rm -rf "/var/backups/drm-staging/$(date -u +%F)"
```

（下個任務會重新產生完整的備份流程，這裡先清掉避免跟後面的端到端測試搞混。）

- [ ] **步驟 6：Commit**

```bash
git add scripts/backup.sh
git commit -m "feat(backup): add backup.sh with maintenance window, dump, and volume tars"
```

---

### 任務 4：`scripts/backup.sh` —— 加密、上傳、保留、通知

**檔案：**
- Modify: `scripts/backup.sh`（延續任務 3 的檔案，接續加上剩下的步驟）

**介面：**
- 使用：任務 3 產出的 `$STAGING_DIR` 內容；`scripts/lib/backup-notify.sh` 的 `notify_success`（任務 2）。
- 產出：NAS 上的 `drm-backup-<YYYY-MM-DD>.tar.gpg`；本機／NAS 兩端的份數保留；成功／失敗通知。

- [ ] **步驟 1：在 `manifest`／`checksums.sha256` 寫完之後，接著加上加密、上傳、保留、通知**

在 `scripts/backup.sh` 的 `log "backup packaging complete..."` 這一行**之後**（取代掉它），接續加入：

```bash
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
find "$STAGING_ROOT" -maxdepth 1 -name 'drm-backup-*.tar.gpg' -mtime "+${BACKUP_LOCAL_RETENTION_DAYS}" -delete

log "pruning remote backups older than $BACKUP_RETENTION_DAYS days..."
REMOTE_HOST="${BACKUP_SSH_TARGET%%:*}"
REMOTE_PATH="${BACKUP_SSH_TARGET#*:}"
ssh -i "$BACKUP_SSH_KEY_PATH" -o StrictHostKeyChecking=yes "$REMOTE_HOST" \
  "find '$REMOTE_PATH' -maxdepth 1 -name 'drm-backup-*.tar.gpg' -mtime +${BACKUP_RETENTION_DAYS} -delete" \
  || fail "prune-remote" "pruning old backups on NAS failed"

SIZE=$(du -h "$ENCRYPTED_FILE" | cut -f1)
log "backup succeeded ($SIZE)"
notify_success "$SIZE" || log "notify_success failed"
```

- [ ] **步驟 2：端到端手動執行，驗證完整流程**

```bash
sudo ./scripts/backup.sh
```

預期結果：
- log 依序顯示 encrypting → removing staging → uploading → pruning local → pruning remote → backup succeeded。
- `ls /var/backups/drm-staging/` 只剩加密後的 `drm-backup-<日期>.tar.gpg`，沒有明文的 `<日期>/` 目錄。
- 在 NAS 上 `ls <BACKUP_SSH_TARGET 的路徑>` 能看到同一個 `drm-backup-<日期>.tar.gpg` 檔案。
- Google Chat 頻道收到一則 `[DRM backup] OK <日期> - <大小>` 的訊息，且**沒有**收到任何信件（成功情境不寄信）。

- [ ] **步驟 3：驗證解密可行（先不還原，只確認加密沒壞掉）**

```bash
gpg --batch --yes --pinentry-mode loopback --passphrase-file secrets/backup-passphrase \
  --decrypt "$(ls -t /var/backups/drm-staging/drm-backup-*.tar.gpg | head -1)" | tar tzf - | head
```

預期結果：列出 `<日期>/postgres.dump`、`<日期>/minio_data.tar.gz` 等檔案清單，沒有 gpg 或 tar 錯誤。（`minio_data`／`openbao_*`（`openbao_data`、`openbao_init`、`openbao_approle`）這四個檔案後續改為 `.tar`，見實際 `scripts/backup.sh`。）

- [ ] **步驟 4：刻意模擬 rsync 失敗，驗證失敗通知與本機保留行為**

```bash
# 直接改 .env 檔案本身，不能用行內環境變數覆蓋 -- backup.sh 一開始就
# `source .env`，任何行內傳入的同名環境變數都會被 .env 裡的值蓋掉。
cp .env .env.backup
sed -i 's|^BACKUP_SSH_TARGET=.*|BACKUP_SSH_TARGET=nobody@10.255.255.1:/nonexistent|' .env
sudo ./scripts/backup.sh; echo "exit code: $?"
mv .env.backup .env
```

預期結果：
- 腳本在 rsync 步驟失敗，exit code 非 0。
- log 顯示 `FAIL at rsync`。
- Google Chat 與信箱都收到失敗通知，內容包含 `rsync` 字樣。
- `/var/backups/drm-staging/` 底下**仍保留**這次失敗前產生的加密備份檔（沒有被誤刪）。
- `api`／`worker` 服務仍是 `Up`（trap 有確實把停機視窗結束）。

- [ ] **步驟 5：刻意讓打包步驟中途失敗，驗證服務一定會被復原**

```bash
# 暫時 rename 掉 secrets/kes，讓 kes-secrets.tar.gz 那步失敗
mv secrets/kes secrets/kes.bak
sudo ./scripts/backup.sh; echo "exit code: $?"
mv secrets/kes.bak secrets/kes
```

預期結果：腳本在 `tar-kes-secrets` 步驟失敗並中止，但 `docker compose ps api worker` 顯示兩者都是 `Up`（trap 觸發的 `restore_stack` 生效，沒有卡在停機狀態）。

- [ ] **步驟 6：清理測試殘留**

```bash
sudo rm -f /var/backups/drm-staging/drm-backup-*.tar.gpg
ssh -i secrets/backup-ssh/id_ed25519 "${BACKUP_SSH_TARGET%%:*}" "rm -f ${BACKUP_SSH_TARGET#*:}/drm-backup-*.tar.gpg"
```

（後面任務會需要一份乾淨的真實備份用來做還原演練，先清掉這幾次測試/失敗模擬留下的檔案。）

- [ ] **步驟 7：Commit**

```bash
git add scripts/backup.sh
git commit -m "feat(backup): add encryption, rsync upload, retention pruning, and notifications"
```

---

### 任務 5：`scripts/restore.sh` —— 還原流程與完整演練

**檔案：**
- Create: `scripts/restore.sh`

**介面：**
- 使用：任務 4 產出的 `drm-backup-<日期>.tar.gpg`；`secrets/backup-passphrase`（任務 1）。
- 產出：完整還原後、可實際登入使用的 DRM stack。

- [ ] **步驟 1：建立 `scripts/restore.sh`**

```bash
#!/usr/bin/env bash
# Restores the full DRM stack (Postgres + MinIO + OpenBao key material) from
# a backup produced by scripts/backup.sh. See
# docs/superpowers/specs/2026-08-03-backup-disaster-recovery-design.md.
#
# DESTRUCTIVE: overwrites the current minio_data/openbao_data/openbao_init/
# openbao_approle volumes and the current Postgres database. Only run this
# against a host you actually intend to restore onto.
# (Note: a later fix wave added a keycloak_data restore_volume call in the
# same pattern as the four below -- see the real scripts/restore.sh, the
# source of truth, for the current version.)
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

read -r -p "This will STOP the stack and OVERWRITE minio_data/openbao_data/openbao_init/openbao_approle and the Postgres database. Type 'yes' to continue: " CONFIRM
[ "$CONFIRM" = "yes" ] || { echo "Aborted."; exit 1; }

echo "Stopping the stack..."
docker compose down

restore_volume() {
  local short_name="$1" tar_file="$2" full_name
  full_name=$(docker volume ls --filter "label=com.docker.compose.volume=${short_name}" --format '{{.Name}}' | head -1)
  if [ -z "$full_name" ]; then
    echo "FAIL: could not find volume for ${short_name} -- run 'docker compose up -d && docker compose down' once on a fresh host first so compose creates the named volumes" >&2
    exit 1
  fi
  echo "Restoring ${short_name} into volume ${full_name}..."
  docker run --rm -v "${full_name}:/target" -v "${BACKUP_DIR}:/backup:ro" alpine \
    sh -c "rm -rf /target/* /target/..?* /target/.[!.]* 2>/dev/null; tar xzf /backup/${tar_file} -C /target"
}

restore_volume minio_data minio_data.tar.gz
restore_volume openbao_data openbao_data.tar.gz
restore_volume openbao_init openbao_init.tar.gz
restore_volume openbao_approle openbao_approle.tar.gz

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
for i in $(seq 1 60); do
  if curl -sf http://api.drm.localhost/health >/dev/null 2>&1; then
    break
  fi
  if [ "$i" = 60 ]; then
    echo "FAIL: api did not respond healthy within 120s of restart" >&2
    exit 1
  fi
  sleep 2
done

echo "Restore complete. Now manually verify: log in, browse a folder, download a document, confirm audit logs and permissions are intact."
```

- [ ] **步驟 2：賦予執行權限**

```bash
chmod +x scripts/restore.sh
```

- [ ] **步驟 3：產生一份用來演練的真實備份，並先上傳一份可辨識的測試文件**

```bash
# 先透過真實的 web/app 流程（或直接呼叫 API）上傳一份文件，記下它的內容與所在資料夾，
# 例如 "restore-drill-marker.txt"，內容為一段獨特字串，之後用來驗證還原是否成功。
sudo ./scripts/backup.sh
```

- [ ] **步驟 4：在一個乾淨的 scratch 環境執行完整還原演練**

前置：準備一台（或同主機上另一個獨立的）scratch 環境，具備 Docker，且已 clone 這個 repo、`.env` 設定完成（`POSTGRES_USER`／`POSTGRES_DB` 等與正式環境一致，`secrets/backup-passphrase` 為步驟 1 產生的同一份密碼）。

```bash
docker compose up -d
docker compose down
# 把任務 4 上傳到 NAS 的加密備份檔下載到這個 scratch 環境
scp -i secrets/backup-ssh/id_ed25519 "${BACKUP_SSH_TARGET}/drm-backup-$(date -u +%F).tar.gpg" ./restore-drill.tar.gpg
./scripts/restore.sh ./restore-drill.tar.gpg
```

- [ ] **步驟 5：完整還原後的手動驗證**

還原完成後：
1. 用瀏覽器開啟這個 scratch 環境的 `http://app.drm.localhost`，登入。
2. 找到步驟 3 上傳的 `restore-drill-marker.txt`，下載它，確認內容與原始檔案逐位元組相同（例如用 `diff` 或雜湊比對）。
3. 確認該文件所在資料夾的權限設定（`GET /folders/:id/permissions`）與備份前一致。
4. 確認該文件的稽核紀錄（`GET /documents/:id/audit-logs`）包含它的上傳事件。

預期結果：以上四項全部符合——這是唯一能證明備份「真的救得回來」的方式，不能只看 `restore.sh` 印出 `Restore complete` 就結案。

- [ ] **步驟 6：清理 scratch 環境**

```bash
docker compose down -v
rm -f ./restore-drill.tar.gpg
```

- [ ] **步驟 7：Commit**

```bash
git add scripts/restore.sh
git commit -m "feat(backup): add restore.sh for full disaster-recovery restoration"
```

---

### 任務 6：`apps/web` 維護提示橫幅

**檔案：**
- Create: `apps/web/src/MaintenanceNotice.tsx`
- Modify: `apps/web/src/App.tsx`
- Test: `apps/web/test/MaintenanceNotice.test.tsx`

**介面：**
- 使用：無新增項目（純靜態元件，不呼叫任何 API）。
- 產出：`MaintenanceNotice` 元件，由 `App.tsx` 在所有畫面狀態下渲染。

- [ ] **步驟 1：寫失敗的測試**

建立 `apps/web/test/MaintenanceNotice.test.tsx`：

```tsx
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { MaintenanceNotice } from '../src/MaintenanceNotice';

describe('MaintenanceNotice', () => {
  it('renders the fixed daily maintenance window message', () => {
    render(<MaintenanceNotice />);
    expect(screen.getByText(/03:00/)).toBeInTheDocument();
    expect(screen.getByText(/例行維護/)).toBeInTheDocument();
  });
});
```

- [ ] **步驟 2：執行測試，確認失敗**

執行：`cd apps/web && pnpm test -- MaintenanceNotice`
預期結果：FAIL，因為 `../src/MaintenanceNotice` 還不存在。

- [ ] **步驟 3：建立 `apps/web/src/MaintenanceNotice.tsx`**

```tsx
export function MaintenanceNotice() {
  return (
    <div
      style={{
        background: '#fff3cd',
        color: '#664d03',
        padding: '0.5rem 1rem',
        textAlign: 'center',
        fontSize: '0.9rem',
      }}
    >
      系統每日 03:00 進行例行維護，期間約數分鐘無法使用。
    </div>
  );
}
```

- [ ] **步驟 4：執行測試，確認通過**

執行：`cd apps/web && pnpm test -- MaintenanceNotice`
預期結果：PASS。

- [ ] **步驟 5：把 `MaintenanceNotice` 接進 `App.tsx`，確保所有畫面狀態下都會顯示**

修改 `apps/web/src/App.tsx` 為：

```tsx
import { useAuth } from 'react-oidc-context';
import { Home } from './Home';
import { MaintenanceNotice } from './MaintenanceNotice';

export default function App() {
  const auth = useAuth();

  if (auth.isLoading) {
    return (
      <>
        <MaintenanceNotice />
        <p>Loading...</p>
      </>
    );
  }
  if (auth.error) {
    return (
      <>
        <MaintenanceNotice />
        <p>Auth error: {auth.error.message}</p>
      </>
    );
  }

  if (!auth.isAuthenticated) {
    return (
      <>
        <MaintenanceNotice />
        <button onClick={() => auth.signinRedirect()}>Log in</button>
      </>
    );
  }

  return (
    <>
      <MaintenanceNotice />
      <div>
        <button onClick={() => auth.signoutRedirect()}>Log out</button>
        <Home accessToken={auth.user?.access_token ?? ''} />
      </div>
    </>
  );
}
```

- [ ] **步驟 6：跑完整的 web 測試套件與 build，確認沒有破壞既有測試**

執行：`cd apps/web && pnpm test && pnpm run build`
預期結果：全部通過，沒有 TypeScript 或測試錯誤。

- [ ] **步驟 7：在瀏覽器中肉眼確認橫幅顯示**

開啟 `http://app.drm.localhost`（無論是否登入），預期結果：頁面最上方顯示「系統每日 03:00 進行例行維護，期間約數分鐘無法使用。」的黃底提示。

- [ ] **步驟 8：Commit**

```bash
git add apps/web/src/MaintenanceNotice.tsx apps/web/src/App.tsx apps/web/test/MaintenanceNotice.test.tsx
git commit -m "feat(web): add static daily maintenance window banner"
```

---

### 任務 7：systemd 排程單元檔與安裝說明

**檔案：**
- Create: `scripts/systemd/drm-backup.service`
- Create: `scripts/systemd/drm-backup.timer`
- Create: `scripts/systemd/README.md`

**介面：**
- 使用：任務 3/4 完成的 `scripts/backup.sh`。
- 產出：每日 03:00 自動觸發 `scripts/backup.sh` 的 systemd timer。

- [ ] **步驟 1：建立 `scripts/systemd/drm-backup.service`**

```ini
[Unit]
Description=DRM daily encrypted backup
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
WorkingDirectory=/opt/drm
ExecStart=/opt/drm/scripts/backup.sh
```

- [ ] **步驟 2：建立 `scripts/systemd/drm-backup.timer`**

```ini
[Unit]
Description=Run drm-backup.service daily at 03:00

[Timer]
OnCalendar=*-*-* 03:00:00
Persistent=true

[Install]
WantedBy=timers.target
```

- [ ] **步驟 3：建立 `scripts/systemd/README.md` 記錄安裝步驟**

```markdown
# 安裝每日備份排程

1. 把 `drm-backup.service`／`drm-backup.timer` 裡的 `WorkingDirectory=/opt/drm`
   改成這台主機上實際 clone 這個 repo 的路徑。
2. 複製到 systemd 目錄並啟用：

   ```bash
   sudo cp scripts/systemd/drm-backup.service scripts/systemd/drm-backup.timer /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now drm-backup.timer
   ```

3. 確認排程已生效：

   ```bash
   systemctl list-timers drm-backup.timer
   ```

   應該看到下一次觸發時間是今天或明天的 03:00。

4. 查看執行紀錄：

   ```bash
   journalctl -u drm-backup.service -f
   ```
```

- [ ] **步驟 4：依 README 實際安裝到主機上，驗證 timer 已排程**

執行：`systemctl list-timers drm-backup.timer`
預期結果：`NEXT` 欄位顯示今天或明天的 03:00，`LAST` 欄位（若已跑過一次）顯示上次執行時間。

- [ ] **步驟 5：手動觸發一次 service（不等到 03:00），確認能透過 systemd 正常執行**

執行：`sudo systemctl start drm-backup.service && journalctl -u drm-backup.service -n 50`
預期結果：log 顯示完整的備份流程輸出，最後是 `backup succeeded`，且 `systemctl status drm-backup.service` 顯示 `Type=oneshot` 執行完成、無錯誤。

- [ ] **步驟 6：Commit**

```bash
git add scripts/systemd/
git commit -m "chore(backup): add systemd timer for daily 03:00 backups"
```

---

### 任務 8：對照 spec 的端對端驗證清單收尾

**檔案：**
- 無新增檔案；本任務是對照 `docs/superpowers/specs/2026-08-03-backup-disaster-recovery-design.md` 的「測試／驗證」段落，把之前任務裡已經個別做過的驗證串起來確認一次，並補上尚未覆蓋的項目（retention 清除邏輯的精確驗證）。

**介面：**
- 使用：任務 1-7 的全部產出。
- 產出：一份可以放進報告的驗證結果清單。

- [ ] **步驟 1：驗證 retention 清除邏輯（本機）**

```bash
# sudo 是必要的 -- /var/backups/drm-staging 是任務 3 用 sudo mkdir 建立的，
# 屬於 root。
sudo touch -d "8 days ago" /var/backups/drm-staging/drm-backup-fake-old.tar.gpg
sudo touch -d "3 days ago" /var/backups/drm-staging/drm-backup-fake-recent.tar.gpg
sudo find /var/backups/drm-staging -maxdepth 1 -name 'drm-backup-*.tar.gpg' -mtime "+7" -delete
sudo ls /var/backups/drm-staging/
```

預期結果：`drm-backup-fake-old.tar.gpg` 被刪除，`drm-backup-fake-recent.tar.gpg` 還在——證明 `BACKUP_LOCAL_RETENTION_DAYS=7` 的清除條件只刪超過 7 天的，沒有誤刪。

- [ ] **步驟 2：驗證 retention 清除邏輯（NAS 端）**

```bash
ssh -i secrets/backup-ssh/id_ed25519 "${BACKUP_SSH_TARGET%%:*}" \
  "touch -d '15 days ago' ${BACKUP_SSH_TARGET#*:}/drm-backup-fake-old.tar.gpg; touch -d '5 days ago' ${BACKUP_SSH_TARGET#*:}/drm-backup-fake-recent.tar.gpg"
ssh -i secrets/backup-ssh/id_ed25519 "${BACKUP_SSH_TARGET%%:*}" \
  "find ${BACKUP_SSH_TARGET#*:} -maxdepth 1 -name 'drm-backup-*.tar.gpg' -mtime +14 -delete"
ssh -i secrets/backup-ssh/id_ed25519 "${BACKUP_SSH_TARGET%%:*}" "ls ${BACKUP_SSH_TARGET#*:}"
```

預期結果：`drm-backup-fake-old.tar.gpg` 被刪除，`drm-backup-fake-recent.tar.gpg` 還在——證明 `BACKUP_RETENTION_DAYS=14` 在 NAS 端也正確運作。

- [ ] **步驟 3：清理步驟 1/2 產生的測試殘留檔**

```bash
sudo rm -f /var/backups/drm-staging/drm-backup-fake-*.tar.gpg
ssh -i secrets/backup-ssh/id_ed25519 "${BACKUP_SSH_TARGET%%:*}" "rm -f ${BACKUP_SSH_TARGET#*:}/drm-backup-fake-*.tar.gpg"
```

- [ ] **步驟 4：核對 spec 的「測試／驗證」清單，逐項確認已完成**

對照 `docs/superpowers/specs/2026-08-03-backup-disaster-recovery-design.md` 的「測試／驗證」段落，確認：
- 加密檔案能正確解開、checksum 相符 —— 任務 3 步驟 3、任務 4 步驟 3。
- 完整還原演練（登入、下載、稽核紀錄、權限） —— 任務 5 步驟 5。
- rsync 失敗情境（不產生假成功、保留本機備份、收到通知） —— 任務 4 步驟 4。
- 成功情境只收到 Google Chat、沒有寄信 —— 任務 4 步驟 2。
- retention 清除邏輯（本機／NAS） —— 本任務步驟 1、2。
- 停機視窗一致性、失敗時服務復原 —— 任務 3 步驟 4、任務 4 步驟 5。
- 維護提示橫幅正確顯示 —— 任務 6 步驟 7。

- [ ] **步驟 5：執行完整既有的 lint/build/unit/e2e 套件，確認整個變更沒有破壞既有系統**

```bash
pnpm --filter api run lint && pnpm --filter api run build && pnpm --filter api test && pnpm --filter api run test:e2e
pnpm --filter web run lint && pnpm --filter web run build && pnpm --filter web test
```

預期結果：全部通過。

- [ ] **步驟 6：在報告中總結本次驗證結果**

列出步驟 4 對照表的七個項目、實際執行結果，以及任何在驗證過程中發現、已在對應任務修正的問題（例如某個環境相依的假設不成立時做了什麼調整）。

## Self-Review Notes

- **spec 涵蓋度**：背景/目的/架構/備份範圍與元件/每日備份流程/使用者停機通知/通知/錯誤處理/還原流程/測試驗證/範圍之外，每一段都對應到任務 1-8 的具體步驟，沒有遺漏。
- **工具選擇偏離 spec 的地方**：spec 把加密工具留給實作時決定（`age` 優先、`gpg` 退回）；本計畫在 Global Constraints 明確記錄了改用 `gpg` 的理由（`age -p` 的密碼輸入需要互動式終端機，不適合無人值守的 systemd timer），這是撰寫計畫時做的具體決定，不是遺漏。
- **型別／介面一致性**：`resolve_volume`／`tar_volume`（任務 3）在 `restore.sh`（任務 5）裡沒有重複使用同一份函式定義，而是各自在自己的腳本內重新定義了對應邏輯（`restore_volume`）——這是刻意的，因為兩支腳本沒有共用的 shell 函式庫，各自獨立可讀比硬拉一個共用 lib 出來對這麼小的重複量更划算；`checksums.sha256`／`manifest.txt` 的檔名與格式在任務 3（寫入）與任務 5（讀取驗證）之間一致。
- **佔位符掃描**：所有步驟都是可直接執行的具體指令或完整程式碼，沒有「TBD」「之後補上」等字樣；`WorkingDirectory=/opt/drm`、`BACKUP_SSH_TARGET=backupuser@nas.internal:/backups/drm` 等是需要依實際主機/NAS 調整的範例值，已在對應步驟明確標註「依你的實際情況調整」，不是遺漏的待辦。
