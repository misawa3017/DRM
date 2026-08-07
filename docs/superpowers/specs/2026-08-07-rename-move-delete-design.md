# Rename / Move / Delete 設計文件

- 日期：2026-08-07
- 來源：[[2026-08-06-frontend-backlog.md]] 第 1 節「rename / move / delete——文件與資料夾都不能改名、搬移、刪除」

## 背景

目前資料夾與文件建立後無法改名、搬移到別的資料夾，也無法刪除。後端完全沒有對應的
endpoint，也沒有軟刪除（`deletedAt`）的概念。這份文件補齊這三個操作，涵蓋資料夾與
文件兩種資源。

## 資料模型變更

- `Folder`、`Document` 各新增 `deletedAt DateTime?` 欄位（軟刪除標記，`null` 表示未刪除）。
- `AuditAction` enum 新增六個值：`folder_rename`、`folder_move`、`folder_delete`、
  `document_rename`、`document_move`、`document_delete`。

## 權限規則

- Rename、move、delete 三個操作都只需要對「被操作的資源本身」有 `edit` 權限——
  與現有「新增子資料夾」「上傳文件」都只需要 `edit` 的規則一致，`manage` 仍然只用於
  授權/撤銷權限（ACL 管理）。
- Move 需要對**來源**（被移動項目本身）和**目的地資料夾**都有 `edit`，避免使用者把
  東西搬進自己沒有寫入權限的資料夾（比照「上傳文件需要對目的資料夾有 edit」的現有規則）。
- 頂層（root）資料夾的建立目前是 admin-only，但這只限制「建立」這個動作——rename
  跟 delete 操作的都是已存在的資源，沿用該資源自己的 ACL（跟本來就對非頂層資料夾
  一樣，只看是否有 `edit`），頂層資料夾本身不例外，一樣可以被有權限的人改名/刪除。
  唯獨 move 這次不支援把東西移進或移出頂層（也就是不能把 `parentId` 改成
  `null`，也不能把現在 `parentId` 是 `null` 的頂層資料夾移進別的資料夾）：這是
  move 這個動作的範疇限制，而非頂層資料夾整體不能被操作。

## 同層級同名檢查

`create`（建立資料夾、上傳文件）目前不檢查同層級是否已有同名項目，這次一併補上：

- 新增同層級不能重名的檢查，套用到 `create`（資料夾建立、文件上傳）以及新增的
  rename、move 三種會改變「(parentId/folderId, name)」組合的操作。
- 用應用層查詢做檢查（`findFirst({ parentId, name, deletedAt: null, id: { not } })`
  存在就回 409 Conflict），而非資料庫 unique constraint——因為 `parentId` 可為
  `null`（多個頂層資料夾），且已軟刪除的項目的舊名稱不該擋新項目使用，這兩點用純
  Prisma schema 層級的 `@@unique` 無法乾淨表達（會需要額外的 partial index 原生
  SQL），應用層檢查與現有 ACL 檢查風格一致，也更簡單。
- 已知取捨：這是「先查後寫」的兩步驟，理論上存在極短暫的競態（兩個請求同時通過檢查
  後都寫入），但此工具內部使用情境下的請求並發度低，且與此程式庫既有的驗證風格
  （非資料庫層強制）一致，先不特別處理。
- 前端 `friendlyErrorMessage` 新增對 409 的訊息（例如「這個名稱已經被使用了」）。

## 軟刪除語意

- `DELETE /folders/:id`：軟刪除，遞迴走訪整個子樹（沿用 `AclService.
  walkFolderForManagedDescendants` 的走法：以 `parentId` 一路往下找子資料夾與
  文件），把子樹內所有資料夾與文件的 `deletedAt` 一併設成同一個時間戳記。
- `DELETE /documents/:id`：軟刪除該文件本身；`DocumentVersion` 不另外加
  `deletedAt`，只要父層 `Document` 被標記刪除，所有版本就跟著不可存取（所有走
  document-scoped 的 endpoint 都先確認父層 `deletedAt IS NULL`）。
- 既有讀取路徑（`listRootFolders`、`getWithContents`（含子資料夾/子文件清單）、
  `getMetadata`、`download`、`listVersions`）一律加上 `deletedAt: null` 過濾：
  軟刪除後的項目對所有人（包含原本有權限的人）都視為不存在。
