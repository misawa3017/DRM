# Phase 4B 驗證

針對 Phase 4B(上傳流程整合:儲存前的同步 ClamAV 病毒掃描、透過
`apps/worker` + Gotenberg 進行的非同步 Office 轉 PDF 轉換)進行完整套件驗證,
在完全全新的堆疊上執行(`docker compose down -v && docker compose up -d --build`),
以確保先前個別任務層級測試(任務 1-5)未留下任何殘留狀態,所有自動化套件皆一併執行而非個別隔離執行,
接著手動走查全部三種上傳結果(受感染 / 乾淨 Office 檔案 / 乾淨純文字檔案)。

## 1. 全新的完整堆疊重建

開始前主機磁碟使用率為 82%(`df -h /`)。

```
docker compose down -v && docker compose up -d --build
```

全部 14 個 DRM 容器以及所有具名磁碟區(包含 `clamav_data`、
`postgres_data`、`keycloak_data`、`minio_data` 等)都已被銷毀——
透過 `down -v` 指令自身的輸出確認,列出每個磁碟區皆顯示
`Removed`。重建後執行 `docker compose ps --format '{{.Service}}: {{.CreatedAt}}'`
顯示每個容器的 `CreatedAt` 皆落在 `05:54:38`-`05:54:41 UTC`,
與真正全新建立(而非快取/重用容器)一致,
且與 `down -v` 的時間戳記 `05:46:21 UTC` 加上容器建立前約 8 分鐘的映像檔建置階段相符。

**映像檔建置時間明顯比 Phase 4A 更長**(三個應用程式映像檔全部合計約 8 分鐘,
相較於先前僅需數分鐘)——光是 `apps/api` 的
`pnpm install` 就花了 2m31s,而每個映像檔最後的
`exporting to image` 圖層寫入步驟花了 55-100 秒。這與主機資源壓力直接相關:
`free -h` 顯示 swap 使用量從建置開始時約 1.7GiB 一路攀升到
建置過程中某些時間點完全耗盡(0 free)(詳見下文),
而主機僅有 1.9GiB 記憶體,還同時執行著數個不相關的專案
(`isms-*`、`compassionate_elgamal`、`silly_hopper`)。

**重建過程中磁碟一度飆升至 87%**,落在本專案先前觀察到會導致建置卡住的
84-88% 區間內,恰巧與 Keycloak 領域匯入(realm-import)階段拋出的一個
真實(雖然最終是暫時性的)H2 寫入錯誤同時發生——詳見第 2 節。
`docker builder prune -f` 回收了 1.526GB 的過期建置快取圖層,
使磁碟使用率回落至 82%;這正是計畫本身的全域限制條件所要求的、
在建置過程中出現磁碟壓力時應採取的預防性步驟。

**ClamAV 首次啟動下載病毒碼定義花了 9 分 29 秒。** 直接從
`docker inspect drm-clamav-1` 的健康檢查記錄量測所得:容器建立於
`2026-08-02T05:54:38Z`,首次健康檢查成功(`Clamd is up`)
於 `2026-08-02T06:04:07Z`。落在 Phase 4A 觀察到的 7m41s
以及本專案在同一台主機上先前約 13 分鐘的觀察值之間;
遠低於 `docker-compose.yml` 中設定的 900 秒 `start_period` 預算。

**Keycloak 冷啟動花了 5 分 31 秒**(`Keycloak 25.0.6 on JVM
... started in 331.072s`,取自其自身的啟動記錄)——比 Phase 4A
觀察到的約 3.5 分鐘更慢。在完成前不久,Keycloak 的記錄顯示了一個
真實但會自行恢復的錯誤:

```
WARN [io.agroal.pool] (agroal-11) Datasource '<default>': General error:
"org.h2.mvstore.MVStoreException: Writing to sun.nio.ch.FileChannelImpl@...
failed; length 4096 at 8192 [2.2.224/2]"
```

