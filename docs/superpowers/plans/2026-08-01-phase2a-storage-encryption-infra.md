# Phase 2A：儲存與加密基礎設施實作計畫

> **給代理型工作者的提示：** 必要子技能：使用 superpowers:subagent-driven-development（建議）或 superpowers:executing-plans 來逐一實作本計畫的各項任務。步驟使用核取方塊（`- [ ]`）語法進行追蹤。

**目標：** 建立加密的物件儲存鏈（`MinIO → KES → OpenBao`），讓 Phase 2B 的文件/版本邏輯有一個真實可用、已加密的地方來寫入檔案——並透過實際上傳與下載一個加密物件來端對端驗證，而不僅僅是服務回報「healthy」。

**架構：** OpenBao 以真正的伺服器模式（而非 dev-mode）運行，具備持久化的檔案儲存，並已正確初始化與解封（unseal），對外提供一個 `kv-v2` secrets engine，供 MinIO KES 透過 AppRole 驗證作為其金鑰儲存後端。KES 透過雙向 TLS（mutual TLS）驗證 MinIO 本身（客戶端憑證的身分雜湊值已列入 KES 政策的允許清單）。MinIO 設定為使用 KES 作為外部金鑰服務的 SSE-KMS。這一切都存在於 Phase 1 已建立的同一個 `docker-compose.yml` 中，與 Postgres/Keycloak/Traefik/api/web 並列。

**技術堆疊：** OpenBao（相容 Vault API 的 KMS/secrets 後端）、MinIO KES（金鑰加密服務）、MinIO（相容 S3 的物件儲存）、`mc`（MinIO 客戶端 CLI，用於驗證）、openssl（用於產生 TLS 身分）。

## 全域限制

- 持續擴充既有的根目錄 `docker-compose.yml` 與 `.env`/`.env.example`——不要建立第二個 compose 檔案。
- **OpenBao 必須以真正的伺服器模式運行，而非 `-dev`。** Dev 模式是記憶體內（in-memory）的，每次重啟都會重置；對於一個整體工作就是保護加密金鑰的系統來說，每次容器重建都遺失 KMS 的金鑰材料並不是可接受的簡化做法（Phase 1 已經在 Keycloak 的 dev-mode 身分漂移問題上踩過同一類 bug——這裡不要重蹈覆轍，因為後果會嚴重得多：先前已加密的文件會永久無法讀取）。
- OpenBao：使用 `storage "file"` 後端（單節點，對於一台內部 VM 來說是最簡單且正確的持久化選項）、單一解封金鑰分片（`-key-shares=1 -key-threshold=1`——這是針對內部單一操作者 VM 刻意採取的簡化；請在程式碼註解中註明，真正的多操作者部署會使用更高的門檻值）、OpenBao 自身監聽埠停用 TLS（僅限內部 Docker 網路，與 Phase 1 中 Keycloak 的 `KC_HTTP_ENABLED` 先例一致）。
- KES：透過 mTLS 客戶端憑證驗證 MinIO（身分＝客戶端公鑰的雜湊值，透過 `kes` CLI 本身計算——不要手動推導此雜湊值）。KES 自身的金鑰儲存後端是 OpenBao 的 `kv-v2` engine，透過 AppRole（role_id + secret_id）存取，而非靜態的 root token。
- **任何加密機密都不得提交至 git**：OpenBao 的解封金鑰、root token，KES 的 TLS 私鑰，MinIO 客戶端的 TLS 私鑰，以及 AppRole 的 `secret_id`，都必須存放在已加入 gitignore 的本地目錄（`secrets/`）中，或存放在僅供需要它們的容器共享的 Docker 管理磁碟區（volume）中。只有*範本*和*用來產生這些機密的腳本*會被提交。在產生任何內容之前，先把 `secrets/` 加入 `.gitignore`。
- 映像標籤：`minio/minio:latest`、`minio/kes:latest`、`openbao/openbao:latest`——這三個專案的發展速度都很快，釘選特定標籤反而有可能釘選到已經不存在的版本；因此這裡採用 `:latest` 作為務實的選擇（與 Phase 1 中釘選特定穩定版本的 Postgres/Keycloak/Traefik 不同）。
- **KES 的 YAML 設定結構（schema）並非完全確定**——以下計畫提供了一份具體、盡力而為的設定草稿，但在定案前，請先執行 `docker run --rm minio/kes:latest --help` 與 `docker run --rm minio/kes:latest server --help`，並利用 KES 本身（通常相當明確）的設定驗證錯誤輸出，在容器無法啟動時修正欄位名稱。這是本任務預期且正常的工作內容，不代表計畫本身有問題。
- 此主機上的 Docker daemon 有時會因不相關的行程而負載偏高，導致暫時性的緩慢；在斷定某個指令真的故障之前，先重試一次逾時的指令（這是 Phase 1 全程反覆出現、確認無害的模式）。

