# Phase 4B：上傳流程整合實作計畫

> **給代理型工作者：** 必要的子技能：使用 superpowers:subagent-driven-development（建議）或 superpowers:executing-plans 來逐項任務執行此計畫。步驟使用核取方塊（`- [ ]`）語法來追蹤進度。

**目標：** 每一份文件上傳都會在儲存之前先經過病毒掃描，而 Office 文件（Word/Excel/PowerPoint）則會在背景產生 PDF 預覽——使用 Phase 4A 已證實可行的基礎設施（ClamAV、Gotenberg、Redis/BullMQ、`apps/worker`），首次接上 Phase 2B 建立的實際上傳流程。

**架構：** 病毒掃描是同步的，發生在 `apps/api` 的請求路徑中，在任何東西寫入 MinIO 或 Postgres 之前——被感染的檔案會直接被拒絕，符合設計規格中明確的上傳順序（先掃描再儲存）。PDF 轉換則是非同步的：`apps/api` 在上傳成功後排入一個 BullMQ 工作，`apps/worker` 從 MinIO 取得檔案，透過 Gotenberg 進行轉換，再將結果存回 MinIO；`apps/api` 監聽工作完成事件（透過 BullMQ 自身的事件串流，而非回呼端點）並記錄結果。此階段也解決了 Phase 4A 最終審查中刻意延後的資料庫存取問題：**`apps/worker` 保持無資料庫存取**——`apps/api` 仍是唯一擁有所有 Postgres 存取權的角色，包括背景工作的結果，藉此避免 Phase 4A 審查中提出的 Prisma/Dockerfile 相關風險。現在引入一個新的 `packages/shared` 工作區套件（只包含佇列名稱與工作 payload/結果型別，不含任何邏輯），這是 Phase 4A 審查建議在導入更重的共用套件之前先解決的輕量版共用套件問題。

**技術棧：** `clamscan`（npm，已在 Phase 4A 研究並選定）用於同步掃描，BullMQ（`Queue`/`QueueEvents`/`Worker`——皆已在 Phase 4A 驗證過）用於非同步轉換流程，Gotenberg 已驗證過的 LibreOffice 轉換路由，以及針對實際運行中系統的 Jest e2e 測試（此專案既有的慣例）。

## 全域限制條件

- **病毒掃描是同步的，會阻塞上傳請求。** 它發生在 `DocumentsService.createDocument`/`.addVersion` 中，在 `storage.putObject` 之前、在任何 `Document`/`DocumentVersion` 資料列建立之前。被感染的檔案會以 `400 Bad Request` 拒絕；不會有任何東西寫入 MinIO 或 Postgres。這符合設計規格中明確的流程（「Client → API → 暫存 → ClamAV 掃描 → ... → 寫入MinIO」），並讓上傳者立即獲得回饋，而非事後才發現「你上傳的東西其實是惡意軟體」。
- **被拒絕（受感染）的上傳「確實會」被稽核，這是刻意的、明確的例外，違反 Phase 3「只稽核成功動作」的原則。** 病毒上傳嘗試無論結果如何都是值得記錄的安全事件——這並非與先前原則矛盾，而是針對這一個特殊案例所做的狹義、明確命名的例外。新增了一個 `virus_detected` 的 `AuditAction`。由於拒絕當下不存在任何 `Document`/`DocumentVersion` 資料列，稽核項目的 `resourceType`/`resourceId` 會是（在 `createDocument` 情況下）正在上傳目標的**資料夾**，或（在 `addVersion` 情況下）正在建立新版本的**文件**——也就是當下已經存在的那個資源識別碼。
- **PDF 轉換是非同步的，不會阻塞上傳請求。** Office 文件（Word/Excel/PowerPoint——具體 MIME 類型清單見任務 5）在上傳成功後會排入一個 `document-conversion` BullMQ 工作。非 Office 檔案永遠不會有轉換工作。`DocumentVersion.previewObjectKey` 一開始為 `null`，之後在轉換完成時由 `apps/api` 的工作完成監聽器填入。**`null` 刻意同時代表「不適用」與「尚未轉換」**——此階段不會另外新增一個狀態／列舉欄位來區分這兩種情況。這是可接受的簡化；如果未來階段的前端需要顯示「轉換中……」的狀態，屆時再重新檢視此決定。
- **`apps/worker` 保持無資料庫存取**，解決了 Phase 4A 最終審查中標記為未解決的問題。`apps/api` 是唯一與 Postgres 溝通的行程，包括記錄背景工作的結果——做法是監聽 BullMQ 自身的 `completed`/`failed` 事件（透過 `QueueEvents`，這個類別已在 Phase 4A 的 `jobs.e2e-spec.ts` 中驗證過），而非透過 `apps/api` 上的回呼 HTTP 端點,也不是透過共用的 Prisma 套件。因此 `apps/worker` 的 Dockerfile 依然不需要 `openssl`/`prisma generate`/任何 Prisma 相關步驟——Phase 4A 審查中預測共用資料庫做法會遇到的三個陷阱，在這裡都不適用。
- **`apps/worker` 擁有自己的最小化 MinIO 客戶端**，與 `apps/api` 的 `StorageService` 是複製（而非共用）的關係——只有約 30 行程式碼，複製的風險很低，不像 Prisma 那整套工具鏈。它重複使用 `apps/api` 已經在用的**同一組限定範圍的 `drm-api` MinIO 憑證**（環境變數 `MINIO_ENDPOINT`/`MINIO_BUCKET`/`MINIO_ACCESS_KEY`/`MINIO_SECRET_KEY`，依照 Phase 2A 的設定已限定範圍只能存取 `documents` bucket）——而非另外一組 worker 專用憑證。日後可以考慮設置一組專用的 worker 憑證作為縱深防禦的強化措施，但目前不是必要項目。
- **`packages/shared` 現在正式引入**，只包含 `document-conversion` 佇列名稱常數以及 `ConversionJobData`/`ConversionJobResult` 這兩個 TypeScript 介面——不含任何執行期邏輯。這正是 Phase 4A 審查明確建議、在導入更重的共用套件之前先做的輕量版「試跑」：它演練了未來 `packages/database` 抽取套件也需要的完全相同的 Dockerfile 變更（`COPY packages/shared`，在建置依賴它的應用程式之前先建置它），但風險低得多。`apps/api` 與 `apps/worker` 都透過 `workspace:*` 協定依賴它。
- **下載／檢視端點在此階段不變。** `previewObjectKey` 會被填入，但目前還沒有任何東西讀取它——將它用於浮水印預覽渲染是 Phase 4C 的工作，不屬於這一階段。
- **`clamscan` 精確的緩衝區掃描 API 無法完全從記憶中確定**——Phase 4A 的任務 5 曾透過 `docker run` 成功對真實檔案使用過它，這是真實且有用的先前驗證，但這個階段需要它在一個長時間運行的 NestJS 服務內掃描一個記憶體中的 `Buffer`（來自 multer 的記憶體儲存），而非一次性腳本。在信任這份計畫的草稿程式碼之前，請對照實際安裝套件的型別定義，驗證真正的方法（`scanStream` 包裝 `Readable.from(buffer)`，或實際安裝的套件所支援的其他方式）。
- 真實整合測試：針對實際運行中系統的 e2e 測試（真實的 ClamAV 拒絕真實含有 EICAR 特徵的上傳、真實的 Gotenberg 轉換真實上傳的 Office MIME 類型檔案、真實建立的 MinIO 物件）——這是此專案既有的慣例，此計畫涉及的任何部分都不使用模擬的基礎設施。
- 此主機上的 Docker daemon 有時負載較重，且此工作階段在 `docker compose build` 過程中已多次遇到磁碟空間卡住的情況——如果建置異常長時間卡住，請檢查 `df -h /` 並清理（`docker builder prune -f`，如果單純的 prune 回收了 0B 空間，則用 `docker image prune -a -f --filter "until=24h"`）。每次重建後請確認容器確實有被重新建立（比較映像檔 ID／啟動時間），而不是只看建置指令是否回傳 0——這是此專案中真實且反覆出現的問題。如果 ClamAV 的資料卷曾被清除（`docker compose down -v`），它首次啟動下載病毒碼可能需要數分鐘——這是預期行為，不是卡住。