這是 Keycloak 自身內嵌的 H2 資料庫(開發模式 `start-dev`,
與本專案的 Postgres 無關)寫入失敗,恰好與上述磁碟壓力高峰同時發生。
它在重試後自行恢復,無需人工介入——Keycloak 自身的 Liquibase 綱要遷移、
主要領域(master-realm)初始化,以及 `drm` 領域匯入
(來自 `realm-export.json`)片刻之後全數順利完成,
且 `http://auth.drm.localhost/realms/drm/.well-known/openid-configuration`
隨後立即回傳 `200`。針對磁碟壓力讀數所執行的
`docker builder prune -f` 或許有所幫助,不過無法確定這個特定的 H2 警告
是否確實與其相關——此處記錄下來作為本次執行過程中磁碟/記憶體壓力的
真實觀察到的徵狀,而非本階段自身變更中的程式碼或設定缺陷。

從 `down -v` 到 `docker compose up -d --build` 指令本身返回
(`EXIT:0`,亦即每一條 `depends_on: condition: service_healthy`
鏈——包含 `api` 對 `clamav` 健康狀態的等待——都已滿足)的總耗時為:**約 18.5
分鐘**,主要由映像檔建置階段(約 8 分鐘)以及 ClamAV
病毒碼下載(約 9.5 分鐘,與 Keycloak 冷啟動並行執行)所主導。

## 2. 一併執行的自動化套件——發現三個真實的、僅在整合層級才會出現的問題

依照任務簡報的要求,全部八個套件(`smoke-test.sh`、`api test`、
`api test:e2e`、`api lint`、`worker lint`、`web test`、
`verify-gotenberg.sh`、`verify-clamav.sh`)被反覆一併執行,
目的正是為了揭露僅在整合層級才會出現的問題。以此方式發現了三個
不同的真實問題——皆未曾在先前任何個別任務的測試中出現過——
另外還有兩次 ClamAV 在記憶體壓力下當機的事件
(與 Phase 4A 最初記錄的同一類基礎設施問題,並非新的程式碼缺陷)。

### 2a. `document-conversion.e2e-spec.ts` 的 40 秒測試逾時,對於合併負載下的真實基礎設施延遲而言過於緊繃

第一次完整合併執行時,`api test:e2e` 失敗:

```
FAIL test/document-conversion.e2e-spec.ts
  thrown: "Exceeded timeout of 40000 ms for a test."
```

調查結果:轉換流程實際上**並未**失敗。Gotenberg 自身的存取記錄
顯示了這次確切轉換的真實 `200` 回應,`"latency_human":
"17.702273582s"`——片刻之後直接對該測試的 `documentVersionId`
執行 Postgres 查詢,顯示 `previewObjectKey` 確實已經填入了真實的物件金鑰。
整條流程(排入佇列 → worker 接收 → MinIO 擷取 → Gotenberg 轉換
→ MinIO 儲存 → 透過 Redis 觸發的 BullMQ `completed` 事件 → Prisma
更新)確實已經完整執行完畢——只是比測試的 40 秒預算
(30 次 x 1 秒輪詢 + Jest 自身的 40000ms 逾時)還要慢,
因為這次執行時真實的並行負載(其他 e2e 套件同時執行,
緊接在全新重建後殘留的記憶體/swap 壓力之後)使得 Gotenberg
本身花費的時間超過其一般轉換簡單文件所需不到 5 秒的 4 倍以上。

**修正方式:** 將輪詢迴圈放寬至 90 次 x 1 秒,並將 Jest 測試逾時
放寬至 100000ms,位置在 `apps/api/test/document-conversion.e2e-spec.ts`,
並附上說明真實測量延遲的註解,說明此變更是有依據的(而非隨意調高)。
修正後立即重新執行 `api test:e2e`:13/13 個套件、
31/31 個測試通過,其中 `document-conversion.e2e-spec.ts`
在 31.987 秒內完成——輕鬆落在新的預算範圍內,確認該流程本身從未真正故障。

