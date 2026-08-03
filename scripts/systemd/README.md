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