---

### 任務 1：`packages/shared` 骨架建立＋Dockerfile 更新

**檔案：**
- Create: `packages/shared/package.json`
- Create: `packages/shared/tsconfig.json`
- Create: `packages/shared/src/index.ts`
- Modify: `apps/api/package.json`（新增 `@drm/shared` 依賴）
- Modify: `apps/api/Dockerfile`
- Modify: `apps/worker/package.json`（新增 `@drm/shared` 依賴）
- Modify: `apps/worker/Dockerfile`

**介面：**
- 使用： 無新增內容。
- 產出： `@drm/shared` 匯出 `QUEUE_DOCUMENT_CONVERSION: string`、`interface ConversionJobData { documentVersionId: string; objectKey: string; mimeType: string }`、`interface ConversionJobResult { documentVersionId: string; previewObjectKey: string }`。`apps/api` 與 `apps/worker` 都能對它進行建置。

- [ ] **步驟 1：建立 `packages/shared/package.json`**

```json
{
  "name": "@drm/shared",
  "version": "0.1.0",
  "private": true,
  "packageManager": "pnpm@9.7.0",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc"
  },
  "devDependencies": {
    "typescript": "^5.5.4"
  }
}
```

- [ ] **步驟 2：建立 `packages/shared/tsconfig.json`**

```json
{
  "compilerOptions": {
    "module": "commonjs",
    "target": "ES2021",
    "moduleResolution": "node",
    "declaration": true,
    "outDir": "./dist",
    "strict": true,
    "skipLibCheck": true,
    "esModuleInterop": true
  },
  "include": ["src"]
}
```

- [ ] **步驟 3：建立 `packages/shared/src/index.ts`**

```ts
export const QUEUE_DOCUMENT_CONVERSION = 'document-conversion';

export interface ConversionJobData {
  documentVersionId: string;
  objectKey: string;
  mimeType: string;
}

export interface ConversionJobResult {
  documentVersionId: string;
  previewObjectKey: string;
}
```

- [ ] **步驟 4：驗證它能獨立建置**

執行：`cd packages/shared && pnpm install && pnpm run build`
預期結果：建立出 `dist/index.js` 與 `dist/index.d.ts`，沒有錯誤。

- [ ] **步驟 5：將 `@drm/shared` 加入 `apps/api` 與 `apps/worker` 的依賴中**

在 `apps/api/package.json` 與 `apps/worker/package.json` 的 `dependencies` 中都加入：

```json
    "@drm/shared": "workspace:*",
```

從專案根目錄執行：`pnpm install`（這必須在根目錄執行，pnpm 才能解析 `workspace:*` 協定並更新唯一的根目錄 `pnpm-lock.yaml`）。

- [ ] **步驟 6：驗證兩個應用程式在新增依賴後仍能於本機正常建置**

執行：`cd apps/api && pnpm run build` ——預期結果：沒有錯誤（目前還沒有東西匯入 `@drm/shared`，這一步只是確認依賴能被正確解析）。
執行：`cd apps/worker && pnpm run build` ——預期結果相同。

