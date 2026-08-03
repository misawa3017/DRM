# OpenAPI 文件設計

## 背景

`apps/api`（NestJS）目前沒有任何 OpenAPI/Swagger 整合。它暴露了 6 個控制器與 18 個端點（documents、folders、permissions、audit、users、health），除了 `health` 之外全部都受 Keycloak 簽發的 JWT Bearer token 保護（`AuthGuard('jwt')`）。請求由 3 個既有的 `class-validator` DTO（`CreateDocumentDto`、`CreateFolderDto`、`GrantPermissionDto`）驗證；程式碼庫中從未在任何地方正式定義過任何回應結構——控制器回傳的就是其服務方法所回傳的內容（通常是 Prisma model 的結構，或一個小型的衍生物件）。

## 目的

打下扎實的 OpenAPI 基礎，主要是為了讓建構內部 React 前端的人員能有一份準確、可瀏覽的參考文件，而不必透過閱讀控制器／服務原始碼來推敲請求／回應結構。目前尚未確定具體的外部整合使用情境，因此這項工作刻意只產出一份完整、正確的規格，而不對任何外部曝露的決策做出承諾——這個選擇之後可以再做，不需要重做這份工作。

## 架構

使用官方的 `@nestjs/swagger` 套件，並啟用其 **CLI plugin**（`nest-cli.json`：`"plugins": ["@nestjs/swagger"]`）。此外掛會在編譯期內省既有的 TypeScript 型別與 `class-validator` 裝飾器，並自動產生大部分的 Swagger 中繼資料，因此 3 個既有的請求 DTO 幾乎不需要手動加註——只有在某個欄位需要範例值或超出型別／驗證器已隱含意義的描述時，才手動加上 `@ApiProperty()`。這是 NestJS 官方推薦的做法，相較於手動為每個欄位加註，能將樣板程式碼與重複內容降到最低，也不需要改變專案現有的編譯方式（`nest build`）。

## 範圍

全部 6 個控制器、全部 18 個端點：

| 控制器 | 端點 |
|---|---|
| `documents` | `POST /documents`、`POST /documents/:id/versions`、`GET /documents/:id/versions`、`GET /documents/:id`、`GET /documents/:id/download` |
| `folders` | `POST /folders`、`GET /folders/:id` |
| `permissions` | `POST /folders/:id/permissions`、`GET /folders/:id/permissions`、`DELETE /folders/:id/permissions/:permissionId`、`POST /documents/:id/permissions`、`GET /documents/:id/permissions`、`DELETE /documents/:id/permissions/:permissionId` |
| `audit` | `GET /folders/:id/audit-logs`、`GET /documents/:id/audit-logs`、`GET /audit-logs/verify` |
| `users` | `GET /whoami` |
| `health` | `GET /` |

每個端點都會有一個對應其服務方法實際回傳內容的回應 DTO 類別（例如 `FolderResponseDto`、`DocumentResponseDto`、`DocumentVersionResponseDto`、`PermissionResponseDto`、`AuditLogResponseDto`，以及針對 `/audit-logs/verify` 的鏈驗證結果 DTO 等——確切的集合與欄位清單會在撰寫計畫時，透過閱讀各服務方法的實際回傳結構來確定），並透過 `@ApiResponse({ status, type })` 加註，涵蓋每個端點實際可能拋出的真實錯誤狀態碼（400/403/404/413/503 等，依 Phase 2B/3/4B 既有例外處理實際會產生的內容而定）。

這純粹是文件工作：回應 DTO 只是描述既有的回傳結構，不會改變任何端點的實際行為、狀態碼或酬載內容。不涉及任何服務層或商業邏輯變更。

## 身份驗證

透過 `DocumentBuilder().addBearerAuth()` 註冊一個全域的 `Bearer` 安全性配置方案，並為目前受 `AuthGuard('jwt')` 保護的每一個控制器（除 `health` 外全部）加上 `@ApiBearerAuth()`。這讓 Swagger UI 的「Authorize」按鈕能夠對真實的 Keycloak 簽發存取 token 生效，讓開發者可以在 UI 中登入一次，之後就能嘗試真實的請求，而不必手動組出標頭。

## 曝露範圍

`SwaggerModule.setup()`（以及它連帶註冊的 JSON 規格端點，與 UI 一起）只有在 `process.env.NODE_ENV !== 'production'` 時才會掛載。在正式環境中，該路由完全不會被註冊——不是「存在但被擋下」，而是真正不存在，將機密文件系統的攻擊面降到最低。會檢查／更新 `docker-compose.yml` 中 `api` 服務的環境變數，確保本機／開發用堆疊有正確設定 `NODE_ENV`，讓文件在該處可以被存取。是否要在正式環境曝露這份文件，或提供給真實的外部整合夥伴，是明確留待未來的決策，不在本次範圍內。

## 測試／驗證

依循本專案既有的「對照真實運行中的堆疊進行驗證」慣例（不模擬基礎設施，也不把建置成功當作正確性的證明）：

- 啟動開發堆疊，取得真實的 JSON 規格端點，確認它在結構上是合法的 OpenAPI 3.0（而不只是「回傳 200 OK」）。
- 開啟真實的 Swagger UI，透過「Authorize」按鈕使用真實的 Keycloak 簽發 token 登入，並實際操作至少 1-2 個端點（例如建立一個資料夾、上傳一份文件），確認文件中記載的請求／回應結構與真實運行行為相符，而不只是 DTO 宣稱的內容。
- 確認在 `NODE_ENV=production` 時，`/api-docs`（以及 JSON 規格路由）確實回傳 404。
- 執行完整既有的 lint/build/unit/e2e 套件，確認新增的回應 DTO 沒有在任何地方造成回歸問題。

## 範圍之外

- 任何對實際端點行為、請求／回應酬載結構或狀態碼的變更——本階段只是正式記錄既有的內容。
- 決定是否／如何將此文件曝露給真實的外部整合方，或從規格產生前端客戶端 SDK——兩者都明確延後至有具體需求時再決定。
- API 版本管理策略。