---

### 任務 1：OpenBao 伺服器——持久化、已初始化、已解封，並具備 kv-v2 + AppRole

**檔案：**
- 新增：`openbao/config.hcl`
- 新增：`openbao/init.sh`
- 修改：`docker-compose.yml`（新增 `openbao` 與 `openbao-init` 服務，以及 `openbao_data` 與 `openbao_shared` 磁碟區）
- 修改：`.gitignore`（新增 `secrets/`）

**介面：**
- 消費：沒有新的依賴。
- 產出：一個運行中、已解封的 OpenBao，可透過 Docker 網路上的 `http://openbao:8200` 存取，掛載於 `kes/` 的 `kv-v2` engine，一個名為 `kes` 的 AppRole role，綁定一個允許在 `kes/data/*` 下進行 CRUD 的政策，該 role 的 `role_id`/`secret_id` 會寫入 `openbao_shared` 磁碟區內的 `/shared/kes-approle.json`（格式：`{"role_id": "...", "secret_id": "..."}`），供任務 3 使用。具冪等性：可安全地重複執行 `docker compose up -d`，不會重新初始化或遺失既有金鑰。

- [ ] **步驟 1：將 `secrets/` 加入 `.gitignore`**

```
secrets/
```

- [ ] **步驟 2：建立 `openbao/config.hcl`**

```hcl
ui = true
disable_mlock = true

storage "file" {
  path = "/openbao/data"
}

listener "tcp" {
  address     = "0.0.0.0:8200"
  tls_disable = true
}

api_addr = "http://openbao:8200"
```

- [ ] **步驟 3：建立 `openbao/init.sh`**

此腳本具冪等性，依序完成三件事：（1）若尚未完成，則進行初始化＋解封，並將解封金鑰與 root token 持久化到共享磁碟區；（2）若 OpenBao 已初始化但目前處於封鎖（sealed）狀態（例如容器重啟後），則使用已儲存的金鑰進行解封；（3）若 `kv-v2` engine、AppRole 驗證、政策與 role 尚未存在，則進行設定，並將 `role_id`/`secret_id` 寫入共享磁碟區。

