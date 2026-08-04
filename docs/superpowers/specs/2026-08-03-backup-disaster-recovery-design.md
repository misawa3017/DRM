# 備份與災難復原設計

## 背景

目前系統的所有狀態都只存在單一台主機上：Postgres（`Document`/`Folder`/`Permission`/`AuditLog` 等中繼資料）、MinIO（透過 KES/OpenBao 以 SSE-KMS 加密的文件物件）、OpenBao（KES 的金鑰材料，以及解密一切所需的 unseal key／root token）。這些全部都是 Docker named volume，沒有任何一份備份存在於這台主機之外。一旦主機硬體損毀或整台機器遺失，目前完全沒有救回資料的手段。

這份設計要解決的問題是：**主機整台毀損時，能不能把系統（含全部機密文件）救回來**——而不是單純的「不小心刪錯檔案」復原。

## 目的

建立一套每日執行、將系統完整狀態（資料庫中繼資料＋加密文件物件＋解密所需的金鑰材料）備份到區網內另一台主機／NAS 的機制，且備份檔案本身在傳輸與存放時都維持加密，不因為多了一份備份就多開一個可以繞過加密直接讀到明文機密文件的破口。

## 架構

新增兩支主機層 shell 腳本，放在既有的 `scripts/` 目錄（與 `verify-clamav.sh`、`verify-gotenberg.sh` 等既有腳本同一慣例）：

- **`scripts/backup.sh`** —— 每日 **03:00** 由主機層的 systemd timer 觸發（選 systemd timer 而非純 crontab，方便用 `journalctl` 檢視執行紀錄；時間點刻意避開 Phase 4C 到期掃描的 02:00，避免兩者互相干擾）。
- **`scripts/restore.sh`** —— 還原腳本，供演練與真正災難復原時使用。

兩支腳本都在主機層執行，透過 `docker compose exec`／`docker run -v <volume>` 存取現有的 Docker named volume，**不需要修改 `docker-compose.yml`**。備份邏輯刻意不放進 `apps/api`：備份需要直接操作 Docker volume、執行 shell 指令，這類權限不應該給應用程式容器，符合 Phase 4B/4C 已經建立的「api/worker 各自維持最小權限」原則。

**備份期間會有一段短暫、排定好的停機視窗**：為了讓 `pg_dump` 與所有 volume 的 tar 都來自同一個「零寫入」的瞬間，避免資料庫快照與物件快照之間出現時間差，`scripts/backup.sh` 會在打包步驟開始前先 `docker compose stop api worker keycloak`（會寫入 Postgres／MinIO／自身資料庫的服務；Postgres／MinIO／OpenBao／KES／Redis 本身照常運作），打包完成後立刻 `docker compose start api worker keycloak`，把停機時間壓縮到只涵蓋打包所需的時長——加密與 rsync 上傳留到服務恢復後才執行。這段時間內 `api` 完全無法存取（讀寫皆然，因為是整個容器停掉，並非只擋寫入），詳見下方「每日備份流程」與「使用者停機通知」。

**MinIO／OpenBao 的備份方式是原始 volume 層級複製，不透過 S3 API**：若用 `mc mirror` 或任何呼叫 MinIO GetObject 的方式備份，KES 會在傳輸前自動解密，備份出來的就是明文，等於繞過整個加密鏈。因此一律用一次性容器唯讀掛載對應 volume 後直接 tar，保留原始密文。

**備份檔案本身在落地前會被加密**：整包備份用一組獨立密碼做對稱加密（優先使用 `age`，主機上沒有時退回 `gpg --symmetric`，兩者擇一由撰寫實作計畫時依主機環境確認），密碼存於 `secrets/backup-passphrase`（比照 `secrets/kes/` 加入 `.gitignore`，`openssl rand -base64 32` 產生一次）。**這份密碼必須額外抄一份存放在主機與 NAS 之外的地方**（保險箱、密碼管理器）——密碼若沒被妥善保管，加密備份就形同虛設；這與 OpenBao 目前 `-key-shares=1 -key-threshold=1` 的 unseal key 保管原則一致（見 Phase 2A 設計中的既有記錄）。

## 備份範圍與元件

