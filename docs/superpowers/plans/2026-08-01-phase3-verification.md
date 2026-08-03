# Phase 3 驗證

針對 Phase 3（Audit Logging，稽核日誌）的完整套件驗證，在一個完全全新的
stack（`docker compose down -v && docker compose up -d --build`）上執行，確保個別任務層級測試遺留的任何狀態都不會延續下來，接著進行一次針對稽核軌跡的真實手動走查——包含對正在執行中的資料庫進行一次刻意的竄改測試——這些都是工作項目 1-6 的自動化測試單靠自身無法涵蓋的部分。

## 1. 全新的整體 stack 重建

重建之前 host 磁碟使用率為 86%（`df -h /`），高於任務簡報中提到的約 85%
門檻。單獨執行 `docker builder prune -f` 並沒有回收任何空間（0B，作用中快取內沒有可清理的懸置項目），因此接著執行了
`docker image prune
-a -f --filter "until=48h"`，再執行 `docker builder prune -a -f`，回收了足夠的空間，在開始建置之前將使用率降到 80%。

```
docker compose down -v && docker compose up -d --build
```

全部 8 個 DRM 容器（`traefik`、`postgres`、`keycloak`、`api`、`web`、
`openbao`、`openbao-init`、`kes`、`minio`、`minio-init`）都被銷毀
（包含具名 volume）並從頭重新建立。確認沒有任何 `drm-*`
容器在 `down -v` 之後存活下來（`docker ps -a | grep drm` 沒有回傳任何結果，
exit code 1），並且每個容器在 `docker
compose ps` 中的 `CreatedAt` 時間戳記都與 `up -d --build` 執行的那一刻相符（全部都在同一分鐘內建立），而非沿用了舊有／重複使用的容器。

Keycloak 的冷啟動（全新 volume——完整 schema 遷移加上 realm
匯入）在 host 負載下花了略多於 4 分鐘，之後
`/realms/drm/.well-known/openid-configuration` 才開始回應，與 Phase 2B
約 220 秒的觀察落在相同範圍內。之後全部 8 個容器都回報為
`Up`／`healthy`，沒有任何重啟。

## 2. 一起執行的自動化套件

### Smoke test

```
./scripts/smoke-test.sh
```

```
OK: http://api.drm.localhost/health
OK: http://auth.drm.localhost/realms/drm/.well-known/openid-configuration
OK: http://app.drm.localhost/
OK: http://storage.drm.localhost/
OK: http://127.0.0.1:9000/minio/health/live
Smoke test passed.
```

### API 單元套件

```
pnpm --filter api test
```

**5 個套件通過，22 個測試通過**（`audit.service.spec.ts`、
`user-persistence.spec.ts`、`acl.service.spec.ts`、`jwt.strategy.spec.ts`、
`health.controller.spec.ts`）。每個 spec 檔案都各自啟動了自己的 Testcontainers
Postgres，並乾淨地套用了全部 4 個 migration（`init`、
`drop_email_unique_constraint`、`documents_folders_acl`、`audit_logs`）。
`audit.service.spec.ts` 的併發測試（10 個併發的
`record()` 呼叫）通過，確認了 advisory-lock 序列化機制有效。

### API e2e 套件

```
pnpm --filter api test:e2e
```

在 182 秒的單元套件執行完成後，緊接著連續執行兩次，用以檢查 Phase 2B
驗證時曾遇到的那類計時問題：

```
Test Suites: 10 passed, 10 total
Tests:       26 passed, 26 total
Time:        89.21 s
```

```
Test Suites: 10 passed, 10 total
Tests:       26 passed, 26 total
Time:        50.35 s
```

兩次執行都是綠燈，全部 10 個套件（`whoami`、`folders`、`permissions`、
`storage`、`documents-read`、`documents-write`、`audit-folders`、
`audit-documents`、`audit-permissions`、`audit-endpoints`）皆通過。與
Phase 2B 最終驗證不同的是，**這次沒有出現任何整合層級才會出現的失敗**
——兩次執行中都沒有 timeout、沒有測試資料衝突、沒有不穩定現象。
`jest-e2e.json` 的 `testTimeout`（在 Phase 2B 提高到 30000ms）對這個階段新增的四個稽核 e2e spec
檔案與其他所有測試一起執行時，顯然已提供了足夠的餘裕。這一步並不需要對應用程式或測試程式碼做任何變更。