```bash
#!/bin/sh
set -eu

SHARED_DIR=/shared
INIT_FILE="$SHARED_DIR/openbao-init.json"
APPROLE_FILE="$SHARED_DIR/kes-approle.json"

export BAO_ADDR=http://openbao:8200

wait_for_openbao() {
  echo "Waiting for OpenBao to respond..."
  for i in $(seq 1 30); do
    if bao status >/dev/null 2>&1 || [ $? -eq 2 ]; then
      # exit code 2 means "sealed but reachable" for `bao status` — that's fine, it's up
      return 0
    fi
    sleep 2
  done
  echo "OpenBao did not become reachable in time" >&2
  exit 1
}

wait_for_openbao

INITIALIZED=$(bao status -format=json | grep -o '"initialized":[a-z]*' | cut -d: -f2)

if [ "$INITIALIZED" != "true" ]; then
  echo "Initializing OpenBao (1 key share, threshold 1 — single-operator internal VM)..."
  bao operator init -key-shares=1 -key-threshold=1 -format=json > "$INIT_FILE"
  chmod 600 "$INIT_FILE"
fi

UNSEAL_KEY=$(grep -o '"unseal_keys_b64":\["[^"]*"' "$INIT_FILE" | sed 's/.*\["//')
ROOT_TOKEN=$(grep -o '"root_token":"[^"]*"' "$INIT_FILE" | cut -d'"' -f4)

SEALED=$(bao status -format=json | grep -o '"sealed":[a-z]*' | cut -d: -f2)
if [ "$SEALED" = "true" ]; then
  echo "Unsealing OpenBao..."
  bao operator unseal "$UNSEAL_KEY"
fi

export BAO_TOKEN="$ROOT_TOKEN"

if ! bao secrets list -format=json | grep -q '"kes/"'; then
  echo "Enabling kv-v2 secrets engine at kes/..."
  bao secrets enable -path=kes -version=2 kv
fi

if ! bao auth list -format=json | grep -q '"approle/"'; then
  echo "Enabling AppRole auth..."
  bao auth enable approle
fi

cat <<'EOF' | bao policy write kes-policy -
path "kes/data/*" {
  capabilities = ["create", "read", "update", "delete"]
}
path "kes/metadata/*" {
  capabilities = ["list", "read", "delete"]
}
EOF

if ! bao read -format=json auth/approle/role/kes >/dev/null 2>&1; then
  echo "Creating AppRole role 'kes'..."
  bao write auth/approle/role/kes policies=kes-policy token_ttl=1h token_max_ttl=4h
fi

ROLE_ID=$(bao read -format=json auth/approle/role/kes/role-id | grep -o '"role_id":"[^"]*"' | cut -d'"' -f4)
SECRET_ID=$(bao write -f -format=json auth/approle/role/kes/secret-id | grep -o '"secret_id":"[^"]*"' | cut -d'"' -f4)

printf '{"role_id":"%s","secret_id":"%s"}\n' "$ROLE_ID" "$SECRET_ID" > "$APPROLE_FILE"
chmod 600 "$APPROLE_FILE"

echo "OpenBao init complete. AppRole credentials written to $APPROLE_FILE"
```

- [ ] **步驟 4：將 `openbao` 與 `openbao-init` 接入 `docker-compose.yml`**

新增以下服務（與既有的 `postgres`/`keycloak`/`traefik`/`api`/`web` 並列）以及兩個新的磁碟區：

```yaml
  openbao:
    image: openbao/openbao:latest
    command: server -config=/openbao/config.hcl
    cap_add:
      - IPC_LOCK
    volumes:
      - ./openbao/config.hcl:/openbao/config.hcl:ro
      - openbao_data:/openbao/data
    healthcheck:
      test: ["CMD", "wget", "-q", "-O", "-", "http://127.0.0.1:8200/v1/sys/health?standbyok=true&sealedcode=200"]
      interval: 5s
      timeout: 5s
      retries: 20

  openbao-init:
    image: openbao/openbao:latest
    entrypoint: ["/bin/sh", "/init.sh"]
    volumes:
      - ./openbao/init.sh:/init.sh:ro
      - openbao_shared:/shared
    depends_on:
      openbao:
        condition: service_healthy
    restart: "no"
```

加入頂層的 `volumes:` 區塊：

```yaml
  openbao_data:
  openbao_shared:
```

- [ ] **步驟 5：啟動這兩個服務並驗證**

執行：`docker compose up -d openbao openbao-init`
等待 `openbao-init` 成功結束：`docker compose ps openbao-init` 應顯示 `Exited (0)`。若否，執行 `docker compose logs openbao-init` 並修正腳本（上述 `bao status`/`bao operator init` 的 JSON 解析使用 `grep`/`cut` 而非 `jq`，因為基礎映像可能未安裝 `jq`——若映像中確實有 `jq`，可自由改用它以獲得更穩健的解析，但無論選哪一種都要對照實際輸出進行驗證）。