| 元件 | 來源 | 備份方式 |
|---|---|---|
| Postgres 中繼資料 | `postgres` 服務 | `pg_dump -F custom`（邏輯備份，MVCC 一致性快照，不需停機） |
| MinIO 加密物件 | `minio_data` volume | 一次性容器唯讀掛載，`tar` 打包，保留原始密文 |
| OpenBao 金鑰資料（KES 的 kv-v2 secrets） | `openbao_data` volume | 同上 |
| OpenBao unseal key／root token | `openbao_init` volume 內的 `openbao-init.json` | 同上——這是解密一切的最後一把鑰匙 |
| KES AppRole 憑證 | `openbao_approle` volume | 同上 |
| KES／MinIO mTLS 憑證 | 本機 `secrets/kes/`（非 Docker volume） | 直接 `tar` |
| Keycloak 使用者／realm 資料庫 | `keycloak_data` volume | 同上——Postgres 裡每一筆牽涉到使用者的紀錄（`User.keycloakSub`、`Permission.principalId`、`Document.createdBy`、`AuditLog.actorId` 等）都指向 Keycloak 的 `sub` UUID，沒備份這個 volume，還原後 Keycloak 重新 import 會產生全新的 UUID，文件救得回來但擁有權／權限／稽核紀錄全部對不起來 |

**新增設定**（`.env`）：
- `BACKUP_SSH_TARGET`（NAS 的 `user@host:/path`）
- `BACKUP_SSH_KEY_PATH`（指向 `secrets/backup-ssh/`，備份專用、與其他用途分開的 SSH 金鑰）
- `BACKUP_RETENTION_DAYS`（預設 `14`）

**新增機密**（皆加入 `.gitignore`）：
- `secrets/backup-passphrase`
- `secrets/backup-ssh/`（SSH 私鑰／公鑰）
- `secrets/backup-notify/smtp-password`
- `secrets/backup-notify/gchat-webhook-url`

## 每日備份流程

`scripts/backup.sh` 依序執行以下步驟，任一步驟失敗就整支腳本中止（fail-closed，不產生「部分備份」並假裝成功）：

1. **上鎖**：用 `flock` 鎖住 lockfile，避免前一天的備份還沒跑完就被下一次排程觸發（這台主機在先前幾個 Phase 都出現過偶發的高負載狀況）。
2. **建立當日暫存目錄**：`/var/backups/drm-staging/<YYYY-MM-DD>/`（主機層路徑，在 git repo 之外，避免誤 commit）。
3. **停用寫入（進入停機視窗）**：`docker compose stop api worker keycloak`。
4. **依序備份各元件**：`pg_dump` → `postgres.dump`；接著依「備份範圍與元件」表格順序，逐一 tar 出 `minio_data.tar.gz`、`openbao_data.tar.gz`、`openbao_init.tar.gz`、`openbao_approle.tar.gz`、`keycloak_data.tar.gz`、`kes-secrets.tar.gz`（`minio_data`／`openbao_*` 已經是密文，tar 時略過 gzip 以縮短停機視窗內的耗時；`keycloak_data`／`kes-secrets.tar.gz` 仍照常壓縮）。由於前一步已經停掉會寫入的服務，這裡拿到的 `pg_dump` 快照與各 volume 的 tar 內容，全部來自同一個「零寫入」的時間點，彼此完全一致，不會有資料落差。
5. **恢復服務（結束停機視窗）**：`docker compose start api worker keycloak`，等待回報健康。停機時間僅涵蓋步驟 3-5，通常是打包所需的時長（實際數字依資料量於實作時量測）。
6. **寫入 manifest**：`manifest.txt` 記錄每個檔案的 checksum、備份時間戳、當下的 git commit hash（方便日後對照備份當時的 schema／程式碼版本）。
7. **整包加密**：把整個當日目錄打包後用 `secrets/backup-passphrase` 加密，產生單一檔案 `drm-backup-<YYYY-MM-DD>.tar.age`（或 `.gpg`）。此步驟與之後的 rsync 都在服務已恢復後進行，不佔用停機時間。
8. **rsync 到 NAS**：透過 `secrets/backup-ssh/` 的金鑰，將加密檔案送至 `BACKUP_SSH_TARGET`。
9. **份數保留**：未加密的中繼素材（`postgres.dump` 等）當次跑完即刪除，不留在本機；本機只保留最近 7 天的**加密後**備份檔；NAS 端保留最近 `BACKUP_RETENTION_DAYS`（預設 14）天，超過的自動清除。
10. **通知**：見下方「通知」段落。

