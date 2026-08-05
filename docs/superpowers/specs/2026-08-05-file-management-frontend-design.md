# 檔案管理前端設計文件（第一階段：核心瀏覽）

- 日期：2026-08-05
- 狀態：已核准，待轉入實作計畫
- 前置文件：[[2026-07-31-confidential-document-management-design.md]]（整體系統設計）

## 背景

`apps/api` 的 `documents`/`folders`/`permissions` 模組已具備完整的 CRUD 邏輯，但 `apps/web` 目前只有登入/登出與 `/whoami` 頁面，沒有任何檔案瀏覽、上傳、下載的介面。使用者登入後除了看到自己的帳號資訊之外，沒有地方可以管理檔案。本文件規劃第一階段的前端開發：核心檔案瀏覽功能。

## 範疇

**這次做的：**
- 資料夾瀏覽（含頂層）、麵包屑導覽
- 建立資料夾（沿用現有權限規則：頂層限 admin，非頂層需對父層有 `edit` 權限）
- 上傳新文件 / 對既有文件上傳新版本
- 文件詳情頁：metadata、版本歷史、下載

**這次不做（留到之後）：**
- 權限管理 UI（grant/revoke ACL）——留到下一輪設計
- 搜尋、rename/move/delete——後端目前也還沒有對應的 API
- 站內 PDF 預覽 / 動態浮水印顯示——後端 `download` 端點目前是直接串流原始檔，浮水印邏輯尚未接上，故先只做下載不做預覽
- 上傳者姓名顯示——目前只有 `GET /whoami` 能查自己的身分，沒有批次查其他使用者的 API，版本歷史裡的「上傳者」先顯示 user ID，之後有查詢 API 再補上顯示姓名

## 架構與技術選型

### 路由

新增 `react-router`（`^6.x`）。路由規劃：

- `/` — 頂層資料夾清單（呼叫新的 `GET /folders`）
- `/folders/:id` — 資料夾內容（沿用既有 `GET /folders/:id`，回傳子資料夾 + 文件）
- `/documents/:id` — 文件詳情頁（`GET /documents/:id` + `GET /documents/:id/versions`）

未登入時仍走現有 `App.tsx` 的 OIDC 導轉邏輯，登入後才進入這組路由。

### UI 元件庫

導入 `shadcn/ui` + Tailwind CSS。只裝這次功能會用到的元件（Table、Dialog、Button、Breadcrumb、Toast），不整包導入。

### 資料擷取

導入 `@tanstack/react-query`。統一寫一個 `apps/web/src/api/client.ts`：內部用 `fetch`，自動帶 `Authorization: Bearer <token>`（從 `react-oidc-context` 的 `auth.user.access_token` 取得），非 2xx 一律 throw，交給 React Query 的 `isError`/`error` 統一接住。

### 後端小改動：`GET /folders`

新增一支端點，邏輯比照 `FoldersService.getWithContents`：找出使用者對哪些頂層資料夾（`parentId IS NULL`）有 `view` 權限，回傳清單。沒有可見的頂層資料夾（含非 admin 的一般情況）回**空陣列 + 200**，不是 403，避免頂層清單頁直接掛掉。

## 頁面／元件結構

新增檔案（`apps/web/src/`）：

```
routes/
  RootFolders.tsx        // "/" — 呼叫 GET /folders，清單 + 「新增資料夾」按鈕（僅 admin 可見）
  FolderView.tsx          // "/folders/:id" — 呼叫 GET /folders/:id，顯示子資料夾表格 + 文件表格 + 麵包屑 + 上傳按鈕
  DocumentView.tsx         // "/documents/:id" — 呼叫 GET /documents/:id + /versions，顯示 metadata、版本表、下載按鈕、「上傳新版本」按鈕
components/
  Breadcrumb.tsx           // 從目前 folder 資料組出路徑
  UploadDialog.tsx          // shadcn Dialog + <input type="file">，共用於「上傳新文件」與「上傳新版本」
  CreateFolderDialog.tsx
api/
  client.ts                 // fetch wrapper（帶 Authorization header、統一錯誤處理）
  documents.ts               // getDocument, listVersions, uploadDocument, uploadVersion, downloadUrl
  folders.ts                 // listRootFolders, getFolder, createFolder
```

### 麵包屑的資料流

`GET /folders/:id` 只回傳該資料夾自己＋直接子項，不含祖先鏈。`Breadcrumb` 元件會拿到目前 folder 的 `parentId`，用 react-query 逐層 `useQuery(['folder', parentId])` 往上查，一路查到 `parentId === null` 為止，組出「Root / A / B」路徑。因為 react-query 有 cache，同一個資料夾在不同頁面間切換不會重複打 API。

### 下載

`download` 端點需要 `Authorization` header（不接受 query string token），因此採用「fetch → blob → `URL.createObjectURL` → 觸發隱藏 `<a>` 的 click」的標準模式觸發瀏覽器下載，而非直接用 `<a href>` 導向端點。

## 錯誤處理

- **401**（token 過期）→ 交給 `react-oidc-context` 既有機制處理（自動 silent renew 或導回登入），元件層不特別處理
- **403**（無權限）→ react-query 的 `error` 顯示成「你沒有存取這個資料夾/文件的權限」，不當成程式錯誤處理
- **404**（資料夾/文件不存在，例如網址直接輸入錯的 id）→ 顯示「找不到這個項目」+ 回頂層的連結
- **上傳失敗**（超過 200MB 限制、ClamAV 擋毒、網路中斷）→ `UploadDialog` 內顯示錯誤訊息，不關閉對話框，讓使用者可以重試
- **`GET /folders` 回空陣列** → 前端顯示「目前沒有你可以存取的資料夾，請聯絡管理員」

## 測試策略

沿用專案既有的三層（Jest 單元/整合、RTL、Playwright e2e）：

- **後端**：`GET /folders` 補一支 e2e/integration 測試，驗證 ACL 過濾邏輯（有權限的人看得到、沒權限的人看不到、admin 看全部）
- **前端 RTL**：`FolderView`、`DocumentView`、`UploadDialog`、`Breadcrumb` 各補互動測試，沿用專案既有的 mock fetch 模式
- **Playwright e2e**：延伸既有登入流程，加一條「登入 → 進入頂層 → 建資料夾 → 上傳文件 → 進文件詳情頁 → 下載 → 驗證檔案內容」的完整路徑測試——這是 RTL/單元測試測不到的跨系統路徑，真的打 MinIO/Postgres，不 mock 任何一層。

## 範疇之外（留待下一輪）

- 權限管理 UI（grant/revoke ACL）
- 搜尋、rename/move/delete
- 站內 PDF 預覽、動態浮水印顯示
- 上傳者姓名顯示（需要新的使用者查詢 API）