- [ ] **步驟 6：驗證冪等性**

再次執行：`docker compose up -d openbao-init`（模擬堆疊重啟）。
預期結果：腳本日誌顯示它略過了重新初始化（「already initialized」路徑），且仍以 0 結束，`/shared/kes-approle.json` 仍包含有效的憑證（驗證方式：`docker compose run --rm --entrypoint cat openbao-init /shared/kes-approle.json` 應印出一個 `role_id` 與 `secret_id` 皆非空的 JSON 物件）。

- [ ] **步驟 7：提交**

```bash
git add openbao .gitignore docker-compose.yml
git commit -m "feat(infra): stand up persistent OpenBao with kv-v2 + AppRole for KES"
```

---

### 任務 2：KES 伺服器與 MinIO 客戶端的 TLS 身分

**檔案：**
- 新增：`scripts/generate-kes-certs.sh`

**介面：**
- 消費：沒有新的依賴。
- 產出：`secrets/kes/kes-server.key` / `.cert`、`secrets/kes/minio-client.key` / `.cert`（皆已加入 gitignore，於本地產生），以及包含 MinIO 客戶端憑證之 KES 身分雜湊值的 `secrets/kes/minio-client-identity.txt`，供任務 3 的政策設定使用。

- [ ] **步驟 1：建立 `scripts/generate-kes-certs.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail

OUT_DIR="secrets/kes"
mkdir -p "$OUT_DIR"

if [ -f "$OUT_DIR/kes-server.cert" ] && [ -f "$OUT_DIR/minio-client.cert" ]; then
  echo "Certs already exist in $OUT_DIR — skipping generation (delete the directory to regenerate)."
else
  echo "Generating self-signed KES server certificate..."
  openssl req -x509 -newkey rsa:4096 -sha256 -days 3650 -nodes \
    -keyout "$OUT_DIR/kes-server.key" -out "$OUT_DIR/kes-server.cert" \
    -subj "/CN=kes" \
    -addext "subjectAltName=DNS:kes,DNS:localhost"

  echo "Generating self-signed MinIO client certificate..."
  openssl req -x509 -newkey rsa:4096 -sha256 -days 3650 -nodes \
    -keyout "$OUT_DIR/minio-client.key" -out "$OUT_DIR/minio-client.cert" \
    -subj "/CN=minio-client"
fi

echo "Computing KES identity hash of the MinIO client certificate..."
docker run --rm -v "$(pwd)/$OUT_DIR":/certs minio/kes:latest identity of /certs/minio-client.cert \
  | tee "$OUT_DIR/minio-client-identity.txt"

echo "Done. Identity hash saved to $OUT_DIR/minio-client-identity.txt"
```

（`kes identity of` 的確切輸出格式——是純雜湊值輸出到 stdout，還是帶標籤的一行文字——應對照實際指令輸出來確認；若印出的內容不只是純雜湊值，請調整任務 3 中的 `tee`/解析邏輯。）

- [ ] **步驟 2：執行並驗證**

執行：`chmod +x scripts/generate-kes-certs.sh && ./scripts/generate-kes-certs.sh`
預期結果：`secrets/kes/` 現在包含 `kes-server.key`、`kes-server.cert`、`minio-client.key`、`minio-client.cert`、`minio-client-identity.txt`。確認這些檔案都未被 git 追蹤：`git status --short` 在 `secrets/` 底下必須沒有任何輸出。

- [ ] **步驟 3：驗證重複執行是安全的空操作**

再次執行：`./scripts/generate-kes-certs.sh`。
預期結果：印出「Certs already exist... skipping generation」，並仍會重新計算/印出身分雜湊值（成本低、具冪等性，在只刪除了身分檔案的情況下也很有用）。

- [ ] **步驟 4：提交**

