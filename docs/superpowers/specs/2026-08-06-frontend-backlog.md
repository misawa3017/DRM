# 前端待辦清單

- 日期：2026-08-06
- 性質：追蹤清單，非設計文件——每項落地前仍需個別走 brainstorming/plan 流程
- 來源：[[2026-08-05-file-management-frontend-design.md]]、[[2026-08-06-file-management-frontend-navbar-redesign-design.md]]的「範疇之外」，以及這次視覺改版最終全分支審查發現的落差

## 1. 設計文件明確排除的範疇（功能性缺口）

- [x] **權限管理 UI**（grant/revoke ACL）——2026-08-07 完成並合併（全域權限儀表板 `/permissions`）
- [x] **搜尋**——2026-08-09 完成並合併（後端 GET /search + Navbar 搜尋框 + /search 結果頁）
- [x] **rename / move / delete**——2026-08-08 完成並合併（後端 PATCH/DELETE + 軟刪除 + 前端整合）
- [x] **站內 PDF 預覽、動態浮水印顯示**——2026-08-10 完成（受保護的站內 PDF 預覽、動態浮水印與自訂範本）
- [x] **上傳者姓名顯示**——2026-08-10 完成（版本 API 批次帶回上傳者摘要，前端顯示姓名與 Email）
- [x] **響應式/行動裝置版面**——2026-08-10 完成（導覽列、主要頁面、密集表格、對話框、預覽與權限表單）
- [x] **深色模式**——2026-08-10 完成（手動切換、偏好持久化、首次造訪尊重系統設定）

## 2. 這次改版審查中發現的已知落差

- [ ] **`DocumentView` 沒有麵包屑**——只有 `FolderView` 接上 `useSetNavbarCrumb`，進入文件詳情頁時導覽列中間的麵包屑 slot 是空的（已記錄在 navbar 改版設計文件的「已知落差」）
- [ ] **`FolderView` 沒有空狀態設計**——資料夾內沒有子資料夾/文件時，只顯示空的卡片框，不像 `RootFolders` 有圖示+提示文字
- [x] **`FolderView` 的寫入按鈕沒有依權限隱藏**——2026-08-10 前已完成，寫入按鈕依 `folder.canEdit` 顯示

## 4. rename/move/delete 分支的最終審查中新發現、刻意延後的項目

- [ ] **軟刪除沒有滲透到權限管理功能**——已軟刪除的資料夾/文件在「權限管理」（`permissions.service.ts`、`acl.service.ts` 的 `walkFolderForManagedDescendants`）中仍然可見且可操作（例如 `GET /folders/:id/permissions` 對已刪除資料夾仍回 200，全域權限儀表板也會永遠列出已刪除項目）。跨兩個已合併功能的整合缺口，2026-08-08 決定另開任務修，不算功能缺陷
- [ ] **`friendlyErrorMessage` 的 400 訊息太窄**——`apps/web/src/api/client.ts` 新增的 400 分支寫死「無法移動到這個位置」，但 400 也會被病毒掃描拒絕上傳、「file is required」、「group principals not supported」等情境共用，導致這些情境也顯示搬移相關的錯誤文字。應該做成搬移專用的 helper 或讓呼叫端可以覆蓋預設文字
- [ ] **`getWithContents` 的 ACL 查詢數翻倍**——為了同時算出每個子項目的 `canManage` 和 `canEdit`，現在對每個子資料夾/文件都各自呼叫兩次 `acl.can`；可以改成呼叫一次 `resolveLevel` 再用 `LEVEL_ORDER` 比較兩次，效能不影響正確性，純屬微調

## 3. 技術債（不影響功能，效能/健壯性微調）

- [ ] **下載檔名的非 ASCII 處理**——後端 `Content-Disposition` header 目前只處理 `filename="..."` 這種 ASCII 形式，沒有實作 RFC 5987 的 `filename*=UTF-8''...`；中文檔名可能有問題。這是後端既有限制，這次前端上線後才會被實際使用者摸到
- [ ] **`listRootFolders` 是 N+1 查詢**——對非 admin 使用者，每個頂層資料夾都要單獨查一次權限；資料夾數量多時會變慢，可以用一次 `permission.findMany` 取代
- [ ] **`Navbar` 的 `/whoami` 抓取沒有 `AbortController`，失敗時靜默隱藏使用者資訊區塊**——沒有任何錯誤提示
- [ ] **Blob 下載的記憶體/瀏覽器相容性**——目前用同步 `URL.revokeObjectURL`，在 Firefox/Safari 偶爾不穩定；且整個檔案會先讀進記憶體（後端允許最大 200MB 上傳）
- [ ] **e2e 測試會在資料庫留下殘留 fixture 資料**——`file-management-flow.e2e-spec.ts` 等測試每次執行都會建立新的資料夾/文件/物件儲存內容，沒有清理（跟其他既有 e2e 測試檔案是一致的既有模式，這次沒有特別處理）
