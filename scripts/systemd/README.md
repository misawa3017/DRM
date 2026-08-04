# 安裝每日備份排程

1. 把 `drm-backup.service`／`drm-backup.timer` 裡所有出現的 `/opt/drm`
   （包含 `WorkingDirectory=` **以及** `ExecStart=`／`ExecStopPost=`）都改成
   這台主機上實際 clone 這個 repo 的路徑。只改 `WorkingDirectory=` 而漏改
   `ExecStart=` 會導致 service 找不到 `backup.sh` 而啟動失敗。
2. 建立 `backup.sh` 執行期間需要的主機層目錄／檔案（service 預設以 root
   身分執行，所以這些路徑要讓 root 可寫）：

   ```bash
   sudo mkdir -p /var/backups/drm-staging
   sudo touch /var/log/drm-backup.log
   sudo mkdir -p /var/lock
   ```

3. 設定 git 的 `safe.directory`：`backup.sh` 會呼叫 `git rev-parse HEAD`
   寫進 manifest，但 root 對一個屬於其他使用者的 repo 執行 git 指令，預設
   會被 git 的 "dubious ownership" 保護擋下來。用 root 身分執行一次：

   ```bash
   sudo git config --global --add safe.directory <這台主機上 repo 的實際路徑>
   ```

4. 讓 root 的 `known_hosts` 先信任 NAS 的 SSH host key：`backup.sh` 用的是
   `StrictHostKeyChecking=yes`（刻意不用 `accept-new`，避免正常運作中被
   MITM 換掉 host key也不會發現），所以**第一次**用 root 身分（不是部署
   當下操作用的一般管理者帳號）自動執行前，要先手動信任一次，否則第一次
   排程自動執行就會失敗：

   ```bash
   sudo ssh -i <BACKUP_SSH_KEY_PATH 指向的金鑰> -o StrictHostKeyChecking=accept-new <NAS host> true
   ```

5. **`secrets/backup-passphrase` 必須手動額外複製一份到主機與 NAS 之外的
   地方**（保險箱、密碼管理器）——這是整個備份機制裡最關鍵的手動步驟：
   密碼一旦跟主機一起遺失，加密備份就永遠打不開。同時，`.env`（不只是
   `secrets/`）也要一併納入這份離站副本的範圍，因為 `.env` 裡的
   `BACKUP_SSH_TARGET` 等設定值，是真正發生災難時要先知道去哪裡找備份檔
   的必要資訊。
6. 複製到 systemd 目錄並啟用：

   ```bash
   sudo cp scripts/systemd/drm-backup.service scripts/systemd/drm-backup.timer /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now drm-backup.timer
   ```

7. 確認排程已生效：

   ```bash
   systemctl list-timers drm-backup.timer
   ```

   應該看到下一次觸發時間是今天或明天的 03:00。

8. 查看執行紀錄：

   ```bash
   journalctl -u drm-backup.service -f
   ```

   注意：`journalctl` 在某些情況下可能無法完整擷取 `backup.sh` 透過
   `tee` 輸出的每一行 log（bursty subprocess 輸出下的已知擷取問題，並非
   實際執行有缺漏）。若 `journalctl` 的輸出看起來不完整，或需要精確的稽核
   細節，請以 `/var/log/drm-backup.log`（`backup.sh` 直接寫入的檔案）為
   準——這是完整、權威的執行紀錄來源。

# 災難復原

真正需要還原時，執行 `scripts/restore.sh <加密備份檔路徑>`——這支腳本
才是實際的災難復原 runbook（互動式確認、依序還原各 volume 與 Postgres、
等待服務回報健康）。細節見腳本開頭註解與
`docs/superpowers/specs/2026-08-03-backup-disaster-recovery-design.md` 的
「還原流程」段落與「範圍之外」段落（列出幾項刻意先不處理的已知限制）。