### 2b. `virus-scan.e2e-spec.ts` 的 lint 失敗(與 Phase 4A 任務 6 發現的同一類缺口)

```
apps/api/test/virus-scan.e2e-spec.ts
  65:35  error  Unsafe member access .documents on an `any` value
```

`axios.get(...)` 若未指定泛型型別參數,會回傳 `AxiosResponse<any>`;
該測試對這個未型別化的 `any` 存取 `folderContentsRes.data.documents`,
因而正確地觸發了 `@typescript-eslint/no-unsafe-member-access` 規則。
這幾乎完全對應 Phase 4A 任務 6 的發現(一個從未與
`test:e2e` 在同一次執行中通過 lint 檢查的 e2e 測試檔案)。

**修正方式:** 為該檔案既有的 `FolderResponse` 介面擴充一個
`documents?: unknown[]` 欄位(符合 `folders.e2e-spec.ts`
中已使用的相同模式),並明確為 `axios.get<FolderResponse>(...)`
呼叫加上型別,而非直接停用該規則。重新執行 `api lint`:結果乾淨無誤。

### 2c. 三個以 testcontainer 為基礎的單元測試規格檔中,`afterAll` 掛鉤逾時對於真實記憶體壓力下的 `container.stop()` 而言過於緊繃

在稍後一次完整合併執行中,`api test` 失敗:

```
FAIL src/prisma/user-persistence.spec.ts
  thrown: "Exceeded timeout of 5000 ms for a hook."
    at prisma/user-persistence.spec.ts:21:3  (afterAll)
```

同一次執行中,`audit/audit.service.spec.ts` 也在自身的 `afterAll`
遇到了相同的失敗。兩個檔案的 `beforeAll`(會透過 testcontainers
啟動真實的 `PostgreSqlContainer`)都已經明確設定了 60000ms 逾時——
但 `afterAll`(`prisma.$disconnect()` + `container.stop()`)
並未明確設定逾時,因而落回 Jest 預設的 5000ms。`container.stop()`
是真實的 Docker 操作,而這次執行的主機正處於與整個任務其他地方
記錄相同的記憶體/swap 壓力之下——5 秒對它來說確實太緊繃,
在兩個不同檔案中各發生了一次。

**修正方式:** 為所有三個共享此確切模式、以 testcontainer 為基礎的
單元測試規格檔的 `afterAll` 加上明確的 `60000` 逾時——
`apps/api/src/prisma/user-persistence.spec.ts`、
`apps/api/src/acl/acl.service.spec.ts`,以及
`apps/api/src/audit/audit.service.spec.ts`——與 `beforeAll`
既有的預算保持一致,而非另行發明新的數值,因為清理階段
與設定階段屬於同一類 Docker 操作。修正後重新執行 `api test`:
在接下來兩次執行中,全部三個檔案的 `afterAll` 掛鉤都在預算內順利完成
(每次都是 30/30 個測試通過)。

**同一次調查過程中發生的第四個、獨立的事件並未被視為第四個錯誤**:
在稍後一次執行中,`acl.service.spec.ts` 再次失敗——這次是在
`beforeAll` 本身(`PostgreSqlContainer.start()` 超出其既有的
60000ms 預算),發生在 `free -h` 顯示 swap **恰好剩餘 0 位元組**
(3.8/3.8GiB 已使用)的那一刻——這是整個任務過程中觀察到的
最嚴重資源壓力讀數。這是一個真實的、極端的主機層級資源耗盡事件,
並非像 2a/2c 那樣可調整逾時值即可解決的缺口:`beforeAll`
的預算原本就已經符合本專案既定的慣例,且緊接著在記憶體壓力緩解後,
同一個規格檔在下一次執行(52.7 秒內)就順利通過了。
針對此事件並未進行任何程式碼變更——對一個已經相當寬鬆的逾時值
再進一步調高,並不能解決一個確實因主機記憶體耗盡而無法啟動的容器問題,
上述另外兩個真實修正已經涵蓋了所有「合理」逾時值確實對真實
(而非資源耗盡)基礎設施延遲而言過於緊繃的情況。