### API lint

```
pnpm --filter api lint
```

乾淨——沒有輸出，沒有錯誤。

### Web 測試套件

```
pnpm --filter web test
```

**1 個檔案通過，2 個測試通過**（`Home.test.tsx`）。

## 3. 手動走查

在上述自動化套件執行之後，於同一個全新重建的 stack 上，以 `curl` 手動執行，扮演
`testadmin`（`id:
6ae638e9-b2f8-45c2-a7ff-4a24ececb95e`），並以 `testuser`（`id:
0583c9cc-ccc2-4fcb-b282-764a36b31bbb`）作為授權的接收者。完整的原始請求／回應記錄存放於本任務的暫存工作目錄中；以下為敘述說明與稽核日誌摘錄。

1. **建立一個資料夾。** 以 testadmin 身分執行 `POST /folders {"name":"phase3-walkthrough-<ts>"}`
   → 201，`id: 0839dd2d-fc96-4954-938f-6b41ca82e64f`。
   `GET /folders/:id/audit-logs` → 一筆項目，`folder_create`（序號 69，
   `prevHash` 連結到自動化 e2e 執行遺留下來的鏈上前一筆——這條鏈依設計是橫跨所有資源的全域鏈，而非各資源獨立的鏈）。

2. **檢視該資料夾。** `GET /folders/:id` → 200。`GET
   /folders/:id/audit-logs` → 現在有兩筆項目：`folder_create`（序號 69），
   `folder_view`（序號 70，`prevHash` 完全等於序號 69 的 `hash`：
   `ee273bdce5fe3d5f1a8ff38a7e31ad31b03a0d11bdb75bf5867b061538d74897`）。

3. **上傳一份文件到該資料夾。** 以本地產生的文字檔執行 `POST /documents`
   （multipart）→ 201，`id:
   c98e3353-dde9-477f-9b3e-40295fef5658`，`versionNumber: 1`，`sha256`
   與本地計算出的上傳檔案雜湊值相符
   （`c3816a78...`）。`GET /documents/:id/audit-logs` → 一筆項目，
   `document_create`（序號 71，`prevHash` 為該資料夾 `folder_view`
   的 hash——確認了這條鏈是橫跨資料夾與文件的單一全域序列，並非依資源類型分開儲存）。

4. **檢視其中繼資料。** `GET /documents/:id` → 200，欄位符合預期。
   `GET /documents/:id/audit-logs` → 附加了 `document_view`
   （序號 72，正確連結）。

5. **下載該文件並確認位元組相符。** `GET /documents/:id/download`
   → 得到完全一致的原始位元組；`diff` 顯示沒有任何差異，來源與下載檔案的
   `sha256sum` 完全相符（兩者皆為 `c3816a78...`）。`GET /documents/:id/audit-logs` →
   附加了 `document_download`（序號 73，正確連結）。

6. **上傳第二個版本。** 以不同檔案執行 `POST /documents/:id/versions`
   → 201，`versionNumber: 2`。`GET /documents/:id` 顯示
   `currentVersionId` 已正確重新指向新版本。`GET
   /documents/:id/audit-logs` → 附加了 `document_version_upload`（序號
   74），加上因後續用來確認重新指向的 `GET
   /documents/:id` 呼叫而產生的 `document_view`（序號 75）——兩者都正確地串接在鏈上。

7. **授權前的鎖定檢查。** 以 testuser 身分：`GET /folders/:id` → 在任何授權存在之前回傳 403。

8. **授予 testuser `view` 權限。** 以 testadmin 身分執行 `POST /folders/:id/permissions
   {"principalType":"user","principalId":"<testuser id>","permissionLevel":"view"}`
   → 201。`GET /folders/:id/audit-logs` → 附加了 `permission_grant`
   （序號 76，正確連結到上一筆文件鏈項目——再次確認了單一全域鏈）。授權之後，testuser 執行的 `GET
   /folders/:id` → 200，這次呼叫本身也記錄了一筆
   `folder_view`（序號 77），歸屬於 testuser 自己的 `actorId`——這條鏈確實正確捕捉了是哪個 principal 執行了每一個動作，而不只是記錄資源擁有者。

