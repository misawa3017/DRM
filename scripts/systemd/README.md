# 安裝每日備份排程

1. 把 `drm-backup.service`／`drm-backup.timer` 裡所有出現的 `/opt/drm`
   （包含 `WorkingDirectory=` **以及** `ExecStart=`）都改成這台主機上實際
   clone 這個 repo 的路徑。只改 `WorkingDirectory=` 而漏改 `ExecStart=`
   會導致 service 找不到 `backup.sh` 而啟動失敗。
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

   注意：`journalctl` 在某些情況下可能無法完整擷取 `backup.sh` 透過
   `tee` 輸出的每一行 log（bursty subprocess 輸出下的已知擷取問題，並非
   實際執行有缺漏）。若 `journalctl` 的輸出看起來不完整，或需要精確的稽核
   細節，請以 `/var/log/drm-backup.log`（`backup.sh` 直接寫入的檔案）為
   準——這是完整、權威的執行紀錄來源。
