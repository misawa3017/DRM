# Phase 2B 驗證

針對 Phase 2B（Documents, Folders & ACL）進行完整套件驗證，並在一個
完全全新的環境（`docker compose down -v && docker compose up -d --build`）上執行，
以確保先前個別任務層級測試所留下的狀態不會殘留影響本次結果。

## 1. `testadmin` fixture

`testadmin` 在任務 5 期間就已加入並存在於 `keycloak/realm-export.json` 中，
因此第 1 步只是一次確認，而非修改 —— 沒有對
`keycloak/realm-export.json` 做任何變更。

透過對剛匯入的 realm 發出密碼授權（password-grant）token 請求來確認：

```
POST http://auth.drm.localhost/realms/drm/protocol/openid-connect/token
  client_id=drm-web&grant_type=password&username=testadmin&password=testadminpass
```

解碼後的 access token claims 為：`preferred_username: testadmin`、
`email: testadmin@example.com`、`realm_access.roles: ["admin"]`。登入與
角色指派均運作正常。

## 2. 全新的全端重建

```
docker compose down -v && docker compose up -d --build
```

全部 10 個 DRM 容器（`traefik`、`postgres`、`keycloak`、`api`、`web`、
`openbao`、`openbao-init`、`kes`、`minio`、`minio-init`）都被銷毀
（包含具名 volume），並從零重新建立 —— 已確認在 `up` 之前沒有容器
在 `down -v` 之後存活（`docker ps -a | grep drm` 回傳空結果），且映像檔
確實有重新建置（compose 輸出中出現 `Image ... Built`，並解壓縮出全新的
`drm-api` 映像檔等）。

Keycloak 的冷啟動（全新 volume ——需完整跑一次 Liquibase schema
migration 加上 realm import，而非僅是溫啟動）在主機負載較高的情況下
花費約 220 秒，超過任務簡述中 90-170 秒的估計值。`docker logs
drm-keycloak-1` 顯示它整段時間都在依序執行 Quarkus augmentation →
schema migration（134 個 changeset）→ realm import，因此這屬於
合理的冷啟動作業，而非卡死。

## 3. 一併執行自動化測試套件

### 冒煙測試（Smoke test）

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

### API 單元測試套件

```
pnpm --filter api test
```

**4 個套件通過，16 個測試通過**（`acl.service.spec.ts`、
`user-persistence.spec.ts`、`health.controller.spec.ts`、
`jwt.strategy.spec.ts`）。每個單元測試檔案都各自執行一個 Testcontainers
Postgres 實例，並乾淨地套用全部 3 個 migration。

### API e2e 測試套件

```
pnpm --filter api test:e2e
```

**第一次執行：1 個失敗。** `permissions.e2e-spec.ts` 的第一個測試
（「grants view access to another user, who can then see the folder but not manage
it」）在等待一次真實的 HTTP 往返（token 請求／建立資料夾）時，超過
了該檔案 15000ms 的 Jest 測試逾時上限，儘管該測試中的每個斷言其實
都是正確的。緊接著單獨重新執行該測試檔案（同一個環境、沒有任何程式
碼變更），該測試在 2.8 秒內就通過了，這證實了問題並非邏輯錯誤或
測試資料衝突，而是時間問題：這台主機只有單一 CPU，且在此之前才剛
執行完整個單元測試套件（124 秒）、另外 5 個 e2e 測試檔案，以及若干
與本專案無關的 Docker 專案容器，在這樣的負載下，15 秒對於一次真實的
Keycloak + Postgres + MinIO 往返而言時間太過緊迫。

**修正方式：** 將 `apps/api/test/jest-e2e.json` 中的 `testTimeout` 從
`15000` 提高到 `30000`。由於這裡測試的是真實的基礎設施（真正的
Keycloak token 核發、真正的 Postgres、透過 StorageService 的真正
MinIO），而非 mock，因此對於共享且負載較高的主機而言，放寬逾時時間
是合理的做法，而不是在掩蓋真正的缺陷 —— 應用程式程式碼本身沒有任何
變更。

**修正後，為求穩定性，重新執行兩次：**

```
Test Suites: 6 passed, 6 total
Tests:       21 passed, 21 total
```
（兩次執行分別耗時 38 秒與 46 秒；`permissions.e2e-spec.ts`、
`whoami.e2e-spec.ts`、`folders.e2e-spec.ts`、`storage.e2e-spec.ts`、
`documents-write.e2e-spec.ts`、`documents-read.e2e-spec.ts` 兩次都全數
通過。）

這是將所有測試一併執行、而非逐項任務分別測試時，唯一浮現出來的整合
問題 —— 並未觀察到測試檔案之間有任何測試資料衝突（每個測試建立的
資料夾與文件名稱都是唯一的／帶有 `Date.now()` 後綴，因此即使在高負載
下也未預期會、也確實沒有發生衝突）。