### 2d. ClamAV 在記憶體壓力下當機——共兩次,兩次都依照 Phase 4A 既定程序順利恢復

在本任務反覆執行合併測試套件的過程中,`verify-clamav.sh` 及/或
`api test:e2e` 的 `virus-scan`/`document-conversion` 套件
有兩次因以下錯誤而失敗:

```
Error: connect ECONNREFUSED 172.19.0.5:3310
```

兩次執行 `docker exec drm-clamav-1 ps -eo pid,stat,args`
都確認了與 Phase 4A 完全相同的根本原因:`clamd` 的處理程序
在主機記憶體壓力下進入了 `Z`(殭屍)狀態——這是真實的當機,
而非單純的變慢。兩次事件中,`docker compose ps` 快取的 `healthy`
狀態都已經過期(30 秒健康檢查間隔 / 10 次重試門檻尚未捕捉到這次當機),
這正是為什麼 `verify-clamav.sh` 直接執行掃描嘗試,
比單純信任 compose 快取的健康狀態欄位更為可靠。

**修正方式(兩次皆同):`docker compose restart clamav`**——
與 Phase 4A 記錄的既定復原方式相同。這次執行的復原時間
比 Phase 4A 觀察到的約 5 秒更長(每次大約 1-3 分鐘,
其中一段期間 `clamd`/`freshclam` 在 swap 完全耗盡時
停留在不可中斷睡眠(`D`)狀態)——這與這次執行整體較高的記憶體壓力一致,
而非 ClamAV 自身行為的變化。兩次事件都不需要重新下載病毒碼定義
(`clamav_data` 磁碟區在單純的 `restart` 過程中會保留下來,
僅在 `down -v` 時才會被清除),且兩次都在事後立即重新執行
`./scripts/verify-clamav.sh` 以及受影響的 `api test:e2e`
套件,並且都順利通過。並未進行任何應用程式或基礎設施設定變更——
這仍然是在約 2GB 記憶體的主機上、在並行負載下執行本堆疊的
真實、反覆出現的運作特性,如今已在連續兩個階段中觀察到
(Phase 4A:一次;Phase 4B:同一任務中兩次),
強化了 Phase 4A 自身延續下來的結論:
**未來 CI 或開發主機為此堆疊配置的規格,應預留超過約 2GB 的記憶體。**

### 最終乾淨執行結果,逐套件列出

```
./scripts/smoke-test.sh
```
```
OK: http://api.drm.localhost/health
OK: http://auth.drm.localhost/realms/drm/.well-known/openid-configuration
OK: http://app.drm.localhost/
OK: http://storage.drm.localhost/
OK: http://127.0.0.1:9000/minio/health/live
OK: redis Health is healthy
OK: gotenberg Health is healthy
OK: clamav Health is healthy
OK: worker State is running
Smoke test passed.
```

```
pnpm --filter api test
```
**5 個套件通過、30 個測試通過**(`user-persistence.spec.ts`、
`audit.service.spec.ts`、`acl.service.spec.ts`、`jwt.strategy.spec.ts`、
`health.controller.spec.ts`)——在最終這次執行中確認結果乾淨,
耗時 120 秒(相較於遇到第 2c 節資源壓力問題的執行耗時 257-259 秒)。

```
pnpm --filter api test:e2e
```
**13 個套件通過、31 個測試通過**,包含 Phase 4B 兩個新增的套件:
`virus-scan.e2e-spec.ts`(真實的 EICAR 拒絕 + 稽核紀錄項目、
真實乾淨檔案的接受)以及 `document-conversion.e2e-spec.ts`
(真實 Office mimetype 上傳 → 真實 worker 接收 → 真實 Gotenberg
轉換 → 真實 MinIO PDF,以魔數位元組驗證,而不僅僅是檢查資料庫欄位)。