- 範疇之外：這次不做「垃圾桶」／還原介面，也不做永久清空。之後有需要再開新設計。

## 後端 API

### 資料夾

- `PATCH /folders/:id`
  - body：`{ name?: string; parentId?: string }`（可只帶一個欄位，也可以兩個一起帶）
  - 權限：對 `:id` 本身需要 `edit`；若有帶 `parentId`，額外對新 `parentId` 也需要
    `edit`
  - 驗證：
    - `parentId` 不可等於 `:id` 自己或其任一子孫資料夾（避免把資料夾搬進自己的子樹，
      形成環）—— 400 Bad Request
    - `parentId` 不可為 `null`，也不可讓 `:id` 目前的 parent 是 `null`（不支援跨頂層，
      見上）—— 400 Bad Request
    - 若 `name` 或 `parentId` 造成與目的層級已存在的同名項目衝突 —— 409 Conflict
  - 依實際變更的欄位各自寫一筆 audit log（改名寫 `folder_rename`，搬移寫
    `folder_move`；若兩者皆變更則各寫一筆）
  - 回傳更新後的 folder 基本欄位

- `DELETE /folders/:id`
  - 權限：對 `:id` 需要 `edit`
  - 軟刪除整個子樹；每一個被軟刪除的資料夾/文件各寫一筆自己的 audit log
    （`folder_delete` 或 `document_delete`），不是彙總成一筆——跟 `folder_create`/
    `document_create` 一樣，一個資源一筆，保持逐項可追溯。子樹較大時這是這次接受的
    效能取捨（比照 `AclService` 對子樹走訪已經接受的 O(子孫數量) 設計）。
  - 204 No Content

### 文件

- `PATCH /documents/:id`
  - body：`{ name?: string; folderId?: string }`
  - 權限：對 `:id` 本身需要 `edit`；若有帶 `folderId`，額外對新 `folderId` 也需要
    `edit`
  - 驗證：`folderId` 不可為現在所在的同一個 folder（沒有意義的搬移，非必要但保留
    明確錯誤訊息 400）；同層級同名衝突 —— 409 Conflict
  - 依變更欄位寫 `document_rename` / `document_move` audit log
  - 回傳更新後的 document 基本欄位

- `DELETE /documents/:id`
  - 權限：對 `:id` 需要 `edit`
  - 軟刪除，寫一筆 `document_delete` audit log
  - 204 No Content

## 前端

- **Rename**：`FolderView` 子資料夾/文件清單的每一列，以及 `FolderView`／
  `DocumentView` 自己的標題（`h1`），改成可點擊就地編輯（inline edit：點擊後變成
  文字輸入框，Enter 或失焦送出 `PATCH`，Esc 取消）。
- **Move**：每一列與詳情頁提供「移動」操作，開啟 `ResourcePicker` 的新模式（新增
  一個 prop 讓它只能瀏覽並選擇資料夾，不能選文件），選定後呼叫 `PATCH`。若後端回
  400（循環搬移或跨頂層）或 409（同名衝突），顯示對應的友善錯誤訊息。
- **Delete**：每一列與詳情頁提供「刪除」操作，跳出確認對話框（沿用現有 `Dialog`
  元件）二次確認後才呼叫 `DELETE`，成功後刷新清單／導回上一層。

## 測試

- 後端沿用現有 e2e 風格（`axios` + 直接寫 Prisma 造測試資料），新增
  `folders-mutations.e2e-spec.ts`、`documents-mutations.e2e-spec.ts`，涵蓋：
  - 權限不足（只有 view/download）被 403 擋下
  - 改名成功、改名到同名衝突被 409 擋下
  - 搬移成功（audit log 正確記錄）
  - 搬移到自己或子孫資料夾被 400 擋下
  - 搬移跨頂層被 400 擋下
  - 搬移目的地沒有 edit 權限被 403 擋下
  - 刪除資料夾連帶軟刪除所有子資料夾與子文件
  - 軟刪除後，`GET`／清單／`download` 都表現得像資源不存在（404），即使是原本有
    manage 權限的人
  - `create`（建立資料夾、上傳文件）同名衝突也被 409 擋下
- 前端沿用現有 vitest + Testing Library 風格，逐 task TDD（本次功能不套用視覺
  改版時的「先做後測」例外）。
