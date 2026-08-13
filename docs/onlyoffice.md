# OnlyOffice 限時分享部署說明

限時 Excel 分享使用 OnlyOffice Document Server 提供網頁編輯。OnlyOffice 不會取得 MinIO、KES 或 OpenBao 憑證；文件只會經 API 的短效 HMAC 授權 URL 傳送。

## 必要設定

在部署主機的既有 `.env` 手動新增下列值，請使用至少 32 位元組的隨機字串，且不得提交至 Git：

```dotenv
ONLYOFFICE_JWT_SECRET=請填入高熵隨機密鑰
```

啟動服務後，OnlyOffice 透過 `https://office.<網域>` 供瀏覽器載入；文件服務在 Docker 內部以短效授權 URL 連到 API 讀取檔案與回呼儲存，因此不依賴內網 TLS 開發憑證的信任鏈。

內部 CA 簽發的憑證 SAN 必須包含 `office.<網域>`。憑證鏈檔必須是「伺服器憑證後接中繼 CA」，私鑰只留在部署主機。重建憑證後請執行 `docker compose restart traefik`，並將 APOWER Root CA 安裝到所有使用者電腦的信任根憑證存放區；不可只在瀏覽器略過憑證警告。

## 暫存資料保護

OnlyOffice 的工作階段快取設定為容器 `tmpfs`，容器重啟時會清除。生產主機仍須採用全碟加密，並限制 Docker 主機與 OnlyOffice 容器的管理權限；網頁 Excel 編輯時，文件內容必然會在受控服務的記憶體中解密處理。

## 受控儲存行為

- 原始文件與分享遮蔽副本都儲存在 MinIO SSE-KMS。
- 有遮蔽規則的分享，OnlyOffice 只取得遮蔽副本。
- 收件人儲存編輯結果時，會形成該分享專屬副本，不會覆寫原始含個資文件。
- 到期或撤銷後，下載、編輯器取檔與儲存回呼都會被 API 拒絕。