```
pnpm --filter api lint
```
乾淨——無錯誤、無警告。

```
pnpm --filter worker lint
```
乾淨——無錯誤、無警告。

```
pnpm --filter web test
```
**1 個檔案通過、2 個測試通過**(`Home.test.tsx`)。

```
./scripts/verify-gotenberg.sh
```
```
Converting test.txt to PDF via Gotenberg...
Confirming the output is a real PDF...
Gotenberg verification passed. Output size: 15097 bytes.
```

```
./scripts/verify-clamav.sh
```
```
Scanning the EICAR test file (must be detected)...
{"isInfected":true,"viruses":["Eicar-Test-Signature"]}
Scanning the clean file (must pass)...
{"isInfected":false,"viruses":[]}
ClamAV verification passed: EICAR detected, clean file passed.
```

全部八項檢查皆通過,兩項真正的程式碼修正(第 2a、2c 節)以及
lint 修正(2b)都已確認就位,而 ClamAV 的 `healthy` 狀態
在整個最終執行序列前後都已確認正常。

## 3. 手動走查

以 `testadmin`(來自 `keycloak/realm-export.json` 中預先建立的
管理員使用者)身分,針對即時的、剛重建完成的堆疊,
透過直接的 HTTP 呼叫(而非自動化套件)進行——先建立一個資料夾
(`POST /folders`),接著向其中執行三次上傳:

**3a. 受感染上傳(EICAR 測試字串,執行時以 base64 解碼,從未以字面值提交):**
```
POST /documents  ->  400 Bad Request
{"message":"Upload rejected: infected file detected (Eicar-Test-Signature)", ...}
```
透過 `GET /folders/:id` 確認:`"documents": []`——從未建立任何
`Document` 資料列。透過 `GET /folders/:id/audit-logs` 確認:
記錄了一筆 `virus_detected` 項目(`resourceType: "folder"`,
`resourceId` 與該資料夾相符),正確地依序排列在雜湊鏈中
`folder_create` 與隨後的 `folder_view` 項目之間。

**3b. 乾淨的 Office mimetype 上傳** (`application/vnd.openxmlformats-officedocument.wordprocessingml.document`):
```
POST /documents  ->  201 Created
"currentVersion": {"previewObjectKey": null, ...}
```
立即被接受,`previewObjectKey` 一開始如預期為 `null`。
每隔一秒輪詢一次 `GET /documents/:id`;`previewObjectKey`
在**1 秒**後被填入(`...-preview-e500e4cd-....pdf`)。
接著直接從 MinIO 擷取該預覽物件(`docker run ... minio/mc cat`,
使用 `drm-api` 限定範圍的憑證),確認為真實的 PDF:
其開頭位元組為 `%PDF-1.7`,總計 14,690 位元組——並非僅僅是
`previewObjectKey` 欄位中的一段字串,而是 `documents` bucket
中真實、可擷取的 PDF 物件。

**3c. 乾淨的純文字上傳** (`text/plain`):
```
POST /documents  ->  201 Created
"currentVersion": {"previewObjectKey": null, ...}
```
被接受,並且透過 `GET /documents/:id` 在等待 6 秒後確認
`previewObjectKey` 依然為 `null`(依照 `DocumentsService` 的
`OFFICE_MIME_TYPES` 允許清單,非 Office mimetype 不會排入
轉換工作佇列——純文字上傳完全不會碰到佇列)。

任務簡報中的全部三種手動走查情境都已實際執行,
結果完全符合預期,且針對的堆疊在此之前片刻並未受到
本任務自身任何自動化測試執行的影響(全新資料夾、全新文件、真實 HTTP 呼叫)。

## 變更的檔案