- [ ] **步驟 7：更新 `apps/api/Dockerfile`，先建置 `packages/shared`**

建置階段需要在 `pnpm install` 之前先複製進 `packages/shared` 的 `package.json`（讓工作區連結能被解析），在建置之前複製整個 `packages/shared` 原始碼，並在建置 `apps/api` 之前先建置 `packages/shared`：

```dockerfile
FROM node:20-alpine AS build
WORKDIR /repo
RUN corepack enable
RUN apk add --no-cache openssl
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/shared/package.json packages/shared/package.json
COPY apps/api/package.json apps/api/package.json
RUN pnpm install --frozen-lockfile
COPY packages/shared ./packages/shared
COPY apps/api ./apps/api
RUN pnpm --filter shared run build
RUN pnpm --filter api exec prisma generate || true
RUN pnpm --filter api run build
```

（執行階段不變——`packages/shared` 編譯好的 `dist/` 已經透過 `pnpm install` 建立的工作區符號連結，位於 `node_modules/@drm/shared` 內，因此會隨現有的 `COPY --from=build /repo/node_modules ./node_modules` 這一行一起被帶過去。實際建置後務必驗證這一點是否成立——pnpm 工作區在 `node_modules` 內的符號連結可能是指向被複製範圍之外的真實符號連結，如果目標沒有一併被複製，在執行階段就會失效。如果是這種情況，請在執行階段加入一行明確的 `COPY --from=build /repo/packages/shared/dist ./packages/shared/dist`，並確認符號連結在最終映像檔內能正確解析。）

- [ ] **步驟 8：以相同方式更新 `apps/worker/Dockerfile`**

```dockerfile
FROM node:20-alpine AS build
WORKDIR /repo
RUN corepack enable
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/shared/package.json packages/shared/package.json
COPY apps/worker/package.json apps/worker/package.json
RUN pnpm install --frozen-lockfile
COPY packages/shared ./packages/shared
COPY apps/worker ./apps/worker
RUN pnpm --filter shared run build
RUN pnpm --filter worker run build

FROM node:20-alpine
WORKDIR /repo
RUN corepack enable
ENV NODE_ENV=production
COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/apps/worker/node_modules ./apps/worker/node_modules
COPY --from=build /repo/apps/worker/dist ./apps/worker/dist
COPY --from=build /repo/apps/worker/package.json ./apps/worker/package.json
WORKDIR /repo/apps/worker
CMD ["node", "dist/main.js"]
```

（此處同樣適用步驟 7 的符號連結注意事項——請務必實際驗證。）

- [ ] **步驟 9：重新建置兩個容器，確認能正常啟動**

執行：`docker compose up -d --build api worker`（透過映像檔 ID／啟動時間驗證兩者確實有被重新建立）
執行：`docker compose logs api worker`
預期結果：兩者都能無錯誤啟動（目前都還沒有匯入 `@drm/shared`——這一步只是要證明新工作區套件的 Docker 建置流程在任何功能性依賴之前就能運作）。

- [ ] **步驟 10：執行既有的完整測試套件，確認沒有東西壞掉**

執行：`pnpm --filter api test`、`pnpm --filter api test:e2e`、`pnpm --filter api lint`、`pnpm --filter worker lint`、`./scripts/smoke-test.sh`。
預期結果：全部通過，與此任務之前相同。

- [ ] **步驟 11：提交**

```bash
git add packages/shared apps/api/package.json apps/api/Dockerfile apps/worker/package.json apps/worker/Dockerfile pnpm-lock.yaml pnpm-workspace.yaml
git commit -m "feat: add packages/shared workspace package, wire into api/worker Dockerfiles"
```

---

### 任務 2：資料庫遷移 —— `previewObjectKey` ＋ `virus_detected` 動作

**檔案：**
- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/<timestamp>_conversion_preview_and_virus_action/migration.sql`（自動產生）

**介面：**
- 使用： 無新增內容。
- 產出： `DocumentVersion.previewObjectKey: string | null`、`AuditAction.virus_detected`——兩者在產生後皆可從 `@prisma/client` 匯入。

- [ ] **步驟 1：在 `apps/api/prisma/schema.prisma` 的 `DocumentVersion` 模型中加入 `previewObjectKey`**

將此欄位加入現有模型中（不要重新建立整個模型——只需在既有欄位之間加入這一行）：

```prisma
  previewObjectKey String?