```bash
git add scripts/generate-kes-certs.sh
git commit -m "feat(infra): add script to generate KES/MinIO TLS identities"
```

（`secrets/` 底下的任何內容都不會被提交——只有產生它們的腳本會被提交。）

---

### 任務 3：將 KES 伺服器接上 OpenBao（AppRole）與 MinIO（mTLS）

**檔案：**
- 新增：`kes/server-config.yaml.template`
- 新增：`kes/entrypoint.sh`
- 修改：`docker-compose.yml`（新增 `kes` 服務）

**介面：**
- 消費：`secrets/kes/kes-server.{key,cert}` 與 `secrets/kes/minio-client-identity.txt`（任務 2）；`openbao_shared` 磁碟區中的 `/shared/kes-approle.json`（任務 1）。
- 產出：可透過 Docker 網路上的 `https://kes:7373` 存取的 KES，以 OpenBao 的 `kes/` kv-v2 路徑為後端，僅接受與 MinIO 客戶端憑證相符身分的請求。

- [ ] **步驟 1：在撰寫範本之前，先檢查真實的 KES 設定結構（schema）**

執行：`docker run --rm minio/kes:latest --help` 與 `docker run --rm minio/kes:latest server --help`。若映像內附有範例設定檔（可透過 `docker run --rm --entrypoint sh minio/kes:latest -c "find / -iname '*.yaml' -o -iname '*.yml' 2>/dev/null | grep -v proc"` 檢查），請一併檢視。在進行下方步驟 2 之前，先用這些資訊確認或修正欄位名稱——本計畫的 YAML 只是盡力而為的起始草稿，不保證與 `:latest` 目前所解析到的 KES 版本完全一致。

- [ ] **步驟 2：建立 `kes/server-config.yaml.template`**

```yaml
address: 0.0.0.0:7373

tls:
  key: /certs/kes-server.key
  cert: /certs/kes-server.cert

admin:
  identity: disabled

policy:
  minio:
    allow:
      - /v1/key/create/*
      - /v1/key/generate/*
      - /v1/key/decrypt/*
      - /v1/key/bulk/decrypt/*
      - /v1/key/list/*
    identities:
      - __MINIO_IDENTITY__

keystore:
  vault:
    endpoint: http://openbao:8200
    engine: kv-v2
    prefix: kes
    approle:
      id: __VAULT_ROLE_ID__
      secret: __VAULT_SECRET_ID__
      retry: 15s
```

- [ ] **步驟 3：建立 `kes/entrypoint.sh`**

透過將 MinIO 身分雜湊值（來自任務 2 以唯讀方式掛載進來的輸出檔案）與 AppRole 憑證（來自任務 1 初始化腳本寫入的 `openbao_shared` 磁碟區）代入範本，渲染出一份暫用設定檔，接著再以 exec 執行真正的 KES 伺服器。

```bash
#!/bin/sh
set -eu

IDENTITY=$(cat /certs/minio-client-identity.txt | tr -d '[:space:]')
ROLE_ID=$(grep -o '"role_id":"[^"]*"' /shared/kes-approle.json | cut -d'"' -f4)
SECRET_ID=$(grep -o '"secret_id":"[^"]*"' /shared/kes-approle.json | cut -d'"' -f4)

sed -e "s/__MINIO_IDENTITY__/$IDENTITY/" \
    -e "s/__VAULT_ROLE_ID__/$ROLE_ID/" \
    -e "s/__VAULT_SECRET_ID__/$SECRET_ID/" \
    /template/server-config.yaml.template > /tmp/server-config.yaml

exec kes server --config /tmp/server-config.yaml
```

- [ ] **步驟 4：將 `kes` 接入 `docker-compose.yml`**

```yaml
  kes:
    image: minio/kes:latest
    entrypoint: ["/bin/sh", "/entrypoint.sh"]
    volumes:
      - ./kes/entrypoint.sh:/entrypoint.sh:ro
      - ./kes/server-config.yaml.template:/template/server-config.yaml.template:ro
      - ./secrets/kes:/certs:ro
      - openbao_shared:/shared:ro
    depends_on:
      openbao-init:
        condition: service_completed_successfully
    ports:
      - "127.0.0.1:7373:7373"
```

