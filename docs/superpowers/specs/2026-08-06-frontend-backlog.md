# 前端待辦清單

- 日期：2026-08-06
- 性質：追蹤清單，非設計文件——每項落地前仍需個別走 brainstorming/plan 流程
- 來源：[[2026-08-05-file-management-frontend-design.md]]、[[2026-08-06-file-management-frontend-navbar-redesign-design.md]]的「範疇之外」，以及這次視覺改版最終全分支審查發現的落差

## 1. 設計文件明確排除的範疇（功能性缺口）

- [ ] **權限管理 UI**（grant/revoke ACL）——目前只能靠後端 API/資料庫直接操作，前端沒有任何介面
- [ ] **搜尋**——資料夾/文件清單沒有搜尋功能
- [ ] **rename / move / delete**——文件與資料夾都不能改名、搬移、刪除
- [ ] **站內 PDF 預覽、動態浮水印顯示**——`download` 端點目前直接吐原始檔案，浮水印邏輯還沒接上
- [ ] **上傳者姓名顯示**——版本歷史目前顯示 user ID，不是姓名（需要一支查詢其他使用者身分的 API）
- [ ] **響應式/行動裝置版面**——目前桌面優先，沒做手機/平板適配
- [ ] **深色模式**

## 2. 這次改版審查中發現的已知落差

- [ ] **`DocumentView` 沒有麵包屑**——只有 `FolderView` 接上 `useSetNavbarCrumb`，進入文件詳情頁時導覽列中間的麵包屑 slot 是空的（已記錄在 navbar 改版設計文件的「已知落差」）
- [ ] **`FolderView` 沒有空狀態設計**——資料夾內沒有子資料夾/文件時，只顯示空的卡片框，不像 `RootFolders` 有圖示+提示文字
- [ ] **`FolderView` 的寫入按鈕沒有依權限隱藏**——沒有寫入權限的使用者一樣看得到「新增資料夾」「上傳文件」按鈕，填完表單送出才會被 403 擋下；理想做法是讓 `GET /folders/:id` 回傳呼叫者的有效權限層級，前端據此隱藏/停用

## 3. 技術債（不影響功能，效能/健壯性微調）

- [ ] **下載檔名的非 ASCII 處理**——後端 `Content-Disposition` header 目前只處理 `filename="..."` 這種 ASCII 形式，沒有實作 RFC 5987 的 `filename*=UTF-8''...`；中文檔名可能有問題。這是後端既有限制，這次前端上線後才會被實際使用者摸到
- [ ] **`listRootFolders` 是 N+1 查詢**——對非 admin 使用者，每個頂層資料夾都要單獨查一次權限；資料夾數量多時會變慢，可以用一次 `permission.findMany` 取代
- [ ] **`Navbar` 的 `/whoami` 抓取沒有 `AbortController`，失敗時靜默隱藏使用者資訊區塊**——沒有任何錯誤提示
- [ ] **Blob 下載的記憶體/瀏覽器相容性**——目前用同步 `URL.revokeObjectURL`，在 Firefox/Safari 偶爾不穩定；且整個檔案會先讀進記憶體（後端允許最大 200MB 上傳）
- [ ] **e2e 測試會在資料庫留下殘留 fixture 資料**——`file-management-flow.e2e-spec.ts` 等測試每次執行都會建立新的資料夾/文件/物件儲存內容，沒有清理（跟其他既有 e2e 測試檔案是一致的既有模式，這次沒有特別處理）