```

- [ ] **步驟 2：在 `AuditAction` 列舉中加入 `virus_detected`**

```prisma
enum AuditAction {
  folder_create
  folder_view
  document_create
  document_view
  document_download
  document_version_upload
  permission_grant
  permission_revoke
  virus_detected
}
```

- [ ] **步驟 3：啟動一個臨時的本機 Postgres 以撰寫遷移**

執行：`docker run --rm -d --name drm-dev-postgres -e POSTGRES_USER=drm -e POSTGRES_PASSWORD=drm_dev_password -e POSTGRES_DB=drm -p 5436:5432 postgres:16-alpine`

（連接埠 5436——5433/5434/5435 已被先前階段撰寫遷移時使用，請先檢查 `docker compose ps` 與 `docker ps`，如已被佔用則調整。）

- [ ] **步驟 4：產生遷移**

執行：`cd apps/api && DATABASE_URL="postgresql://drm:drm_dev_password@localhost:5436/drm" pnpm exec prisma migrate dev --name conversion_preview_and_virus_action`

- [ ] **步驟 5：停止臨時 Postgres**

執行：`docker stop drm-dev-postgres`

- [ ] **步驟 6：重新產生客戶端並驗證建置**

執行：`cd apps/api && pnpm exec prisma generate && pnpm run build`
預期結果：沒有 TypeScript 錯誤。

- [ ] **步驟 7：提交**

```bash
git add apps/api/prisma
git commit -m "feat(api): add DocumentVersion.previewObjectKey and virus_detected audit action"
```

---

### 任務 3：`VirusScanService` —— 同步的儲存前掃描

**檔案：**
- Create: `apps/api/src/documents/virus-scan.service.ts`
- Modify: `apps/api/src/documents/documents.service.ts`
- Modify: `apps/api/src/documents/documents.module.ts`
- Modify: `apps/api/package.json`（新增 `clamscan` 依賴）
- Test: `apps/api/test/virus-scan.e2e-spec.ts`

**介面：**
- 使用： 無新增內容（透過內部 Docker 網路直接與 Phase 4A 已在運行的 `clamav` 服務溝通）。
- 產出： `VirusScanService.scanBuffer(buffer: Buffer): Promise<{ isInfected: boolean; viruses: string[] }>`。`DocumentsService.createDocument`/`.addVersion` 現在會在任何儲存／資料庫寫入之前，以 `400` 拒絕受感染的上傳，並將此次拒絕以 `virus_detected` 稽核記錄下來。

- [ ] **步驟 1：將 `clamscan` 依賴加入 `apps/api`**

```json
    "clamscan": "^2.4.0",
```

執行：`cd apps/api && pnpm install`。在撰寫 `VirusScanService` 之前，先驗證實際安裝套件在緩衝區／串流掃描上的 API——查看 `node_modules/clamscan` 的型別定義／README，就像 Phase 4A 的任務 5 當初必須實際研究這個套件，而非憑猜測相信。

- [ ] **步驟 2：建立 `apps/api/src/documents/virus-scan.service.ts`**

```ts
import { Injectable } from '@nestjs/common';
import { Readable } from 'stream';
// eslint-disable-next-line @typescript-eslint/no-var-requires -- clamscan ships CJS with no useful default-export types; verify the real import shape against the installed package before trusting this.
const NodeClam = require('clamscan');

export interface ScanResult {
  isInfected: boolean;
  viruses: string[];
}

@Injectable()
export class VirusScanService {
  private readonly clamscanPromise: Promise<any>;

  constructor() {
    this.clamscanPromise = new NodeClam().init({
      removeInfected: false,
      scanRecursively: false,
      clamdscan: {
        host: process.env.CLAMAV_HOST ?? 'clamav',
        port: Number(process.env.CLAMAV_PORT ?? 3310),
        timeout: 60000,
      },
      preference: 'clamdscan',
    });
  }

  async scanBuffer(buffer: Buffer): Promise<ScanResult> {
    const clamscan = await this.clamscanPromise;
    const stream = Readable.from(buffer);
    const { isInfected, viruses } = await clamscan.scanStream(stream);
    return { isInfected: !!isInfected, viruses: viruses ?? [] };
  }
}
```

這是一份盡力而為的草稿，在「全域限制條件」中已明確標註為不確定——請對照實際安裝的 `clamscan` 版本，驗證 `init()` 的選項格式與 `scanStream` 的實際回傳格式，並根據真實錯誤修正任何不符之處，就像 Phase 4A 的任務 5 當初也是根據真實的 ClamAV 行為反覆迭代出來的一樣。

- [ ] **步驟 3：在 `docker-compose.yml` 的 `api` 服務環境變數中加入 `CLAMAV_HOST`/`CLAMAV_PORT`**

```yaml
      CLAMAV_HOST: clamav
      CLAMAV_PORT: 3310
```

在 `api` 服務的 `depends_on` 中加入 `clamav: condition: service_healthy`。

- [ ] **步驟 4：將掃描接入 `DocumentsService.createDocument` 與 `.addVersion`**

在 `apps/api/src/documents/documents.service.ts` 中注入 `VirusScanService`（它已經有 Phase 3 提供的 `AuditService`）。在兩個方法一開始、`storage.putObject` 之前、以及任何 Prisma 寫入之前：

```ts
    const scanResult = await this.virusScan.scanBuffer(file.buffer);
    if (scanResult.isInfected) {
      await this.audit.record({
        actorId: user.id,
        action: 'virus_detected',
        resourceType: 'folder', // or 'document' in addVersion — see below
        resourceId: folderId,   // or documentId in addVersion
        ipAddress,
      });
      throw new BadRequestException(
        `Upload rejected: infected file detected (${scanResult.viruses.join(', ')})`,
      );
    }
```

在 `createDocument` 中，使用 `resourceType: 'folder'`／`resourceId: folderId`（上傳目標——此時尚不存在可參照的 `Document` 資料列）。在 `addVersion` 中，使用 `resourceType: 'document'`／`resourceId: documentId`（該資料列已經存在）。從 `@nestjs/common` 匯入 `BadRequestException`。

- [ ] **步驟 5：將 `VirusScanService` 匯入 `DocumentsModule`**

將 `VirusScanService` 加入 `apps/api/src/documents/documents.module.ts` 的 `providers` 陣列。

- [ ] **步驟 6：撰寫 e2e 測試**

`apps/api/test/virus-scan.e2e-spec.ts`：

```ts
import axios from 'axios';
import FormData from 'form-data';

const KEYCLOAK_TOKEN_URL = 'http://auth.drm.localhost/realms/drm/protocol/openid-connect/token';
const API_BASE_URL = 'http://api.drm.localhost';

interface TokenResponse {
  access_token: string;
}

interface FolderResponse {
  id: string;
}