（僅發布至 loopback 的埠，供本地除錯/`mc`/curl 存取使用，延續 Phase 1 最終審查後為 Postgres/Traefik 儀表板建立的相同 loopback 綁定紀律。）

- [ ] **步驟 5：啟動 KES 並驗證它確實運行在真實、由 OpenBao 支撐的狀態之上**

執行：`docker compose up -d --build kes`（若沒有 build 步驟則用普通的 `up -d kes`），然後執行 `docker compose logs kes`。
預期結果：日誌中沒有 TLS 或 Vault 驗證錯誤；若有，錯誤訊息會明確指出問題所在（憑證路徑錯誤、AppRole 驗證失敗、Vault engine 路徑錯誤等）——依此修正範本/entrypoint/OpenBao 政策後重試。這是預期中的反覆調整工作，不代表計畫本身有問題。

驗證 KES 自身的狀態端點：`curl -sk https://127.0.0.1:7373/v1/status --cacert secrets/kes/kes-server.cert`（或依步驟 1 中 `kes --help` 顯示的正確狀態路徑）應回傳成功的回應。

- [ ] **步驟 6：提交**

```bash
git add kes docker-compose.yml
git commit -m "feat(infra): wire KES to OpenBao (AppRole) and MinIO (mTLS identity)"
```

---

### 任務 4：設定 MinIO 透過 KES 使用 SSE-KMS

**檔案：**
- 修改：`docker-compose.yml`（新增 `minio` 服務）
- 修改：`.env.example`（新增 MinIO root 憑證）

**介面：**
- 消費：`https://kes:7373` 的 KES（任務 3）、`secrets/kes/minio-client.{key,cert}`（任務 2）。
- 產出：可透過 Docker 網路上的 `http://minio:9000`（S3 API）與 `http://minio:9001`（主控台）存取的 MinIO，KMS 已設定完成並處於上線狀態。

- [ ] **步驟 1：在 `.env.example` 中新增 MinIO root 憑證**

```
MINIO_ROOT_USER=drm-admin
MINIO_ROOT_PASSWORD=drm_dev_minio_password
```

執行：本專案更新 `.env` 的方式一向是 `cp .env.example .env`（Phase 1 先例）——由於 `.env` 已加入 gitignore 且本地已存在，請手動將這兩行新內容附加到既有的本地 `.env` 檔案中以保持一致（不要用整份範例檔覆蓋，以免清空既有的數值）。

- [ ] **步驟 2：將 `minio` 接入 `docker-compose.yml`**

```yaml
  minio:
    image: minio/minio:latest
    command: server /data --console-address ":9001"
    environment:
      MINIO_ROOT_USER: ${MINIO_ROOT_USER}
      MINIO_ROOT_PASSWORD: ${MINIO_ROOT_PASSWORD}
      MINIO_KMS_KES_ENDPOINT: https://kes:7373
      MINIO_KMS_KES_CERT_FILE: /certs/minio-client.cert
      MINIO_KMS_KES_KEY_FILE: /certs/minio-client.key
      MINIO_KMS_KES_CA_PATH: /certs/kes-server.cert
      MINIO_KMS_KES_KEY_NAME: drm-default-key
    volumes:
      - minio_data:/data
      - ./secrets/kes:/certs:ro
    depends_on:
      - kes
    labels:
      - traefik.enable=true
      - traefik.http.routers.minio-console.rule=Host(`storage.drm.localhost`)
      - traefik.http.services.minio-console.loadbalancer.server.port=9001
    healthcheck:
      test: ["CMD", "curl", "-f", "http://127.0.0.1:9000/minio/health/live"]
      interval: 5s
      timeout: 5s
      retries: 20
```

將 `minio_data:` 加入頂層的 `volumes:` 區塊。