9. **撤銷授權。** 以 testadmin 身分執行 `DELETE /folders/:id/permissions/:permissionId`
   → 204，空 body。`GET /folders/:id/audit-logs` →
   附加了 `permission_revoke`（序號 78，正確連結）。撤銷之後，testuser 執行的
   `GET /folders/:id` → 再次回傳 403——存取權立即被撤銷，沒有延遲現象。

10. **驗證整條鏈。** 以 testadmin 身分執行 `GET /audit-logs/verify` → `{
    "valid": true }`。以 testuser（非管理員）身分執行 → `403
    {"message":"Only
    admins can verify the audit chain", ...}`。

每一個步驟的行為都完全符合預期：每筆稽核項目都在對應操作觸發後立即出現，每筆新項目的 `prevHash` 都與前一筆項目的
`hash` 逐位元組完全相符，整條鏈在整個走查過程中——橫跨不同資源類型與不同操作者——始終保持有效。

## 4. 刻意的竄改測試

直接連線到正在執行中的 Postgres 容器（`docker exec
drm-postgres-1 psql ...`，並透過 `docker port drm-postgres-1` 確認這與 host
上對外開放的資料庫是同一個
`postgresql://drm:drm_dev_password@localhost:5433/drm`——`5432/tcp ->
127.0.0.1:5433`；host 上並未安裝本機的 `psql` 客戶端，因此改用容器化的客戶端來連到同一個資料庫實例）。

找出走查第 3 步中產生的 `document_create` 那一列（`id:
2b2f2deb-2087-429b-b6db-1f95a231998d`，`sequence: 71`），並手動修改其
`actorId`：

```sql
UPDATE audit_logs SET "actorId" = 'tampered-actor-id'
WHERE id = '2b2f2deb-2087-429b-b6db-1f95a231998d';
```

**竄改之前：** `GET /audit-logs/verify` → `{"valid":true}`（來自上方第 10 步）。

**竄改之後：** `GET /audit-logs/verify` →
```json
{"valid":false,"brokenAtId":"2b2f2deb-2087-429b-b6db-1f95a231998d"}
```

`brokenAtId` 與被修改的那一列完全相符。這是預期中的結果：`actorId` 是雜湊輸入的一部分
（`id|actorId|action|resourceType|resourceId|ipAddress|createdAt|prevHash`），
因此就地修改它會使得儲存的 `hash` 無法再從該列自身的欄位重新計算出來，`verifyChain`
的重新計算機制會在該列偵測到問題。

**事後還原了這項修改：**

```sql
UPDATE audit_logs SET "actorId" = '6ae638e9-b2f8-45c2-a7ff-4a24ececb95e'
WHERE id = '2b2f2deb-2087-429b-b6db-1f95a231998d';
```

確認鏈已經恢復：`GET /audit-logs/verify` →
再次回傳 `{"valid":true}`。（依照任務簡報，開發用資料庫無論如何都是可拋棄的，但選擇還原是為了讓環境保持在一個乾淨、可驗證為有效的狀態，而不是永久停留在被竄改的狀態。）

## 變更的檔案

無。這次執行沒有出現任何整合層級才會出現的失敗（第 2 節），因此不需要對應用程式、測試或設定程式碼做任何變更——這個階段的重建與完整套件執行在第一次嘗試就乾淨通過。只新增了本份驗證文件。

## 結果

所有自動化套件在一個全新的 stack 上一起通過（smoke test；5/5
單元套件、22/22 單元測試，包含併發測試；10/10 e2e 套件、
26/26 e2e 測試，連續兩次執行都穩定；lint 乾淨；1/1 web
套件、2/2 web 測試）。針對完整的資料夾 → 上傳 → 檢視 → 下載 →
版本 → 授權 → 撤銷流程所做的手動走查，以 testadmin 與 testuser 身分親手對正在執行中的 stack 操作，在每一步都產生了順序正確、雜湊連結正確的稽核項目，且
`GET
/audit-logs/verify` 全程都回報 `{ valid: true }`。針對正在執行中的資料庫所做的刻意竄改測試——直接在 Postgres 中手動修改一列的
`actorId`——被 `GET /audit-logs/verify` 正確偵測到，回報
`{ valid: false, brokenAtId: "<被修改那一列的確切 id>" }`，事後也已還原該項修改，恢復為
`{ valid: true }`。Phase 3 已驗證完成：稽核軌跡與雜湊鏈在完整的自動化套件以及一次真實的、對抗性的手動檢查之下，都能夠保持穩固。