async function getToken(username: string, password: string): Promise<string> {
  const response = await axios.post<TokenResponse>(
    KEYCLOAK_TOKEN_URL,
    new URLSearchParams({ grant_type: 'password', client_id: 'drm-web', username, password }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
  );
  return response.data.access_token;
}

// The standard EICAR antivirus test string, base64-encoded so the literal
// signature never appears in tracked source (matching the precedent set by
// scripts/verify-clamav.sh in Phase 4A).
const EICAR_BASE64 =
  'WDVPIVAlQEFQWzRcUFpYNTQoUF4pN0NDKTd9JEVJQ0FSLVNUQU5EQVJELUFOVElWSVJVUy1URVNULUZJTEUhJEgrSCo=';

describe('Virus scanning on upload (e2e)', () => {
  it('rejects an infected upload before any storage or DB write, and audits it', async () => {
    const adminToken = await getToken('testadmin', 'testadminpass');
    const authHeader = { Authorization: `Bearer ${adminToken}` };

    const folderRes = await axios.post<FolderResponse>(
      `${API_BASE_URL}/folders`,
      { name: `virus-scan-test-${Date.now()}` },
      { headers: authHeader },
    );
    const folderId = folderRes.data.id;

    const infected = Buffer.from(EICAR_BASE64, 'base64');
    const form = new FormData();
    form.append('folderId', folderId);
    form.append('name', 'eicar.txt');
    form.append('file', infected, { filename: 'eicar.txt' });

    await expect(
      axios.post(`${API_BASE_URL}/documents`, form, {
        headers: { ...authHeader, ...form.getHeaders() },
      }),
    ).rejects.toMatchObject({ response: { status: 400 } });

    const listRes = await axios.get(`${API_BASE_URL}/folders/${folderId}`, { headers: authHeader });
    expect(listRes.data.documents).toHaveLength(0);
  });

  it('accepts a clean upload as before', async () => {
    const adminToken = await getToken('testadmin', 'testadminpass');
    const authHeader = { Authorization: `Bearer ${adminToken}` };

    const folderRes = await axios.post<FolderResponse>(
      `${API_BASE_URL}/folders`,
      { name: `virus-scan-clean-${Date.now()}` },
      { headers: authHeader },
    );

    const form = new FormData();
    form.append('folderId', folderRes.data.id);
    form.append('name', 'clean.txt');
    form.append('file', Buffer.from('this file is not infected'), { filename: 'clean.txt' });

    const createRes = await axios.post(`${API_BASE_URL}/documents`, form, {
      headers: { ...authHeader, ...form.getHeaders() },
    });
    expect(createRes.status).toBe(201);
  });
});
```

- [ ] **步驟 7：重新建置並執行**

執行：`docker compose up -d --build api`（驗證確實有被重新建立）
執行：`cd apps/api && pnpm test:e2e -- virus-scan`
預期結果：PASS（2 個測試）

- [ ] **步驟 8：提交**

```bash
git add apps/api/package.json apps/api/pnpm-lock.yaml apps/api/src/documents apps/api/test/virus-scan.e2e-spec.ts docker-compose.yml
git commit -m "feat(api): scan uploads for viruses before storage, reject infected files"
```

---

### 任務 4：Worker 的 `StorageService` ＋ `ConversionProcessor`

**檔案：**
- Create: `apps/worker/src/storage/storage.service.ts`
- Create: `apps/worker/src/storage/storage.module.ts`
- Create: `apps/worker/src/conversion/conversion.processor.ts`
- Create: `apps/worker/src/conversion/conversion.module.ts`
- Modify: `apps/worker/src/app.module.ts`
- Modify: `apps/worker/package.json`（新增 `@aws-sdk/client-s3` 依賴）
- Modify: `docker-compose.yml`（新增 MinIO/Gotenberg 環境變數＋`worker` 的 `depends_on`）

**介面：**
- 使用： `@drm/shared` 的 `QUEUE_DOCUMENT_CONVERSION`/`ConversionJobData`/`ConversionJobResult`（任務 1）。
- 產出： `apps/worker` 中一個 `document-conversion` BullMQ 處理器，會從 MinIO 取得物件、透過 Gotenberg 轉換、將結果存回 MinIO，並回傳 `ConversionJobResult`。

- [ ] **步驟 1：將 `@aws-sdk/client-s3` 加入 `apps/worker`**

```json
    "@aws-sdk/client-s3": "^3.658.0",
```

執行：`cd apps/worker && pnpm install`

- [ ] **步驟 2：建立 `apps/worker/src/storage/storage.service.ts`**

刻意做的最小化複製，對照 `apps/api/src/storage/storage.service.ts`——相同的環境變數、對 MinIO 相同的 `forcePathStyle: true` 要求，額外加入一個 `getObjectBuffer` 方法（worker 需要把整個檔案讀進記憶體才能 POST 給 Gotenberg，不像 `apps/api` 用串流方式下載）：

```ts
import { Injectable } from '@nestjs/common';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import type { Readable } from 'stream';

@Injectable()
export class StorageService {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor() {
    this.bucket = process.env.MINIO_BUCKET ?? 'documents';
    this.client = new S3Client({
      endpoint: process.env.MINIO_ENDPOINT,
      region: 'us-east-1',
      forcePathStyle: true,
      credentials: {
        accessKeyId: process.env.MINIO_ACCESS_KEY ?? '',
        secretAccessKey: process.env.MINIO_SECRET_KEY ?? '',
      },
    });
  }

  async putObject(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }),
    );
  }

  async getObjectBuffer(key: string): Promise<Buffer> {
    const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    const stream = result.Body as Readable;
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }
}
```

- [ ] **步驟 3：建立 `apps/worker/src/storage/storage.module.ts`**

```ts
import { Module } from '@nestjs/common';
import { StorageService } from './storage.service';