- `apps/api/test/document-conversion.e2e-spec.ts`——放寬了
  預覽輪詢迴圈(30 → 90 次),以及測試自身的 Jest 逾時
  (40000 → 100000ms),並附上記錄本任務合併執行時測量到的
  真實 17.7 秒 Gotenberg 延遲的註解(第 2a 節)。
- `apps/api/test/virus-scan.e2e-spec.ts`——為 `axios.get` 的
  資料夾讀取呼叫加上型別(`FolderResponse` 擴充了
  `documents?: unknown[]`,符合 `folders.e2e-spec.ts` 既有的模式),
  修正了第 2b 節發現的 lint 錯誤(一個真實的缺口,先前未被發現的原因
  是該檔案從未與 `test:e2e` 在同一次執行中通過 lint 檢查)。
- `apps/api/src/prisma/user-persistence.spec.ts`、
  `apps/api/src/acl/acl.service.spec.ts`、
  `apps/api/src/audit/audit.service.spec.ts`——為每個檔案的
  `afterAll` 掛鉤加上明確的 60000ms 逾時(與各檔案既有的
  `beforeAll` 預算一致),修正了第 2c 節在三個檔案中的其中兩個
  發現的真實 `container.stop()` 逾時問題,並基於三者共享完全相同的
  testcontainers 清理模式,對第三個檔案也預先性地一併套用了修正。
- `docs/superpowers/plans/2026-08-02-phase4b-verification.md`——本文件。

## 結果

所有自動化套件在全新、完整重建的堆疊上一併執行皆通過:
smoke test(9/9 項檢查通過);5/5 個 API 單元測試套件、
30/30 個單元測試通過;13/13 個 API e2e 套件、31/31 個 e2e
測試通過(包含本階段兩個新套件 `virus-scan` 與
`document-conversion`,後者已針對 MinIO 中真實 PDF 的魔數位元組驗證,
而不僅僅是資料庫欄位);API lint 乾淨;worker lint 乾淨;
1/1 個 web 套件、2/2 個 web 測試通過;Gotenberg 轉換已針對
真實文件驗證;ClamAV 已針對真實 EICAR 偵測與乾淨檔案通過雙重驗證。

三個真實的、僅在整合層級才會出現的問題,如本任務簡報所預期地,
被發現並修正——在合併套件負載下,對於真實(經測量,而非假設性)
基礎設施延遲而言過於緊繃的測試逾時(第 2a 節);一個從未與
`test:e2e` 在同一次執行中通過 lint 檢查的 e2e 測試檔案中的
lint 缺口(第 2b 節,與 Phase 4A 任務 6 發現的同一類問題);
以及三個以 testcontainer 為基礎的單元測試規格檔中的
`afterAll` 掛鉤逾時缺口(第 2c 節)。此外,ClamAV 在本任務
反覆執行合併測試的過程中,因主機真實的記憶體壓力而當機了兩次
(第 2d 節)——兩次都透過 Phase 4A 既定的
`docker compose restart clamav` 程序順利恢復,未進行任何
程式碼或設定變更,進一步強化了該項發現延續下來的結論:
本主機約 2GB 的記憶體對於此堆疊的並行負載而言確實規格不足。

手動走查確認了設計規格中全部三種上傳結果,在剛重建完成的堆疊上
皆能正確地端對端運作:受感染的上傳在任何儲存或資料庫寫入之前
即被拒絕,並依照 Phase 3「僅成功才稽核」原則的一項刻意例外
被記錄下來;乾淨的 Office mimetype 上傳立即被接受,
並在數秒內非同步地取得真實、經驗證的 PDF 預覽;
乾淨的純文字上傳被接受,且正確地完全不會進入轉換流程。

Phase 4B 的上傳流程——任何寫入之前的同步 ClamAV 病毒掃描,
以及透過 `apps/worker` 與 Gotenberg 進行的非同步 Office 轉 PDF
轉換——已驗證能在完全全新的 `docker compose up` 之下,
與跨越 Phase 1 到 Phase 4A 建置完成的完整既有堆疊一起正常協同運作。