**若步驟 3-5 之間發生例外**（例如打包途中失敗）：`backup.sh` 必須在中止前先確保 `api`／`worker` 已經被重新啟動（放進 `trap`／`finally` 邏輯），避免備份失敗又導致系統一直停在停機狀態——服務復原永遠優先於備份是否成功。

## 使用者停機通知

由於停機時間點是固定的每日排程（03:00），不是臨時決定，因此用一個**靜態橫幅**告知即可，不需要動態的後端協調或倒數提醒：

- 在 `apps/web` 加一個固定顯示的提示橫幅（新增 `apps/web/src/MaintenanceNotice.tsx`，由 `App.tsx` 引入），內容如：「系統每日 03:00 進行例行維護，期間約數分鐘無法使用」。
- 橫幅內容（時間、預估時長）是寫死的常數，不從後端取得，因為排程本身就是固定值——這樣完全不需要新增任何 API 端點或跟 `scripts/backup.sh` 做任何協調。
- 停機期間（`api` 容器實際停止的當下），使用者的請求會直接連線失敗（Traefik 找不到後端），瀏覽器會顯示一般的連線錯誤，不會有客製化的「維護中」錯誤頁——這部分故意先不做（見「範圍之外」），因為停機視窗排在離峰的 03:00，且時長很短。

## 通知

- **失敗**（任一步驟中止，或 rsync 失敗）→ 同時寄信（`curl` 直接對 SMTP 伺服器送信，不額外安裝完整 MTA）+ 發送 Google Chat 訊息（透過 incoming webhook），內容包含：失敗發生在哪一步、時間戳、log 檔最後幾行。
- **成功** → 只發送一則簡短的 Google Chat 訊息（例如「`2026-08-03` 備份成功，大小 X MB」），不寄信。這則訊息同時也是通知機制本身仍正常運作的心跳信號——若連這則都沒出現，代表腳本可能整個沒有被觸發。
- 通知本身失敗（例如 SMTP 或 webhook 暫時無法連線）不能讓備份流程跟著判定失敗——通知呼叫獨立包裝、失敗只記一行 log，不影響備份腳本原本的 exit code。

## 錯誤處理

- 任一步驟失敗（`pg_dump`、任一 volume tar、加密、rsync）→ 立即中止，非 0 exit code，寫入 `/var/log/drm-backup.log`，並依上方規則發送失敗通知。
- rsync 失敗（NAS 斷線／不可達）→ 保留本機已加密的當日備份檔（不刪除），下一次排程仍會照常獨立執行；若連續多天失敗，本機保留上限（7 天）會讓問題變得明顯（磁碟開始累積、且每次都會收到失敗通知），而不是悄悄無限佔用空間或靜默失敗。

## 還原流程

`scripts/restore.sh <加密備份檔>`：

1. 用 `secrets/backup-passphrase` 解密，展開成當日的暫存目錄。
2. `docker compose down`（停掉整個 stack）。
3. 清空對應的 Docker volume，將 tar 內容還原回去（`minio_data`、`openbao_data`、`openbao_init`、`openbao_approle`、`keycloak_data`）。
4. 還原本機 `secrets/kes/`。
5. `docker compose up -d`，等待 OpenBao／KES／MinIO／Postgres 全部回報健康。
6. 對 Postgres 執行 `pg_restore` 還原 `postgres.dump`。
7. 執行最小化驗證（見下方「測試／驗證」），確認系統真的復原，而不是只看容器 healthy 就當作沒事。

還原全程由人工觸發並在旁監看，不做自動 failover。

## 測試／驗證

延續本專案「對照真實運行中的堆疊驗證，不模擬基礎設施」的既有慣例：