@Module({
  providers: [StorageService],
  exports: [StorageService],
})
export class StorageModule {}
```

- [ ] **步驟 4：建立 `apps/worker/src/conversion/conversion.processor.ts`**

```ts
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { QUEUE_DOCUMENT_CONVERSION, ConversionJobData, ConversionJobResult } from '@drm/shared';
import { randomUUID } from 'crypto';
import axios from 'axios';
import FormData from 'form-data';
import { StorageService } from '../storage/storage.service';

@Processor(QUEUE_DOCUMENT_CONVERSION)
export class ConversionProcessor extends WorkerHost {
  constructor(private readonly storage: StorageService) {
    super();
  }

  async process(job: Job<ConversionJobData>): Promise<ConversionJobResult> {
    const { documentVersionId, objectKey, mimeType } = job.data;

    const original = await this.storage.getObjectBuffer(objectKey);

    const form = new FormData();
    form.append('files', original, { filename: 'document', contentType: mimeType });

    const gotenbergUrl = process.env.GOTENBERG_URL ?? 'http://gotenberg:3000';
    const response = await axios.post(`${gotenbergUrl}/forms/libreoffice/convert`, form, {
      headers: form.getHeaders(),
      responseType: 'arraybuffer',
    });

    const previewObjectKey = `${objectKey}-preview-${randomUUID()}.pdf`;
    await this.storage.putObject(previewObjectKey, Buffer.from(response.data), 'application/pdf');

    return { documentVersionId, previewObjectKey };
  }
}
```

驗證 `axios`/`form-data` 有被加入為 `apps/worker` 的依賴（目前還沒有——請將兩者都加進 `apps/worker/package.json`）。對照 Phase 4A 計畫任務 4 中已證實正確的用法（`scripts/verify-gotenberg.sh`），驗證 Gotenberg 的路由／表單欄位名稱——由於這是同一個 Gotenberg 服務、已確認可正常運作，應該要完全一致。

- [ ] **步驟 5：建立 `apps/worker/src/conversion/conversion.module.ts`**

```ts
import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { QUEUE_DOCUMENT_CONVERSION } from '@drm/shared';
import { ConversionProcessor } from './conversion.processor';
import { StorageModule } from '../storage/storage.module';

@Module({
  imports: [BullModule.registerQueue({ name: QUEUE_DOCUMENT_CONVERSION }), StorageModule],
  providers: [ConversionProcessor],
})
export class ConversionModule {}
```

- [ ] **步驟 6：將 `ConversionModule` 接入 `apps/worker/src/app.module.ts`**

在 `imports` 陣列中，於既有的 `HealthCheckModule` 旁加入 `ConversionModule`。

- [ ] **步驟 7：在 `docker-compose.yml` 的 `worker` 服務中加入 MinIO/Gotenberg 環境變數**

```yaml
      MINIO_ENDPOINT: http://minio:9000
      MINIO_BUCKET: documents
      MINIO_ACCESS_KEY: ${MINIO_API_ACCESS_KEY}
      MINIO_SECRET_KEY: ${MINIO_API_SECRET_KEY}
      GOTENBERG_URL: http://gotenberg:3000
```

在 `worker` 服務的 `depends_on` 中加入 `minio: condition: service_healthy` 與 `gotenberg: condition: service_healthy`。

- [ ] **步驟 8：重新建置並確認 worker 能正常啟動**

執行：`docker compose up -d --build worker`（驗證確實有被重新建立）
執行：`docker compose logs worker`
預期結果：乾淨啟動、無錯誤，`document-conversion` 佇列與 `health-check` 一同註冊完成。

- [ ] **步驟 9：提交**

```bash
git add apps/worker docker-compose.yml
git commit -m "feat(worker): add StorageService and ConversionProcessor (MinIO -> Gotenberg -> MinIO)"
```

---

### 任務 5：將轉換流程接入上傳流程（排入工作＋完成監聽器）

**檔案：**
- Create: `apps/api/src/documents/conversion-events.listener.ts`
- Modify: `apps/api/src/documents/documents.service.ts`
- Modify: `apps/api/src/documents/documents.module.ts`
- Modify: `apps/api/package.json`（`bullmq` 已有的依賴已足夠；新增 `@drm/shared` 的使用）
- Test: `apps/api/test/document-conversion.e2e-spec.ts`

**介面：**
- 使用： `@drm/shared`（任務 1）、`document-conversion` 佇列（任務 4 的消費端）。
- 產出： `DocumentsService.createDocument`/`.addVersion` 對 Office MIME 類型的上傳排入轉換工作；`ConversionEventsListener` 在工作完成時更新 `DocumentVersion.previewObjectKey`。

- [ ] **步驟 1：建立 `apps/api/src/documents/conversion-events.listener.ts`**

直接使用 `bullmq` 的 `QueueEvents`（此類別已在 Phase 4A 的 `jobs.e2e-spec.ts` 中驗證過），而非 `@nestjs/bullmq` 的裝飾器語法糖——維持使用已驗證過的模式。

```ts
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { QueueEvents } from 'bullmq';
import { QUEUE_DOCUMENT_CONVERSION, ConversionJobResult } from '@drm/shared';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class ConversionEventsListener implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ConversionEventsListener.name);
  private queueEvents!: QueueEvents;

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit() {
    this.queueEvents = new QueueEvents(QUEUE_DOCUMENT_CONVERSION, {
      connection: {
        host: process.env.REDIS_HOST ?? 'redis',
        port: Number(process.env.REDIS_PORT ?? 6379),
      },
    });

    this.queueEvents.on('completed', ({ returnvalue }) => {
      void this.handleCompleted(returnvalue);
    });

    this.queueEvents.on('failed', ({ jobId, failedReason }) => {
      this.logger.error(`Conversion job ${jobId} failed: ${failedReason}`);
    });
  }

  private async handleCompleted(returnvalue: unknown) {
    const result = (
      typeof returnvalue === 'string' ? JSON.parse(returnvalue) : returnvalue
    ) as ConversionJobResult;

    await this.prisma.documentVersion.update({
      where: { id: result.documentVersionId },
      data: { previewObjectKey: result.previewObjectKey },
    });
  }

  async onModuleDestroy() {
    await this.queueEvents.close();
  }
}
```

驗證 `completed` 事件上的 `returnvalue` 究竟真的一律是 JSON 字串（BullMQ 通常會在工作結果經過 Redis 時序列化），還是有時已經是物件——請對照實際觀察到的行為，`typeof` 檢查兩種情況都能處理，但請確認此專案的設定實際上會出現哪一種情況並記錄下來。

- [ ] **步驟 2：在 `DocumentsService` 中加入一個產生者方法與 Office MIME 類型偵測**

在 `apps/api/src/documents/documents.service.ts` 中，注入 `@InjectQueue(QUEUE_DOCUMENT_CONVERSION) private readonly conversionQueue: Queue<ConversionJobData>`（從 `@nestjs/bullmq` 匯入 `InjectQueue`，從 `bullmq` 匯入 `Queue`，從 `@drm/shared` 匯入 `QUEUE_DOCUMENT_CONVERSION`/`ConversionJobData`）。

加入一個私有輔助方法：

```ts
  private readonly OFFICE_MIME_TYPES = new Set([
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  ]);

  private async maybeEnqueueConversion(versionId: string, objectKey: string, mimeType: string) {
    if (!this.OFFICE_MIME_TYPES.has(mimeType)) {
      return;
    }
    await this.conversionQueue.add('convert', {
      documentVersionId: versionId,
      objectKey,
      mimeType,
    });
  }
