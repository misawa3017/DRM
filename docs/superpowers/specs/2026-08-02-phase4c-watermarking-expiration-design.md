# Phase 4C：浮水印與到期設計

## 背景

這是原始 Phase 4 拆分（4A 基礎設施／4B 上傳流程整合／4C 浮水印＋到期）中的第三個、也是最後一個子階段，前兩者皆已完成。此階段實作原始系統設計規格（`docs/superpowers/specs/2026-07-31-confidential-document-management-design.md`）中所列出的最後兩項 v1 功能：動態浮水印，以及文件到期／自動失效。

自原始規格撰寫以來，Phase 4B 建立了一項堅實的架構原則：`apps/worker` 永遠不直接存取 Postgres；`apps/api` 是所有資料庫寫入（包括背景工作結果）的唯一擁有者。本設計在一處刻意偏離原始規格的字面描述（到期掃描機制），以維持與這項已審查通過原則的一致性——詳見下文。

## 架構

**到期掃描：** 原始規格要求使用 worker 端的 BullMQ 週期性工作（repeatable job）。本設計改為直接在 `apps/api` 內部使用 `@nestjs/schedule` 的 `@Cron` 裝飾器。這項掃描是純粹的「查詢 Postgres、更新狀態」操作，不需要用到 worker 存在的理由——也就是那些外部服務（MinIO、Gotenberg、ClamAV）——因此沒有理由將它繞道經過 worker，重新在那裡引入資料庫依賴——這正是 Phase 4B 審查中標記並避免的那類 Dockerfile／Prisma 相關問題。由單一個 `apps/api` 實例執行這個 cron；如果日後部署被水平擴展為多個 `api` 副本，這是一項已記錄在案的限制（超出本 v1 單一 VM 部署的範圍——詳見「範圍之外」）。

**浮水印：** 永不預先產生，也永不快取。每一個解析到符合浮水印條件 PDF 的 `GET /documents/:id/download` 請求，都會在傳回回應之前，即時透過 `pdf-lib` 疊加浮水印。

## 資料模型變更

`Document` 模型新增：
- `expiresAt DateTime?` —— 可為 null；`null` 代表永不到期。
- `status DocumentStatus` —— 新增列舉 `active` / `expired`，預設為 `active`。
- `watermarkEnabled Boolean?` —— 可為 null；`null` 代表「未明確設定，繼承自資料夾鏈」；`true`/`false` 則是明確的覆寫值，會在該文件處中止繼承。

`Folder` 模型新增：
- `watermarkEnabled Boolean?` —— 與文件欄位相同的可為 null／繼承語意。

**浮水印解析**（`resolveWatermarkEnabled`，仿照 Phase 2B 既有的 `AclService.resolveLevel` 模式）：從文件本身開始；若其 `watermarkEnabled` 非 null，就使用該值。否則沿資料夾鏈向上走訪，採用第一個找到的非 null `watermarkEnabled`。若整條鏈中都沒有明確設定，則預設為 `true`（開啟浮水印）。

`AuditAction` 列舉新增：
- `document_expired` —— 當每日掃描將某文件轉為 `expired` 狀態時，針對該文件寫入一次。行為者是一個保留的系統識別碼（確切表示方式於撰寫計畫時決定），而非真實使用者。
- `document_expiry_updated` —— 當具備 `manage` 權限的使用者透過 API 設定或變更 `expiresAt` 時寫入。

## 到期工作流程

- **設定／修改：** 一個受 `manage` 權限保護的端點（確切路由於撰寫計畫時決定，例如 `PATCH /documents/:id/expiration`）接受 `expiresAt`，可為 ISO 時間戳記或 `null`（永不到期）。如果該文件目前的 `status` 為 `expired`，且新的 `expiresAt` 是未來時間（或為 `null`），此呼叫也會將 `status` 改回 `active`——這是唯一能讓文件「復原到期狀態」的方式。會寫入 `document_expiry_updated`。
- **每日掃描：** `apps/api` 的 `@Cron`（例如每日 02:00）查詢所有 `status = active AND expiresAt < now()` 的文件，將每一筆的 `status` 設為 `expired`，並針對每份文件寫入一筆 `document_expired` 稽核紀錄。
- **強制範圍：** 只有與內容相關的端點會在 `status = expired` 時被封鎖——`download`、`getMetadata`、`listVersions`、`addVersion` 全部都會回傳明確的錯誤（確切狀態碼，403 或 410，於撰寫計畫時決定），並附上說明文件已到期的訊息。權限管理（`grant`/`revoke`）不受影響——具 `manage` 權限的使用者仍可調整 ACL 或延長已到期文件的 `expiresAt`。
- 任何內容都不會被刪除。ACL 授權與完整的稽核歷史在到期後維持不變——到期純粹只是一個狀態旗標。

