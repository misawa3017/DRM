# 全域搜尋設計文件

- 日期：2026-08-09
- 來源：[[2026-08-06-frontend-backlog.md]] 第 1 節「搜尋——資料夾/文件清單沒有搜尋功能」

## 背景

目前資料夾與文件清單完全沒有搜尋功能，使用者只能一層一層點進資料夾找東西。這份文件補上一個全域搜尋：不管目前在哪個頁面，都能搜到整個系統裡（自己有權限看到的）任何資料夾或文件。

## 範疇

- 只比對資料夾/文件的「名稱」，不做內容搜尋（文件內文全文檢索不在範疇內）。
- 不做相關性排序、不做搜尋建議/自動完成、不做搜尋歷史紀錄。
- 結果上限 50 筆，不做分頁（跟現有 `listRootFolders`、`getWithContents` 一致，沒有分頁機制）。

## 後端

### `GET /search?q=<關鍵字>`

新增 `SearchModule`（`SearchController` + `SearchService`），掛在既有的 `AuthGuard('jwt')` 底下，跟其他 controller 一致。

- **查詢邏輯**：對 `Folder`、`Document` 兩張表各自執行 `name: { contains: q, mode: 'insensitive' }` 搭配 `deletedAt: null`。因為是直接對兩張表做名稱比對（不透過 `parentId` 遞迴），所以不需要走訪整棵樹。
- **權限過濾**：逐筆呼叫既有的 `AclService.can(user, resourceType, resourceId, 'view')`，只保留使用者有檢視權限的項目（admin 角色會在 `AclService.can` 內自動略過檢查，跟其他端點行為一致）。
- **路徑解析**：每筆結果附上完整路徑字串，格式與既有 `PermissionsService.resolveFolderPath` 完全一致（例如 `Root`、`Root / 財務 / 保險`）。`SearchService` 自己實作一份小型、私有的 `resolveFolderPath`（走 `parentId` 往上找，組成 `Root / ...` 字串），不與 `PermissionsService` 共用程式碼——這份邏輯只有十幾行，維持模組各自獨立比硬要抽共用模組更符合這個專案目前的慣例（`AclService`、`AuditService` 這種真正被多處重用的邏輯才獨立成 service）。
- **空查詢**：`q` 是空字串或只有空白時，直接回傳空陣列，不查資料庫。
- **結果上限**：ACL 過濾「之後」，把 folders 和 documents 合併，取前 50 筆（不在資料庫查詢階段就限制筆數——這個系統資料量還小，先過濾清楚再裁切比較簡單，跟 `listRootFolders` 現有「先撈全部、逐筆檢查權限」的做法一致）。
- **排序**：先資料夾、後文件；資料夾內、文件內各自依名稱字母序（`orderBy: { name: 'asc' }`）。不做相關性排序。

### 回傳格式

```ts
interface SearchResultItem {
  resourceType: 'folder' | 'document';
  resourceId: string;
  name: string;
  path: string; // 不含自己的名字，跟 PermissionsService 的 resourcePath 慣例一致
}
```

### 測試（e2e，比照現有 `folders.e2e-spec.ts`／`permissions.e2e-spec.ts` 風格）

- 有檢視權限的資料夾/文件會出現在結果裡，沒有權限的不會
- 大小寫不敏感（搜尋 `finance` 找得到 `Finance部`）
- 軟刪除的資料夾/文件不會出現在結果裡
- 空字串或空白查詢回傳空陣列，且不對資料庫發出多餘查詢（可用 mock/spy 驗證，或至少驗證行為正確）
- 路徑格式正確（巢狀資料夾範例）
- admin 不需要任何授權就能搜到系統中所有項目

## 前端

### Navbar 搜尋框

在 `Navbar.tsx` 現有的麵包屑區塊（`navbar-crumb` 那個 `flex-1` 容器）旁邊，新增一個固定寬度的搜尋輸入框（例如 `w-56`），麵包屑維持原本的功能與版面，兩者並排在同一個 flex 容器裡，不互相取代。

- 輸入框搭配一個搜尋圖示按鈕；按 **Enter** 或點擊搜尋圖示才會觸發導航到 `/search?q=<關鍵字>`（不做輸入即搜尋的 debounce 版本）。
- 空白或只有空格的輸入不觸發導航。
- 導航後，若使用者已經在 `/search` 頁面且輸入新的關鍵字，一樣觸發導航（React Router 對同路由不同 query string 的導航會正常觸發重新渲染／重新查詢，因為 `Search.tsx` 會把 `q` 當作 query key 的一部分）。

### `/search` 結果頁（`apps/web/src/routes/Search.tsx`）

- 從 URL 的 `q` query 參數讀取關鍵字（用 React Router 的 `useSearchParams`）。
- 呼叫新的 `searchResources(q, accessToken)` API 函式（`apps/web/src/api/search.ts`），對應後端的 `GET /search?q=`。
- 三種狀態：
  - 沒有 `q`（或 `q` 是空字串）：顯示提示文字「請輸入關鍵字搜尋」，不發送請求。
  - 有 `q` 但查無結果：顯示「找不到符合的項目」。
  - 有結果：清單顯示每一筆的圖示（資料夾/文件圖示，比照 `FolderView.tsx` 現有用法）、名稱、路徑（路徑用較小、較淡的文字顯示在名稱下方，比照 `PermissionsTable.tsx` 顯示 `resourceName`/`resourcePath` 的方式）。點擊整列導航到 `/folders/:id` 或 `/documents/:id`。

### 測試（vitest，逐 task TDD）

- Navbar：輸入關鍵字按 Enter 會導航到 `/search?q=<關鍵字>`；空白輸入不會觸發導航。
- `Search.tsx`：no-query 提示狀態、loading 狀態、空結果狀態、有結果時正確顯示名稱/路徑並可點擊導航（資料夾與文件兩種各一個案例）。

## 已知取捨（範疇之外，先不處理）

- 沒有分頁——結果上限 50 筆，超過就看不到後面的，跟這個系統目前所有清單頁一致的限制。
- 沒有相關性排序——只有字母序，不特別把「完全符合」排在「部分符合」前面。
- 不支援全文搜尋——只比對檔名/資料夾名稱，不比對文件內容。