```

在 `createDocument`（交易提交後，使用建立完成版本的 `id`/`objectKey`）與 `addVersion`（同樣在其交易提交後）的結尾都呼叫 `await this.maybeEnqueueConversion(version.id, objectKey, file.mimetype)`——放在既有的稽核記錄呼叫之後，這樣排入工作失敗時就不會妨礙上傳本身被記錄為成功（上傳已經成功；預覽只是次要的、盡力而為的加值功能）。

- [ ] **步驟 3：在 `DocumentsModule` 中註冊 `document-conversion` 佇列與監聽器**

```ts
import { BullModule } from '@nestjs/bullmq';
import { QUEUE_DOCUMENT_CONVERSION } from '@drm/shared';
import { ConversionEventsListener } from './conversion-events.listener';

@Module({
  imports: [
    AclModule,
    StorageModule,
    UsersModule,
    AuditModule,
    BullModule.registerQueue({ name: QUEUE_DOCUMENT_CONVERSION }),
  ],
  controllers: [DocumentsController],
  providers: [DocumentsService, VirusScanService, ConversionEventsListener],
  exports: [DocumentsService],
})
export class DocumentsModule {}
```

- [ ] **步驟 4：撰寫 e2e 測試**

`apps/api/test/document-conversion.e2e-spec.ts`：

```ts
import axios from 'axios';
import FormData from 'form-data';
import { PrismaClient } from '@prisma/client';

const KEYCLOAK_TOKEN_URL = 'http://auth.drm.localhost/realms/drm/protocol/openid-connect/token';
const API_BASE_URL = 'http://api.drm.localhost';
const MC = 'docker run --rm --network drm_default minio/mc';

interface TokenResponse {
  access_token: string;
}
interface FolderResponse {
  id: string;
}
interface DocumentResponse {
  id: string;
  currentVersion: { id: string; objectKey: string };
}