- [ ] **步驟 3：啟動 MinIO 並驗證 KMS 確實已上線（而非只是已設定）**

執行：`docker compose up -d minio`，等待其健康狀態變為 healthy，然後執行 `docker compose logs minio`。
預期結果：啟動日誌中包含確認 KMS/加密已啟用的訊息行（MinIO 的啟動橫幅通常會印出「Encryption」或「KMS」狀態行——留意此行；若反而出現連線到 KES 的錯誤，請修正憑證路徑/CA/端點後重試）。

直接交叉驗證：`docker compose exec minio mc admin kms status local`（若伺服器映像未內建 `mc`，則改用 `docker run --rm --network drm_default minio/mc ...`——請先確認實際情況）應回報 KMS 為可連線，並顯示預設金鑰名稱。

- [ ] **步驟 4：提交**

```bash
git add docker-compose.yml .env.example
git commit -m "feat(infra): add MinIO configured for SSE-KMS via KES"
```

---

### 任務 5：端對端加密上傳/下載驗證

**檔案：**
- 新增：`scripts/verify-encrypted-storage.sh`
- 修改：`scripts/smoke-test.sh`（新增 MinIO/KES/OpenBao 檢查）

**介面：**
- 消費：任務 1 到 4 建立的完整儲存鏈。
- 產出：MinIO 中一個已啟用預設 SSE-KMS 加密的 `documents` bucket，以及一支證明真實物件確實能透過真實加密機制往返（round-trip）的腳本——這正是 Phase 2B 應用程式碼將會寫入的目標。

- [ ] **步驟 1：建立 `scripts/verify-encrypted-storage.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail

MC="docker run --rm --network drm_default -v $(pwd)/secrets:/secrets minio/mc"
ALIAS_SETUP="mc alias set local http://minio:9000 ${MINIO_ROOT_USER:-drm-admin} ${MINIO_ROOT_PASSWORD:?set MINIO_ROOT_PASSWORD or export it from .env first}"

echo "Configuring mc alias..."
$MC sh -c "$ALIAS_SETUP"

echo "Creating 'documents' bucket if it doesn't exist..."
$MC mc mb --ignore-existing local/documents

echo "Setting default SSE-KMS encryption on the bucket..."
$MC mc encrypt set sse-kms drm-default-key local/documents

echo "Uploading a test object..."
echo "phase 2a verification $(date -u +%FT%TZ)" > /tmp/verify-test.txt
$MC mc cp /tmp/verify-test.txt local/documents/verify-test.txt

echo "Confirming the object reports server-side encryption..."
$MC mc stat local/documents/verify-test.txt | grep -i "Encrypted" || {
  echo "FAIL: object does not report encryption metadata" >&2
  exit 1
}

echo "Downloading and verifying content round-trips correctly..."
$MC mc cat local/documents/verify-test.txt > /tmp/verify-test-downloaded.txt
diff /tmp/verify-test.txt /tmp/verify-test-downloaded.txt

echo "Cleaning up test object..."
$MC mc rm local/documents/verify-test.txt

echo "Encrypted storage verification passed."
```

（請調整確切的 `mc` 呼叫方式——`minio/mc` 映像內的指令名稱通常就只是 `mc`，而非 `mc mc`——本計畫的草稿很可能出現了重複；定案前請依據 `docker run --rm minio/mc --help` 的實際顯示內容修正。若 `docker compose` 產生的專案網路名稱與 `drm_default` 不同，也請一併調整——可用 `docker network ls` 確認。）

- [ ] **步驟 2：執行**

執行：`chmod +x scripts/verify-encrypted-storage.sh && source .env && ./scripts/verify-encrypted-storage.sh`
預期結果：顯示「Encrypted storage verification passed.」且沒有任何錯誤。

- [ ] **步驟 3：確認 OpenBao 中確實存在真實的金鑰材料（而非只是 MinIO/KES 自稱成功）**