## 浮水印工作流程

僅套用於單一檔案內容端點 `GET /documents/:id/download`，在既有的 ACL 檢查與新增的到期檢查之後進行。依據所請求的文件版本，解析順序如下：

1. **版本本身的 mimetype 為 `application/pdf`**，且 `resolveWatermarkEnabled` 為 `true` → 在該 PDF 上疊加浮水印後回傳。
2. **版本具有 Phase 4B 產生的 `previewObjectKey`**（一份已完成轉換的 Office 檔案），且 `resolveWatermarkEnabled` 為 `true` → 在該預覽 PDF 上疊加浮水印後回傳（回應內容是轉換後的 PDF，而非原始 Office 檔案——整個重點就在於離開系統的內容必須是受浮水印保護的）。
3. **版本為 Office mimetype，`resolveWatermarkEnabled` 為 `true`，但 `previewObjectKey` 仍為 `null`**（Phase 4B 的非同步轉換尚未完成）→ 回傳一個明確的「尚未就緒」錯誤（HTTP 425 Too Early），而不是悄悄退回未受保護的原始檔案。這遵循了 Phase 4B 最終審查針對病毒掃描器所建立的「失敗時關閉（fail-closed）」先例（一個模糊或不完整的安全相關狀態，絕不能悄悄降級為「未受保護但仍予以提供」）。
4. **`resolveWatermarkEnabled` 為 `false`，或該檔案類型完全沒有 PDF 表示形式**（圖片、純文字等）→ 原樣回傳原始檔案，不加浮水印。

浮水印內容：下載使用者的電子郵件、下載時間戳記，以及其來源 IP，透過 `pdf-lib` 疊加於 PDF 的每一頁上（確切的視覺樣式——例如對角線半透明文字——於實作時決定）。既有的 `document_download` 稽核動作已涵蓋此情境；加浮水印這個動作本身不需要新增稽核動作。

## 測試／驗證

依循本專案「對照真實運行中的堆疊進行驗證，不模擬基礎設施」的慣例：

- **到期：** 透過 Prisma 將一份真實文件的 `expiresAt` 設為過去時間，直接呼叫掃描邏輯（而非等待真實的 cron 排程觸發），確認 `status` 轉為 `expired`、稽核紀錄已寫入，且 `download`/`getMetadata`/`listVersions`/`addVersion` 全部遭拒，而 `permissions` 端點仍正常運作。也要測試在已到期的文件上延長 `expiresAt`，確認它會重新啟用。
- **浮水印：** 透過完整的真實流程（ClamAV 掃描 → MinIO 儲存 → Gotenberg 轉換）上傳一份真實 PDF 與一份真實 Office 文件，分別下載，並驗證回傳的 PDF 確實包含浮水印文字（例如在擷取出的 PDF 內容中出現該使用者的電子郵件字串）——而不只是檢查 200 狀態碼或檔案大小。也要驗證當 `watermarkEnabled=false` 時，下載的位元組與原始檔案逐位元組完全相同（雜湊比對）。針對資料夾繼承解析邏輯撰寫專門的單元測試，風格比照既有的 `AclService` 測試。涵蓋一份轉換尚未完成的 Office 上傳所觸發的 425「尚未就緒」路徑。
- 執行完整既有的 lint/build/unit/e2e 套件，確認沒有造成回歸問題。

## 範圍之外

- `apps/api` 的水平擴展（單一實例的 `@Cron` 若跨多個副本執行會導致掃描重複觸發）——對於本 v1 單一 VM 的 Docker Compose 部署而言可以接受；等到未來遷移至 K8s、擁有多個 API 副本時再重新檢視。
- 任何 UI／前端工作——本階段僅限後端，與 Phase 1-4B 的模式一致。
- 資料夾層級或文件層級的到期繼承——到期（`expiresAt`/`status`）僅限文件本身；只有浮水印功能才使用資料夾繼承，如上述設計所述。
- 在文件到期前／到期時通知使用者（例如寄送電子郵件提醒）——並未被要求，原始規格中也沒有此項目。