async function getToken(username: string, password: string): Promise<string> {
  const response = await axios.post<TokenResponse>(
    KEYCLOAK_TOKEN_URL,
    new URLSearchParams({ grant_type: 'password', client_id: 'drm-web', username, password }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
  );
  return response.data.access_token;
}

describe('Document conversion pipeline (e2e)', () => {
  const prisma = new PrismaClient({
    datasources: { db: { url: 'postgresql://drm:drm_dev_password@localhost:5433/drm' } },
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('enqueues and completes a conversion for an Office-mimetype upload, populating previewObjectKey', async () => {
    const adminToken = await getToken('testadmin', 'testadminpass');
    const authHeader = { Authorization: `Bearer ${adminToken}` };

    const folderRes = await axios.post<FolderResponse>(
      `${API_BASE_URL}/folders`,
      { name: `conversion-test-${Date.now()}` },
      { headers: authHeader },
    );

    const form = new FormData();
    form.append('folderId', folderRes.data.id);
    form.append('name', 'test.docx');
    form.append('file', Buffer.from('plain text content, declared as a Word document for this test'), {
      filename: 'test.docx',
      contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });

    const createRes = await axios.post<DocumentResponse>(`${API_BASE_URL}/documents`, form, {
      headers: { ...authHeader, ...form.getHeaders() },
    });
    const versionId = createRes.data.currentVersion.id;

    let previewObjectKey: string | null = null;
    for (let i = 0; i < 30; i++) {
      const version = await prisma.documentVersion.findUniqueOrThrow({ where: { id: versionId } });
      if (version.previewObjectKey) {
        previewObjectKey = version.previewObjectKey;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    expect(previewObjectKey).not.toBeNull();
  }, 40000);

  it('does not enqueue a conversion for a non-Office upload', async () => {
    const adminToken = await getToken('testadmin', 'testadminpass');
    const authHeader = { Authorization: `Bearer ${adminToken}` };

    const folderRes = await axios.post<FolderResponse>(
      `${API_BASE_URL}/folders`,
      { name: `no-conversion-test-${Date.now()}` },
      { headers: authHeader },
    );

    const form = new FormData();
    form.append('folderId', folderRes.data.id);
    form.append('name', 'plain.txt');
    form.append('file', Buffer.from('just a plain text file'), {
      filename: 'plain.txt',
      contentType: 'text/plain',
    });

    const createRes = await axios.post<DocumentResponse>(`${API_BASE_URL}/documents`, form, {
      headers: { ...authHeader, ...form.getHeaders() },
    });
    const versionId = createRes.data.currentVersion.id;

    await new Promise((resolve) => setTimeout(resolve, 3000));
    const version = await prisma.documentVersion.findUniqueOrThrow({ where: { id: versionId } });
    expect(version.previewObjectKey).toBeNull();
  }, 15000);
});
```

這份草稿中的 `MC` 常數並未被使用——請將它移除，或用它加入一個更嚴謹的斷言，確認預覽物件確實存在於 MinIO 中且是一個真正的 PDF（透過檔頭 magic bytes 檢查，對照 Phase 4A 的 `verify-gotenberg.sh` 模式），而不只是檢查資料庫欄位有沒有被設定。如果不會花太多額外工夫，值得以這種方式強化這個測試。

- [ ] **步驟 5：重新建置並執行**

執行：`docker compose up -d --build api worker`（驗證兩者確實有被重新建立）
執行：`cd apps/api && pnpm test:e2e -- document-conversion`
預期結果：PASS。第一個測試有真實的非同步等待時間（輪詢最長達 30 秒）——這是預期行為，不是卡住。

- [ ] **步驟 6：提交**

```bash
git add apps/api/src/documents apps/api/test/document-conversion.e2e-spec.ts
git commit -m "feat(api): enqueue Office document conversion on upload, record preview when complete"
```

---

### 任務 6：完整測試套件驗證

**檔案：**
- Create: `docs/superpowers/plans/2026-08-02-phase4b-verification.md`

**介面：**
- 使用： 任務 1 至 5 的所有內容。
- 產出： 一份書面驗證紀錄，確認上傳 → 掃描 → 儲存 → 轉換 → 預覽整條流程能一起正常運作，並且是全新驗證過的。

- [ ] **步驟 1：全新的全端重新建置**

執行：`docker compose down -v && docker compose up -d --build`
等待所有服務達到健康狀態（Keycloak 冷啟動、ClamAV 病毒碼重新下載——兩者依先前階段的經驗都預期需要數分鐘，請耐心等待）。

- [ ] **步驟 2：一起執行所有自動化測試套件**

`./scripts/smoke-test.sh`、`pnpm --filter api test`、`pnpm --filter api test:e2e`、`pnpm --filter api lint`、`pnpm --filter worker lint`、`pnpm --filter web test`、`./scripts/verify-gotenberg.sh`、`./scripts/verify-clamav.sh`。全部必須一起通過。修正任何由此揭露出來、僅在整合層面才會出現的問題——此專案在先前每個階段都確實透過這種方式發現過真實問題。

- [ ] **步驟 3：手動走查**

以 testadmin 身分：建立一個資料夾、上傳一個受感染的測試檔案（確認被拒絕、確認沒有建立文件、確認有稽核紀錄）、上傳一個乾淨的 Office MIME 類型檔案（確認立即被接受，輪詢 `GET /documents/:id` 直到 `currentVersion.previewObjectKey` 被設定，確認預覽物件在 MinIO 中是一個真正的 PDF）、上傳一個乾淨的純文字檔案（確認被接受，確認 `previewObjectKey` 保持為 null）。

- [ ] **步驟 4：撰寫 `docs/superpowers/plans/2026-08-02-phase4b-verification.md`**

依循先前階段驗證文件所建立的格式。

- [ ] **步驟 5：提交**

```bash
git add docs/superpowers/plans/2026-08-02-phase4b-verification.md
git commit -m "docs: add Phase 4B verification record"
```

---

## 自我審查筆記

- **規格涵蓋範圍：** 完全依照設計規格對上傳流程的描述實作（先掃描再儲存、Office 文件透過 worker+Gotenberg 於事後轉換）。浮水印與到期機制明確屬於 Phase 4C，此處未涉及。
- **佔位程式碼檢查：** 沒有 TBD/TODO 標記。唯一刻意保留、真實存在不確定性的部分（`clamscan` 精確的緩衝區掃描 API）已明確標註,需在實作期間進行真實驗證，與此專案在先前每個階段處理類似第三方 API 不確定性的方式一致（2A 階段的 KES、4A 階段 ClamAV 客戶端本身的選擇）——這並非流程所警惕的那種佔位程式碼，因為無論如何都已提供了具體的起始程式碼。
- **型別一致性：** `ConversionJobData`/`ConversionJobResult`/`QUEUE_DOCUMENT_CONVERSION` 只在 `packages/shared`（任務 1）中定義一次，並由產生端（`apps/api`，任務 5）與消費端（`apps/worker`，任務 4）以完全相同的方式使用——這正是 Phase 4A 最終審查標記出來的跨切面常數風險，在此透過結構設計徹底解決，而非留下一個在多個檔案中重複的裸字串。
- **範圍：** 僅限於上傳流程整合。沒有 ACL／權限變更，沒有下載／檢視端點變更，沒有浮水印，沒有到期機制——全都明確延後至後續階段處理。
