# Phase 4A 驗證

針對 Phase 4A（背景工作基礎設施：Redis +
BullMQ、`apps/worker`、Gotenberg、ClamAV）的完整套件驗證，在一個完全全新的
stack（`docker compose down -v && docker compose up -d --build`）上執行，確保個別任務層級測試（任務 1-5）遺留的任何狀態都不會延續下來，並讓每一個自動化套件一起執行，而非各自獨立執行。

## 1. 擴充 `scripts/smoke-test.sh`

Phase 4A 新增的服務（`redis`、`gotenberg`、`clamav`、`worker`）都沒有將 HTTP
port 發布到 host，因此腳本現有的 `check()` helper（單純的 HTTP GET）不適用於它們。在信任計畫草稿中 `check_container_state()` 片段之前，先針對這台 host 實際的 Docker
Compose（`v5.3.1`）即時驗證了其欄位／數值假設：

```
$ docker compose ps --format '{{.Service}} {{.State}} {{.Health}}'
api running
clamav running healthy
gotenberg running healthy
...
worker running
```

已確認：無論是否有 healthcheck，`{{.State}}` 對每個服務都回報 `running`；`{{.Health}}` 對有定義 healthcheck 的服務會回報
`healthy`/`unhealthy`/`starting`，對沒有 healthcheck 的服務則為空。這與計畫的預期相符，因此加入了該 helper，並做了一項調整——加入一個 `field` 參數，讓同一個函式對三個真正有 healthcheck 的服務（`redis`、`gotenberg`、`clamav`）檢查
`Health`，對沒有 healthcheck 的 `worker`（根據計畫自身的說明，它是純粹的背景
BullMQ consumer）則檢查 `State`：

```bash
check_container_state "redis" "Health" "healthy"
check_container_state "gotenberg" "Health" "healthy"
check_container_state "clamav" "Health" "healthy"
check_container_state "worker" "State" "running"
```

在進入下一步之前，先針對已經啟動中的 stack（重建之前）進行驗證，以便在進入耗時更長的全新重建流程之前，先抓出 helper 本身的錯誤。

## 2. 全新的整體 stack 重建

開始之前 host 磁碟使用率為 79%（`df -h /`）——低於約 85% 的門檻，因此不需要事先清理。

```
docker compose down -v && docker compose up -d --build
```

全部 14 個 DRM 容器（`traefik`、`postgres`、`redis`、`keycloak`、`api`、
`worker`、`gotenberg`、`clamav`、`web`、`openbao`、`openbao-init`、`kes`、
`minio`、`minio-init`）都被銷毀，包含具名 volume，並重新建立。透過
`docker ps -a | grep drm`（空結果，exit 1）與
`docker volume ls | grep drm`（空結果，exit 1）確認沒有任何東西在 `down
-v` 之後存活下來，並且每個容器在 `docker compose ps` 中的 `CreatedAt`
都與 `up -d --build` 執行的那一刻相符（全部都在 UTC 01:26:03-01:26:06
之間建立）。

**ClamAV 首次開機下載病毒定義：7 分 41 秒。**
這是直接從 `docker inspect drm-clamav-1` 的健康檢查日誌測量出來的：容器於 `2026-08-02T01:26:03Z` 建立，第一次成功的健康檢查（`Clamd is up`，exit
0）發生在 `2026-08-02T01:33:44Z`。比任務 5 在同一台 host 上觀察到的約 13 分鐘更快——這較可能是 freshclam CDN／網路狀況的變異，而非這個階段所做的任何變更所致；兩者都遠在 `docker-compose.yml` 中設定的 900 秒
`start_period` 預算之內。Keycloak 的冷啟動（全新 volume，完整 schema
遷移加上 realm 匯入）在 `/realms/drm/.well-known/openid-configuration`
開始回應之前花了大約 3.5 分鐘（`01:31:51` Quarkus augmentation 完成 →
`01:34:52` realm 匯入完成），與先前各階段的觀察落在相同範圍內。

## 3. 一起執行的自動化套件——以及一個真正的整合層級失敗

依照任務簡報的要求，所有套件都一起執行而非只個別執行，目的正是要找出先前各階段透過這種方式才能發現的整合層級問題。這次執行找到了兩個問題，兩者都是真實的，而非假設性的：

### 3a. `apps/api` lint 失敗（一個真正的任務 3 缺口，在此首度曝露）

在全新重建之後、`smoke-test.sh` 與 `api test`／`test:e2e` 都通過之後，立即執行的第一次
`pnpm --filter api lint`，失敗了：

```
apps/api/test/jobs.e2e-spec.ts
  22:11  error  Unsafe assignment of an `any` value
  25:26  error  Unsafe member access .workerHostname on an `any` value
  26:19  error  Unsafe member access .workerHostname on an `any` value
```

`job.waitUntilFinished()`（BullMQ）回傳的是 `any`——它從 queue 端沒有辦法得知 worker
processor 的回傳型別。任務 3 的 e2e 測試（`jobs.e2e-spec.ts`）直接使用了那個
`any` 值，`@typescript-eslint/no-unsafe-*` 正確地標記了它，但 `test:e2e`
本身並不會捕捉到這個問題（Jest 在執行期並不會對斷言做型別檢查）。這個問題自
任務 3 以來一直未被發現，顯然是因為 lint 從未和引入該檔案的 e2e 套件在同一次執行中跑過。

**修正方式：** 新增一個明確的 `HealthCheckResult` 介面，對應
`apps/worker/src/health-check/health-check.processor.ts` 真正的回傳型別
（`{ pong: true; processedAt: string; workerHostname: string }`），並將
await 得到的結果轉型為該介面，而不是停用該規則。變更之後重新執行了
`test:e2e`（仍為 11/11 套件、27/27 測試）與 `lint`（乾淨）以確認沒有任何回歸。