### Web 測試套件

```
pnpm --filter web test
```

**1 個檔案通過，2 個測試通過**（`Home.test.tsx`）。

## 4. 手動端對端走查

在上述自動化測試套件執行完畢後，於同一個剛重建完成的環境上，使用
`curl` 手動進行。

1. **以 `testadmin` 身分登入。** 對 `drm-web` 發出的密碼授權請求成功；
   `GET /whoami` 回傳 `{"email":"testadmin@example.com","roles":["admin"]}`。
2. **建立一個根資料夾。** 以 testadmin 身分執行
   `POST /folders {"name":"walkthrough-root-<ts>"}`，回傳 201，且
   `"parentId":null` —— 確認是一個真正的根資料夾。
3. **上傳一份文件到該資料夾中。** `POST /documents`（multipart，包含
   `folderId`、`name` 與 `file`），使用一個本機產生的文字檔，回傳 201，
   `versionNumber: 1`，且回傳的 `sha256` 與本機計算出的上傳檔案雜湊值
   相符。
4. **下載回來並確認位元組一致。** 以 testadmin 身分執行 `GET
   /documents/:id/download`，回傳的內容與原始檔案完全一致 ——
   對原始檔案執行 `diff` 未發現任何差異，原始檔案與下載檔案的
   `sha256sum` 完全相符。
5. **上傳第二個版本。** 以不同檔案執行 `POST /documents/:id/versions`
   成功，`versionNumber: 2`；`GET /documents/:id/versions` 列出了
   兩個版本（v2 排在前面），且 `GET /documents/:id` 顯示
   `currentVersionId` 已正確重新指向新版本。
6. **授權前的鎖定情況檢查。** 以 `testuser` 身分登入；在尚未有任何
   授權存在時，`GET /folders/:id` 與 `GET /documents/:id` 均回傳 403。
7. **將 `view` 權限授予 `testuser`。** 以 testadmin 身分執行 `POST
   /folders/:id/permissions
   {"principalType":"user","principalId":"<testuser id>","permissionLevel":"view"}`，
   回傳 201，並附上新建立的權限資料列。
8. **確認 testuser 在 `view` 授權下的存取權限。** 以 testuser 身分：
   `GET /folders/:id` → 200；`GET /documents/:id` → 200（可以看到
   資料夾與文件的中繼資料）。`POST /documents/:id/versions`（編輯）→
   403。`POST /folders/:id/permissions`（管理）→ 403。`GET
   /documents/:id/download` → 403，並附上 `"You do not have download access
   to this document"`。最後這一項是預期行為，並非缺陷：ACL 的
   `LEVEL_ORDER`（`view: 1 < download: 2 < edit: 3 < manage: 4`，定義於
   `AclService` 中僅一處）意味著 `view` 授權在設計上並不包含下載權限
   —— 下載屬於嚴格意義上更高的權限層級。任務簡述中的走查步驟只要求
   確認「有 view 但沒有 edit/manage」，這一點已成立；下載檢查是額外
   增加的探測，用來確認權限層級確實依照設計被強制執行。
9. **撤銷授權。** 以 testadmin 身分執行 `DELETE
   /folders/:id/permissions/:permissionId`，回傳 204，回應內容為空。
10. **確認 testuser 再次被鎖定。** 以 testuser 身分：`GET
    /folders/:id` → 403，`GET /documents/:id` → 403。存取權限
    立即被完全撤銷，未觀察到任何快取或資料延遲的情況。

每個步驟的行為都符合預期；手動走查的結果與自動化測試套件對相同流程
的涵蓋範圍之間，未發現任何不一致之處。

## 變更的檔案

- `apps/api/test/jest-e2e.json` —— `testTimeout` 從 15000ms 提高到
  30000ms，讓依賴真實基礎設施的 e2e 測試在完整套件一併執行、主機
  負載較高／共享的情況下有足夠的餘裕（詳見第 3 節）。
- `keycloak/realm-export.json` —— 未變更；`testadmin` 在任務 5 時
  即已存在，已確認可正常運作，不需要任何修改。

## 結果

所有自動化測試套件在全新環境上一併執行皆通過（冒煙測試；4/4 個單元
測試套件、16/16 個單元測試；6/6 個 e2e 測試套件、21/21 個 e2e 測試，
多次重複執行結果穩定；1/1 個 web 測試套件、2/2 個 web 測試）。手動
走查了完整的「資料夾 → 上傳 → 下載 → 建立版本 → 授權 → 撤銷」流程，
分別以 testadmin 與 testuser 身分手動操作，每一步的行為都符合預期，
包括 ACL 權限層級的強制執行。Phase 2B 已驗證完成。