執行：`docker compose exec openbao sh -c "BAO_TOKEN=\$(grep -o '\"root_token\":\"[^\"]*\"' /shared/openbao-init.json | cut -d'\"' -f4) bao kv list kes/"`（請依據共享初始化檔案在 OpenBao 容器自身視角下的實際位置調整路徑——任務 1 的 `openbao-init` 服務將其寫入了 `openbao_shared` 磁碟區，但本計畫中該磁碟區並未掛載進 `openbao` 服務本身；請自行判斷最乾淨的驗證方式，可暫時將 `openbao_shared` 以唯讀方式掛載進 `openbao` 進行此項檢查，或從一個同時具備該磁碟區與網路存取權的一次性容器執行等效的 `bao kv list` 指令，以避免永久擴大 `openbao` 服務的掛載範圍。）
預期結果：至少列出一筆項目，證明 KES 確實在 OpenBao 中建立並儲存了金鑰材料——整條鏈是真實運作的，而不只是三個服務各自回報「OK」。

- [ ] **步驟 4：擴充 `scripts/smoke-test.sh`**

在既有的三項檢查旁新增以下檢查：

```bash
check "http://storage.drm.localhost/"
```

（MinIO 主控台即使在登入前也應該有回應；回傳 200 或轉址到登入頁都算正常——若 MinIO 主控台回傳的並非單純的 200，例如回傳帶有 HTML 登入頁面的 200，請相應調整 `check` 函式對預期狀態碼的處理邏輯，這正是此處所預期的情況。）

同時新增一項不依賴 Traefik 的直接 MinIO 健康檢查：

```bash
check "http://127.0.0.1:9000/minio/health/live"
```

（需要在 `docker-compose.yml` 中將 MinIO 的 API 埠對外發布至 loopback，做法與 Postgres/Traefik 儀表板既有的僅限 loopback 發布方式相同——若 `minio` 服務的 `ports:` 尚未讓主機端可存取，請加入 `"127.0.0.1:9000:9000"`；請確認任務 4 是否已完成此設定，或這裡是否仍需要新增。）

- [ ] **步驟 5：執行完整的 smoke test**

執行：`./scripts/smoke-test.sh`
預期結果：所有檢查皆通過，包含新增的兩項。

- [ ] **步驟 6：提交**

```bash
git add scripts/verify-encrypted-storage.sh scripts/smoke-test.sh docker-compose.yml
git commit -m "test(infra): verify encrypted upload/download round-trip through MinIO+KES+OpenBao"
```

---

## 自我審查備註

- **規格涵蓋範圍：** 本計畫恰好涵蓋了原始 Phase 2 範疇中所指名的「加密上傳/下載」基礎設施前置需求，並依與使用者的協議拆分出來。文件/資料夾/版本/ACL 業務邏輯明確不在此範圍內——那屬於 Phase 2B，它將使用本計畫所建立的 `documents` bucket。
- **佔位內容掃描：** 沒有 TBD/TODO 標記。真正因工具細節而存在不確定性的地方（KES 確切的 YAML 結構、`mc` 確切的 CLI 呼叫形式、Docker Compose 專案自動產生的網路名稱）都明確標示為「需對照實際運行中的工具進行驗證」，而非默默用猜測帶過——考量到快速變動的第三方工具語法確實存在不確定性，這是刻意且已揭露的選擇，並非計畫撰寫流程所警惕的那種佔位內容（沒有含糊的「新增適當的設定」這類說法——每個步驟都有具體的草稿內容可作為起點，並依據實際工具輸出進行迭代）。
- **型別一致性：** `documents` bucket 名稱、`drm-default-key` KMS 金鑰名稱，以及 `openbao_shared` 磁碟區的檔案路徑（`/shared/kes-approle.json`、`/shared/openbao-init.json`）都各自僅定義一次，並在跨任務引用時保持一致。
- **範圍：** 單一且內聚的交付項目——一條可運作的加密儲存鏈——不摻雜任何文件/ACL 邏輯。
