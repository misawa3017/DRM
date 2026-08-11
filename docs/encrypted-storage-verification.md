# 加密儲存驗證操作說明

本系統的檔案儲存鏈為：`MinIO → KES → OpenBao`。MinIO 將檔案以 SSE-KMS 加密後寫入磁碟；KES 向 OpenBao 取得管理加密所需的金鑰材料。一般使用者與 API 都不會直接取得 KMS 金鑰。

## 驗證前確認

1. 在 Docker 主機的專案根目錄執行。
2. 確認 `minio`、`kes`、`openbao` 服務均已啟動且健康。
3. 不要將 `.env`、OpenBao token、unseal key、KES 私鑰或任何指令輸出貼到聊天室、Git 或 Log。

## 驗證檔案確實以 SSE-KMS 加密

執行既有的端對端驗證腳本：

```bash
source .env
./scripts/verify-encrypted-storage.sh
```

此腳本會建立暫存測試檔、上傳至 `documents` bucket，並檢查物件 metadata。成功時輸出必須包含：

```text
Encryption: SSE-KMS (arn:aws:kms:drm-default-key)
Encrypted storage verification passed
```

腳本也會下載檔案並比對內容，再刪除測試物件；同時確認 API 使用的 MinIO 帳號只能存取 `documents` bucket。

## 驗證沒有金鑰鏈時不能解密

這項驗證必須在**隔離測試環境**進行，絕不可停用正式環境的 KES 或 OpenBao。

測試原則：

1. 建立 MinIO 資料的測試副本，不使用正式環境正在掛載的 volume。
2. 在隔離環境啟動 MinIO，但不提供可用的 KES／OpenBao 金鑰鏈。
3. 嘗試讀取副本中的同一份物件；預期 MinIO 因 KMS 無法使用而拒絕讀取或無法啟動服務。
4. 在另一個同樣隔離的環境，提供正確的 KES、OpenBao、AppRole 與 mTLS 憑證。
5. 再次讀取物件，並比對 SHA-256 與原始檔一致。

預期關係如下：

```text
MinIO 加密物件副本 + 沒有 KES/OpenBao 金鑰鏈 → 無法讀取明文
MinIO 加密物件副本 + 正確 KES/OpenBao 金鑰鏈 → 可讀取，雜湊一致
```

注意：直接從 API 或 MinIO 下載成功，並不表示使用者取得了 KMS key；它表示 MinIO 在服務端透過受控的 KES／OpenBao 鏈完成解密。這正是正常設計。

## 驗證完成後

1. 確認腳本已清除測試物件。
2. 刪除隔離測試環境與其暫存資料。
3. 不要刪除正式的 `minio_data`、`openbao_data`、`openbao_init`、`openbao_approle` volumes；它們分別包含密文資料與解密鏈所需材料。