- 在開發環境實際執行一次 `backup.sh`，確認產出的加密檔案能用 `secrets/backup-passphrase` 正確解開，且 `manifest.txt` 內的 checksum 與實際檔案相符。
- **完整還原演練**：取一份備份，在一個乾淨的 scratch 環境執行 `restore.sh`，還原後實際登入系統、瀏覽資料夾、下載一份文件、確認內容與加密前一致（雜湊比對）、確認稽核紀錄仍在、確認權限設定仍在——這是唯一能證明備份「真的救得回來」的方式，只看檔案打包成功不足以證明。
- 刻意模擬 rsync 失敗情境（例如暫時阻斷 SSH 連線），確認腳本正確中止、不產生假成功的備份、本機仍保留最後一份完好的備份、且收到失敗通知（mail + Google Chat）。
- 驗證成功情境下確實只收到 Google Chat 通知、沒有寄信。
- 測試 retention 清除邏輯：手動製造超過 `BACKUP_RETENTION_DAYS` 的舊備份，確認清除邏輯只刪除該刪的，沒有誤刪還在保留期內的備份。
- **停機視窗**：實際跑一次 `backup.sh`，確認 `api`／`worker` 在打包開始前確實被停止、打包一結束就立刻恢復健康；並確認停機期間 `pg_dump` 與各 volume tar 的內容彼此一致（例如在停機前刻意上傳一份文件，備份後還原到 scratch 環境，確認該文件的 Postgres 紀錄與 MinIO 物件同時存在或同時不存在，不會只有一邊）。
- **失敗時的服務復原**：刻意讓打包步驟中途失敗（例如故意讓某個 tar 指令出錯），確認 `api`／`worker` 仍會被正確重新啟動，不會卡在停機狀態。
- 確認 `apps/web` 的維護提示橫幅正確顯示。
- 執行完整既有的 lint/build/unit/e2e 套件，確認新增的腳本與 `MaintenanceNotice` 元件沒有影響既有系統。

## 範圍之外

- **即時複寫**（MinIO bucket replication + Postgres streaming replication 到異機的第二套完整加密堆疊）——可將 RPO 從「最多一天」降到接近零，但需要在 NAS 端整套複製一份 MinIO+KES+OpenBao 加密鏈，維運複雜度大幅提升。留待未來若覺得一天的 RPO 不夠時再升級。
- **調整 OpenBao 的 seal 機制**（目前仍是 `-key-shares=1 -key-threshold=1`）——這是 Phase 2A 已記錄在案、給內部單一維運者用的刻意簡化。本次備份涵蓋了這把 unseal key 作為因應手段，但不在這次變更 seal 機制本身（例如拆成多份 key-shares）。
- **自動化復原／failover**——真正災難發生時，`restore.sh` 由人工觸發並在旁監看，不做無人值守的自動切換。
- **NAS 本身的可靠性／備援**（RAID、NAS 自身的備份等）——假設 NAS 本身可靠，NAS 端的容錯不在本次範圍內。
- **SSH 金鑰／Google Chat webhook 的輪替政策**——超出本次範圍，沿用一般既有的密鑰輪替慣例即可。
- **更細緻的監控儀表板**——目前只有「成功／失敗」兩種通知，不含備份耗時趨勢、容量趨勢等進階監控。
- **動態倒數提醒／後端協調的停機通知**——目前只做寫死時間的靜態橫幅；若未來排程改成不固定，才需要讓 `apps/api` 開端點、由 `scripts/backup.sh` 在停機前呼叫來觸發即時倒數。
- **客製化的「維護中」錯誤頁**——停機期間使用者看到的是一般連線錯誤，不是設計過的維護頁面（例如透過 Traefik 的 `errors` middleware 導向一個靜態頁面）；目前判斷離峰時段＋短時長不值得為此加一個常駐的維護頁服務。
- **備份 SSH 金鑰目前同時擁有 NAS 端寫入與刪除權限**（`rsync` 上傳與遠端 retention 的 `find -delete` 共用同一把金鑰）——主機一旦被入侵，理論上可以連自己的離站備份一起刪掉；之後若要加強，可在 NAS 端 `authorized_keys` 用 `command=` 限制這把金鑰只能執行 `rsync`，刪除改由 NAS 端自己的排程負責，本次不處理。
- **SMTP 密碼與 Google Chat webhook URL 目前以明文 `curl` 命令列參數帶入**，同主機的其他使用者可透過 `ps` 看到——這台主機目前是單一用途的備份主機，可接受，若之後改在共用主機上跑則需要額外處理。
- **加密備份前沒有先檢查磁碟剩餘空間**——`/var` 空間不足時會在加密中途才失敗，而不是一開始就給出明確錯誤訊息，本次不處理。
