# 機密文件管理系統（DRM）設計文件

- 日期：2026-07-31
- 狀態：已核准，待轉入實作計畫

## 背景與範疇

公司內部使用的機密文件管理系統，目標使用規模為中型公司（50-500 人）。第一版須具備：角色權限控制、稽核軌跡、文件版本管理、加密儲存、到期/自動失效、動態水印。部署於公司內部 PVE VM，以 Docker Compose 起步，未來遷移至 K8s。

## 技術棧

- 前端：React（Vite SPA）
- 後端：NestJS（Node.js）
- 資料庫：PostgreSQL
- 物件儲存：MinIO
- KMS：MinIO KES + OpenBao（見下方「關於 KMS」）
- 身份驗證：Keycloak（作為 identity broker，聯邦 Google/Microsoft OIDC）
- 背景工作：Redis + BullMQ
- 文件轉檔：Gotenberg（Office → PDF）
- 病毒掃描：ClamAV
- 反向代理：Traefik

## 系統架構與元件

Monorepo（pnpm workspaces）：

- `apps/web` — React SPA
- `apps/api` — NestJS REST API
- `apps/worker` — 背景工作處理程序（轉檔、水印、到期掃描、病毒掃描）
- `packages/shared` — 共用型別/DTO

服務清單（Docker Compose，之後遷移 K8s）：

| 服務 | 用途 |
|---|---|
| web | React SPA，靜態檔由 Nginx/Traefik 服務 |
| api | NestJS REST API |
| worker | 背景工作：轉檔、動態水印、到期掃描、病毒掃描 |
| postgres | 主資料庫 |
| minio | 物件儲存（原始檔案 + 各版本） |
| kes (MinIO KES) | MinIO 與 KMS 之間的中介層，提供 SSE-KMS 加密 |
| openbao | 實際的 KMS/密鑰管理後端；同時作為一般密鑰管理（DB 密碼、JWT 簽章金鑰等） |
| keycloak | 身份驗證 broker，聯邦 Google/Microsoft OIDC，管理內部角色/群組 |
| redis | BullMQ 背景工作佇列 |
| gotenberg | Office 文件（Word/Excel/PPT）轉 PDF，供預覽/水印用 |
| clamav | 上傳檔案病毒掃描 |
| traefik | 反向代理 + TLS |

**關於 KMS**：OpenBao 與 MinIO KES 並非二選一，而是搭配使用——KES 是 MinIO 用來做 SSE-KMS 加密的中介服務，需要一個實際的密鑰後端，該後端即為 OpenBao。架構為 `MinIO → KES → OpenBao`。

## 資料模型與權限設計

核心資料表：

- `users` — 本地使用者對照表，與 Keycloak 的 `sub` 對應，同步 email、部門等業務欄位（身份驗證仍由 Keycloak 負責）
- `folders` — 樹狀結構（`parent_id`）
- `documents` — 文件邏輯記錄，關聯目前版本、到期時間（`expires_at`）、狀態（active/expired）、`watermark_enabled`（布林值，預設 true，具 `manage` 權限者可個別關閉）
- `document_versions` — 各版本實際資料：MinIO object key、檔案雜湊（SHA-256）、mime type、上傳者、上傳時間
- `permissions`（ACL）— `resource_type`（folder/document）、`resource_id`、`principal_type`（user/group）、`principal_id`、`permission_level`（view/download/edit/manage）
- `audit_logs` — 每筆操作（上傳/檢視/下載/編輯/刪除/權限變更/到期）記錄 actor、資源、IP、時間，並包含雜湊鏈（每筆記錄含前一筆的 hash）以達防竄改效果

**權限解析邏輯**：文件若無明確 ACL，向上查詢所屬資料夾的 ACL，逐層向上直到找到授權或到頂層仍找不到則預設拒絕。系統角色（Admin/DeptManager/Employee，同步自 Keycloak realm role）作為全域覆寫（例如 Admin 略過 ACL 檢查）。

## 關鍵流程

**上傳**：Client → API（multipart）→ 暫存 → ClamAV 掃描 → 若為 Office 檔案，worker 透過 Gotenberg 轉成 PDF（供預覽/水印用，原始檔仍保留）→ 原始檔與 PDF 版本寫入 MinIO（SSE-KMS 加密）→ 建立 `documents`/`document_versions` 記錄 → 寫入 audit log。

**檢視/下載**：API 檢查 ACL（含資料夾繼承）→ 檢查是否已到期 → 從 MinIO 取出檔案 → 若該文件 `watermark_enabled` 為 true，即時用 `pdf-lib` 疊加動態水印（使用者 email、時間戳、IP）後回傳；水印不預先產生、每次請求即時疊加 → 記錄 audit log（view 與 download 分開記錄）。是否加水印由具 `manage` 權限者針對個別文件或資料夾控制。

**版本管理**：上傳新版本時，MinIO 用新的 object key 存放（不覆蓋），`document_versions` 新增一筆並指向該文件，`documents.current_version_id` 更新；舊版本依權限仍可回溯查閱。

**到期/失效**：worker 排程（BullMQ repeatable job）每日掃描 `expires_at < now` 的文件，標記為 `expired`，之後所有存取請求一律拒絕（ACL 記錄保留、不刪除，方便之後複核或延期）。

**稽核軌跡**：所有動作統一寫入 `audit_logs`，含雜湊鏈防竄改。

## 部署策略

- **v1（PVE VM + Docker）**：單一 `docker-compose.yml` 管理所有服務，環境變數與敏感設定透過 `.env` + OpenBao 注入，不寫死在 image 裡。
- **K8s 就緒設計**：API/worker 全部設計成無狀態（session 用 JWT，不依賴本機檔案系統），檔案一律經 MinIO、不落地在容器內，方便之後直接寫 Helm chart 或 K8s manifest 而不用重構程式邏輯。
- **備份**：Postgres 定期 pg_dump + MinIO bucket replication/定期快照（細節留待後續）。

## 測試策略

- **API**：NestJS 內建測試模組做單元測試；關鍵邏輯（ACL 繼承解析、到期判斷、水印疊加、audit log 完整性）另外寫整合測試，透過 Testcontainers 起 Postgres/MinIO 做真實資料庫/物件儲存測試，不 mock 掉這些關鍵路徑。
- **前端**：關鍵頁面（上傳、權限設定、文件檢視）用 React Testing Library 做互動測試。
- **E2E（Playwright）**：針對少量但關鍵的完整使用者流程做瀏覽器層級測試，涵蓋 Testcontainers 與 RTL 都測不到的跨系統路徑，包括：Keycloak OIDC 登入導轉、上傳文件 → 檢視 → 確認回傳檔案確實疊加動態水印、無權限使用者存取遭拒絕、文件到期後存取遭拒絕。測試環境透過 docker-compose 整套服務（web/api/keycloak/postgres/minio 等）啟動後執行，不 mock 任何一層。

## 範疇之外（留待未來版本）

- 多租戶/SaaS 化
- 進階全文檢索（Elasticsearch/Meilisearch）
- 單一登出（SLO）以外的進階 Keycloak 功能（如 MFA 政策細節）