### 3b. ClamAV 在 host 記憶體壓力下於執行期間當機（基礎設施問題，非程式碼問題）

在一次完整合併執行（smoke-test → api test → api
test:e2e → lint → web test → verify-gotenberg → verify-clamav，全部依序在同一次執行中完成）進行到一半時，`verify-clamav.sh` 失敗：

```
Error: connect ECONNREFUSED 172.19.0.3:3310
```

而 `smoke-test.sh` 新增的 `clamav` 健康檢查，在同一次執行中的稍早時刻就已經開始失敗（`FAIL: clamav Health is
'unhealthy'`）。調查（`docker inspect`、`docker exec ... ps aux`、
`free -h`）找出了根本原因：這台 host 只有 1.9GiB 的 RAM，而在全新重建的
docker build 加上同時進行的測試／驗證負載之後，swap 使用量來到
3.3/3.8GiB（幾乎耗盡）。容器內 `clamd` 的行程已經進入 `Z`（zombie）狀態——它是真的當機了，而不只是變慢。這是一個 host 資源競爭的問題，並非這個階段的程式碼或設定所引入的 bug；ClamAV 自身的
`healthcheck`（`clamdcheck.sh`，來自任務 5）正確地偵測到並回報為
`unhealthy`，而不是靜靜地放行，這正是這個健康檢查存在的目的。

**修正方式：** `docker compose restart clamav`。大約 5 秒後恢復為
`healthy`（`ERROR: Unable to contact server` 於 02:18:51 →
`Clamd is up` 於 02:18:56）——之所以這麼快，是因為病毒定義存放在容器自己可寫入的層，而不是會被 `down -v` 清除的 volume，所以單純的
`restart`（不同於完整重建）並不會觸發另一次長達數分鐘的 freshclam 下載。不需要對應用程式或基礎設施設定做任何變更；這是在記憶體受限的 host
上、於同時負載下執行這個 stack 時的一項真實運作特性，值得記錄下來以供日後參考：**未來 CI 或開發 host 為這個 stack 規劃容量時，應該預留超過約
2GB 的 RAM**，否則在記憶體壓力下 ClamAV 很可能是第一個遭殃的服務（它是這裡唯一一個持有大型記憶體內簽章資料庫的服務）。

### 兩項修正之後的最終乾淨執行結果

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
**5 個套件通過，30 個測試通過**（`user-persistence.spec.ts`、
`audit.service.spec.ts`、`acl.service.spec.ts`、`jwt.strategy.spec.ts`、
`health.controller.spec.ts`）。

```
pnpm --filter api test:e2e
```
**11 個套件通過，27 個測試通過**，包含任務 3 的
`jobs.e2e-spec.ts`（真正經由 Redis 傳送到 worker 容器的工作往返流程）——`whoami`、`folders`、`permissions`、`storage`、
`documents-read`、`documents-write`、`jobs`、`audit-folders`、
`audit-documents`、`audit-permissions`、`audit-endpoints`。

```
pnpm --filter api lint
```
乾淨——沒有錯誤，沒有警告。

```
pnpm --filter web test
```
**1 個檔案通過，2 個測試通過**（`Home.test.tsx`）。

```
./scripts/verify-gotenberg.sh
```
```
Converting test.txt to PDF via Gotenberg...
Confirming the output is a real PDF...
Gotenberg verification passed. Output size: 14963 bytes.
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

全部七個套件在同一個全新重建的 stack 上依序一起呈現綠燈，並且在執行前後都確認了 ClamAV 的 `healthy` 狀態。

## 變更的檔案

- `scripts/smoke-test.sh`——新增了 `check_container_state()`，這是一個第二個 helper（與既有的 HTTP `check()` 並存），會讀取
  `docker compose ps --format`，並為 `redis`、
  `gotenberg`、`clamav`（皆透過 `Health`）以及 `worker`（透過 `State`，
  因為它沒有 healthcheck）新增四項檢查。
- `apps/api/test/jobs.e2e-spec.ts`——新增了明確的
  `HealthCheckResult` 介面，並將 `job.waitUntilFinished()` 的結果轉型為該介面，修正了這次整合層級執行才曝露出來的 3 個
  `@typescript-eslint/no-unsafe-*` lint 錯誤（第 3a 節）。
- `docs/superpowers/plans/2026-08-01-phase4a-verification.md`——本文件。

## 結果

所有自動化套件在一個全新、完整重建的 stack 上一起通過：smoke
test（9/9 項檢查，包含針對 Phase 4A 各服務的 4 項新容器健康檢查）；5/5
API 單元套件、30/30 單元測試；11/11 API e2e 套件、
27/27 e2e 測試（包含真正的 Redis→worker 工作往返流程）；API
lint 乾淨；1/1 web 套件、2/2 web 測試；Gotenberg 轉換已針對真實文件驗證；ClamAV 已針對真實的 EICAR
偵測與乾淨檔案通過兩者都驗證過。將所有項目一起執行、而非各自獨立執行，正如這項任務簡報所預期的那樣，發現了兩個真實的、僅在整合層級才會出現的問題：任務 3 e2e 測試中一個真正的 lint
缺口（已在程式碼中修正），以及在同時負載下、host 記憶體壓力造成的 ClamAV 當機（已透過
`docker compose restart clamav` 在操作層面修正，並將 RAM 容量規劃的發現記錄於上方，供未來 host／CI 容量規劃參考）。這次執行中，ClamAV 全新首次開機的病毒定義下載花了 7 分 41 秒。Phase 4A 的背景工作基礎設施——Redis、BullMQ、worker
容器、Gotenberg 與 ClamAV——已驗證能在完全全新的 `docker compose up`
下、與既有完整 stack 一起正常運作。
