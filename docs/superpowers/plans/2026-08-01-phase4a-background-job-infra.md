# Phase 4A：背景工作基礎設施實作計畫

> **給代理型工作者的注意事項：** 必要子技能：使用 superpowers:subagent-driven-development（建議）或 superpowers:executing-plans 逐一任務執行此計畫。步驟使用核取方塊（`- [ ]`）語法進行追蹤。

**目標：** 建立背景工作處理鏈——Redis、BullMQ、新的 `apps/worker` 行程、Gotenberg（Office→PDF 轉換）以及 ClamAV（病毒掃描）——並透過實際將工作加入佇列並確認 worker 處理該工作、實際透過 Gotenberg 轉換一份測試文件，以及實際透過 ClamAV 偵測已知的測試病毒特徵碼，來進行端對端驗證。此階段不涉及任何文件上傳的商業邏輯變更——這個階段純粹是基礎設施，與 Phase 2A/2B 針對儲存體所採用的相同拆分方式一致。

**架構：** 新增一個 NestJS 行程 `apps/worker`，與 `apps/api` 並行執行——沒有 HTTP 伺服器，只有一個透過 `@nestjs/bullmq` 從 Redis 消費工作的 BullMQ `Worker`。`apps/api` 新增一個 `JobsModule`，可以將工作加入具名的 BullMQ 佇列。Gotenberg 與 ClamAV 則以各自獨立的 Docker Compose 服務新增，並可從 `apps/worker` 存取（Phase 4B 才會是真正在實際上傳流程中呼叫它們的階段——本階段只是證明它們能正常運作）。

**技術堆疊：** Redis 7、BullMQ（`bullmq` + `@nestjs/bullmq`）、Gotenberg（`gotenberg/gotenberg`）、ClamAV（`clamav/clamav`，daemon 模式）、針對實際執行中服務的 Jest e2e 測試（此專案既有的測試慣例——不使用模擬的基礎設施）。

## 全域限制

- **本階段僅新增基礎設施。** 不變更 `FoldersService`/`DocumentsService`/`PermissionsService`，不在 `Document` 上新增欄位（`watermarkEnabled`/`expiresAt` 是 Phase 4C 的工作），也不將上傳流程接上 Gotenberg/ClamAV（那是 Phase 4B 的工作）。唯一面向業務的新介面是一個純粹用來證明流程可運作的 `health-check` BullMQ 佇列——除了本階段自身的驗證之外，它沒有任何產品用途。
- **本階段中 `apps/worker` 刻意不具備任何 Prisma／資料庫存取權限。** Phase 4B 的工作（文件轉換、病毒掃描）將需要讀寫 `Document`/`DocumentVersion` 資料列並與 MinIO 溝通——究竟該將 `apps/api` 的 Prisma schema 複製一份到 `apps/worker`，還是抽取出一個共用的 `packages/database` workspace 套件，這是一項真正的設計決策，無論選哪一種都需要中等規模的重構，因此明確地**延後到 Phase 4B** 再決定，本計畫不在此處決定。讓本階段保持無資料庫存取，可以避免過早做出這項決定。
- **Redis、Gotenberg 與 ClamAV 都是新的 Docker Compose 服務。** Redis 會發布到主機的 loopback 位址上的 `6380` 連接埠（而非 `6379`——因為該連接埠已被此主機上另一個無關專案的容器 `isms-redis-1` 使用；這與本專案先前在 Phase 1 中，因為 `5432` 已被占用而為 Postgres 選用替代連接埠的既有模式一致）。Gotenberg 與 ClamAV 則只在內部使用（不需要發布主機連接埠——沒有任何 Docker 網路以外的東西需要直接與它們溝通；驗證腳本會以一次性容器的形式在同一個 Docker 網路上執行，這與 `scripts/verify-encrypted-storage.sh` 已建立的模式一致）。
- **`@nestjs/bullmq` 的確切 API（裝飾器名稱、`BullModule.forRoot`/`registerQueue` 的選項形狀）無法保證單靠記憶就正確** ——本計畫提供一個具體的、盡力而為的起點，但在信任它之前，務必對照實際安裝套件的型別／文件進行核實，這與 Phase 2A 針對 KES 設定 schema 所採用的、明確揭露不確定性的方式相同。
- **ClamAV 的 clamd 通訊協定不自行手刻實作。** 針對 `INSTREAM` 協定，應使用成熟的 npm 客戶端函式庫，而非手動實作長度前綴的分塊封裝——在採用之前，務必先確認確實存在可用且能正常運作的套件；若真的沒有合適的套件，手刻實作只是備援方案，而非預設做法。
- **ClamAV 第一次啟動時會從外部鏡像站下載病毒特徵資料庫，可能會很慢**（可能長達數分鐘，視網路狀況而定）——這是一個真實且已揭露的營運風險，如果容器第一次需要一段時間才能就緒，並不代表有錯誤。在未先確認實際啟動行為之前，不要假設較短的健康檢查逾時設定就能運作。
- 真實的整合測試：worker 的工作處理能力，透過一個直接與真實 Redis 溝通的 e2e 測試來證明（直接使用 BullMQ 的 `Queue` 類別，繞過 HTTP——遵循與 `storage.e2e-spec.ts` 相同的「測試真實事物，而非包裝層」模式），並確認真正的 `apps/worker` 容器確實處理了該工作，而不僅僅是該工作被加入了佇列。
- 此主機上的 Docker daemon 有時會因無關的行程而處於高負載狀態，本次工作階段也曾多次在 `docker compose build` 過程中遇到磁碟空間不足而卡住的情況——如果建置作業異常地卡住很久，請檢查 `df -h /` 並清理（`docker builder prune -f`、`docker image prune -f`，若一般清理回收了 0B，則可更積極地使用 `docker image prune -a -f --filter "until=48h"`）。在任何重新建置之後，務必確認容器確實被重新建立（比對 image ID／啟動時間），而不只是確認建置指令回傳結束碼 0——這是本專案中一個真實且反覆出現的問題。

---

### 任務 1：`apps/api` 中的 Redis 服務 + BullMQ 生產者

**檔案：**
- 修改：`docker-compose.yml`（新增 `redis` 服務與 volume）
- 修改：`.env.example`（如果需要任何 Redis 憑證——對於這種僅供內部使用的開發／單一 VM 部署而言，不需驗證的一般 Redis 即可，這與本專案對內部服務既有的做法一致；請明確記錄這一點，而不要悄悄地自行決定）
- 建立：`apps/api/src/jobs/jobs.module.ts`
- 建立：`apps/api/src/jobs/health-check.service.ts`
- 修改：`apps/api/src/app.module.ts`

**介面：**
- 使用：無新增項目。
- 產出：一個可從 `apps/api` 存取的 `health-check` BullMQ 佇列；`HealthCheckService.enqueuePing(): Promise<string>`（回傳已加入佇列之工作的 id），供任務 3 的 e2e 測試使用。

- [ ] **步驟 1：在 `docker-compose.yml` 中新增 `redis`**

```yaml
  redis:
    image: redis:7-alpine
    command: redis-server --save "" --appendonly no
    ports:
      - "127.0.0.1:6380:6379"
    volumes:
      - redis_data:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 5s
      retries: 10
    restart: unless-stopped
```

（`--save "" --appendonly no` 會停用持久化——這個 Redis 實例純粹是 BullMQ 的工作佇列後端，而非真實資料的來源；如果重新啟動導致尚未處理的排隊工作遺失，在開發環境中是可以接受的取捨，並非任何持久性資料的遺失。`redis_data` volume 仍然會宣告，以備少數需要檢查資料的情況，但持久化功能本身是關閉的。）

在頂層的 `volumes:` 區塊中新增 `redis_data:`。

- [ ] **步驟 2：在 `apps/api` 中新增 BullMQ 相依套件**

新增到 `apps/api/package.json` 的 `dependencies`：

```json
    "@nestjs/bullmq": "^10.2.1",
    "bullmq": "^5.12.0",
```

執行：`cd apps/api && pnpm install`

在針對這些套件撰寫任何程式碼之前，請檢查實際安裝的型別定義（`node_modules/@nestjs/bullmq/dist/*.d.ts`，或該套件的 README）以確認真正的 API 形狀——以下程式碼只是盡力而為的草稿，並非保證正確。

- [ ] **步驟 3：建立 `apps/api/src/jobs/jobs.module.ts`**

```ts
import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { HealthCheckService } from './health-check.service';

@Module({
  imports: [
    BullModule.forRoot({
      connection: {
        host: process.env.REDIS_HOST ?? 'redis',
        port: Number(process.env.REDIS_PORT ?? 6379),
      },
    }),
    BullModule.registerQueue({
      name: 'health-check',
    }),
  ],
  providers: [HealthCheckService],
  exports: [HealthCheckService],
})
export class JobsModule {}
```

- [ ] **步驟 4：建立 `apps/api/src/jobs/health-check.service.ts`**

```ts
import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';

@Injectable()
export class HealthCheckService {
  constructor(@InjectQueue('health-check') private readonly queue: Queue) {}

  async enqueuePing(): Promise<string> {
    const job = await this.queue.add('ping', { requestedAt: new Date().toISOString() });
    return job.id!;
  }
}
```

- [ ] **步驟 5：在 `docker-compose.yml` 中為 `api` 服務的環境變數新增 `REDIS_HOST`/`REDIS_PORT`**

```yaml
      REDIS_HOST: redis
      REDIS_PORT: 6379
```

（這是內部 Docker 網路的位址／連接埠——步驟 1 中發布到 `127.0.0.1:6380` 的 loopback 僅供主機端測試存取使用，並不是 `api`/`worker` 容器之間互相溝通所使用的方式。）

在 `api` 服務的 `depends_on` 中新增 `redis: condition: service_healthy`。

- [ ] **步驟 6：將 `JobsModule` 接入 `AppModule`**

將 `JobsModule` 加入 `apps/api/src/app.module.ts` 中的 `imports` 陣列。

- [ ] **步驟 7：驗證建置與實際的工作加入佇列**

執行：`docker compose up -d --build api redis`（透過 image ID／啟動時間確認 `api` 容器確實被重新建立）
在兩者都變成健康狀態之後，確認可以從執行中的容器內部實際將一個工作加入佇列：

執行：`docker compose exec api node -e "const {Queue} = require('bullmq'); const q = new Queue('health-check', {connection: {host: 'redis', port: 6379}}); q.add('ping', {test: true}).then(j => { console.log('enqueued', j.id); process.exit(0); });"`

預期結果：印出 `enqueued <some-id>` 並以結束碼 0 結束。（目前還沒有 worker 在執行以消費該工作——這沒關係，該工作只是停留在佇列中；這個步驟只是要證明連線／加入佇列的路徑是可行的。）

- [ ] **步驟 8：提交（Commit）**

```bash
git add docker-compose.yml apps/api/package.json apps/api/pnpm-lock.yaml apps/api/src/jobs apps/api/src/app.module.ts
git commit -m "feat(infra): add Redis and BullMQ producer (health-check queue)"
```

---

### 任務 2：`apps/worker` 骨架 + health-check 處理器

**檔案：**
- 建立：`apps/worker/package.json`
- 建立：`apps/worker/tsconfig.json`
- 建立：`apps/worker/tsconfig.build.json`
- 建立：`apps/worker/nest-cli.json`
- 建立：`apps/worker/src/main.ts`
- 建立：`apps/worker/src/app.module.ts`
- 建立：`apps/worker/src/health-check/health-check.processor.ts`
- 建立：`apps/worker/src/health-check/health-check.module.ts`
- 建立：`apps/worker/Dockerfile`
- 修改：`docker-compose.yml`（新增 `worker` 服務）

**介面：**
- 使用：`health-check` BullMQ 佇列（任務 1）、同一個 Redis 實例。
- 產出：一個執行中的 `apps/worker` 行程，會從 `health-check` 佇列消費 `ping` 工作，並回傳一個具辨識度、可檢查的結果（供任務 3 的 e2e 測試使用）。

- [ ] **步驟 1：建立 `apps/worker/package.json`**

```json
{
  "name": "worker",
  "version": "0.1.0",
  "private": true,
  "packageManager": "pnpm@9.7.0",
  "scripts": {
    "build": "nest build",
    "start": "nest start",
    "start:dev": "nest start --watch"
  },
  "dependencies": {
    "@nestjs/bullmq": "^10.2.1",
    "@nestjs/common": "^10.4.0",
    "@nestjs/core": "^10.4.0",
    "bullmq": "^5.12.0",
    "reflect-metadata": "^0.2.2",
    "rxjs": "^7.8.1"
  },
  "devDependencies": {
    "@nestjs/cli": "^10.4.5",
    "@types/node": "^20.14.0",
    "typescript": "^5.5.4"
  }
}
```

（沒有 `@nestjs/platform-express`——這個行程從不提供 HTTP 服務，因此不需要它。這裡也沒有 `@nestjs/testing`/Jest——這個應用程式自身的邏輯完全透過任務 3 中 `apps/api` 的 e2e 測試來驗證，遵循本計畫全域限制中所述：此階段的驗證存在於整合層級，而不是為一個目前尚無商業邏輯的行程另外準備一套單元測試框架。）

- [ ] **步驟 2：建立 `apps/worker/tsconfig.json`**

```json
{
  "compilerOptions": {
    "module": "commonjs",
    "target": "ES2021",
    "moduleResolution": "node",
    "declaration": false,
    "sourceMap": true,
    "outDir": "./dist",
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true,
    "strict": true,
    "skipLibCheck": true,
    "esModuleInterop": true
  }
}
```

- [ ] **步驟 3：建立 `apps/worker/tsconfig.build.json`**

```json
{
  "extends": "./tsconfig.json",
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **步驟 4：建立 `apps/worker/nest-cli.json`**

```json
{
  "collection": "@nestjs/schematics",
  "sourceRoot": "src"
}
```

- [ ] **步驟 5：建立 `apps/worker/src/health-check/health-check.processor.ts`**

```ts
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import * as os from 'os';

@Processor('health-check')
export class HealthCheckProcessor extends WorkerHost {
  async process(job: Job): Promise<{ pong: true; processedAt: string; workerHostname: string }> {
    return {
      pong: true,
      processedAt: new Date().toISOString(),
      workerHostname: os.hostname(),
    };
  }
}
```

在完全信任這段程式碼之前，請對照已安裝套件核實 `@nestjs/bullmq` 真正的 `Processor`/`WorkerHost` API——根據全域限制的說明，這只是盡力而為的草稿。

- [ ] **步驟 6：建立 `apps/worker/src/health-check/health-check.module.ts`**

```ts
import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { HealthCheckProcessor } from './health-check.processor';

@Module({
  imports: [BullModule.registerQueue({ name: 'health-check' })],
  providers: [HealthCheckProcessor],
})
export class HealthCheckModule {}
```

- [ ] **步驟 7：建立 `apps/worker/src/app.module.ts`**

```ts
import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { HealthCheckModule } from './health-check/health-check.module';

@Module({
  imports: [
    BullModule.forRoot({
      connection: {
        host: process.env.REDIS_HOST ?? 'redis',
        port: Number(process.env.REDIS_PORT ?? 6379),
      },
    }),
    HealthCheckModule,
  ],
})
export class AppModule {}
```

- [ ] **步驟 8：建立 `apps/worker/src/main.ts`**

這個行程沒有任何 HTTP 介面——它是純粹的背景消費者，因此使用 `createApplicationContext`，而不是 `create`。

```ts
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  await NestFactory.createApplicationContext(AppModule);
  console.log('Worker started, listening for jobs...');
}
bootstrap();
```

- [ ] **步驟 9：容器化之前先在本機驗證**

執行：`cd apps/worker && pnpm install && pnpm run build`
預期結果：沒有 TypeScript 錯誤。

- [ ] **步驟 10：建立 `apps/worker/Dockerfile`**

遵循與 `apps/api/Dockerfile` 相同的、以 repo 根目錄為 context 的多階段模式（以 repo 根目錄作為建置 context，因為 pnpm lockfile 只存在於 repo 根目錄）。

```dockerfile
FROM node:20-alpine AS build
WORKDIR /repo
RUN corepack enable
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY apps/worker/package.json apps/worker/package.json
RUN pnpm install --frozen-lockfile
COPY apps/worker ./apps/worker
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

- [ ] **步驟 11：在 `docker-compose.yml` 中新增 `worker` 服務**

```yaml
  worker:
    build:
      context: .
      dockerfile: apps/worker/Dockerfile
    environment:
      REDIS_HOST: redis
      REDIS_PORT: 6379
    depends_on:
      redis:
        condition: service_healthy
    restart: unless-stopped
```

（沒有 `ports:`——這個行程不透過 HTTP 提供任何服務，Docker 網路以外沒有任何東西需要直接存取它。）

- [ ] **步驟 12：啟動它並確認能乾淨地啟動**

執行：`docker compose up -d --build worker`
執行：`docker compose logs worker`
預期結果：出現 `Worker started, listening for jobs...`，且沒有任何錯誤。如果 `@nestjs/bullmq` 的真實 API 與步驟 5-7 的草稿不同，問題會在這裡浮現——根據實際的錯誤訊息進行修正，並對照真實行為反覆調整。

- [ ] **步驟 13：提交（Commit）**

```bash
git add apps/worker docker-compose.yml
git commit -m "feat(worker): scaffold apps/worker with health-check job processor"
```

---

### 任務 3：端對端工作處理驗證

**檔案：**
- 建立：`apps/api/test/jobs.e2e-spec.ts`

**介面：**
- 使用：`HealthCheckService.enqueuePing` 是可用的，但這個測試刻意完全繞過 HTTP，直接透過 `bullmq` 的 `Queue` 類別與 Redis 溝通，就像 `storage.e2e-spec.ts` 繞過 HTTP 直接測試 `StorageService` 一樣——證明的是真實的基礎設施可以運作，而不是其外層的包裝。
- 產出：證明從容器外部加入佇列的工作，會被真正的 `apps/worker` 容器取出並處理。

- [ ] **步驟 1：為測試新增 `bullmq` 作為開發相依套件（若尚未提供）**

`apps/api` 已經直接相依於 `bullmq`（任務 1），因此這裡不需要任何變更——e2e 測試可以直接 `import { Queue, QueueEvents } from 'bullmq'`。

- [ ] **步驟 2：撰寫測試**

`apps/api/test/jobs.e2e-spec.ts`:

```ts
import { Queue, QueueEvents } from 'bullmq';

const REDIS_CONNECTION = { host: '127.0.0.1', port: 6380 };

describe('Background job processing (e2e, real worker)', () => {
  let queue: Queue;
  let queueEvents: QueueEvents;

  beforeAll(() => {
    queue = new Queue('health-check', { connection: REDIS_CONNECTION });
    queueEvents = new QueueEvents('health-check', { connection: REDIS_CONNECTION });
  });

  afterAll(async () => {
    await queue.close();
    await queueEvents.close();
  });

  it('a job enqueued from the host is picked up and processed by the real worker container', async () => {
    const job = await queue.add('ping', { source: 'e2e-test', requestedAt: new Date().toISOString() });

    const result = await job.waitUntilFinished(queueEvents, 15000);

    expect(result).toMatchObject({ pong: true });
    expect(typeof result.workerHostname).toBe('string');
    expect(result.workerHostname.length).toBeGreaterThan(0);
  });
});
```

`result.workerHostname` 是一個真實、非空的字串（實務上，就是 `worker` 容器自己的 hostname，Docker 會將其設為容器 ID），這是能證明程式碼確實在真正的 `worker` 容器內執行，而非其他行程的有力證據——在你的報告中記下實際觀察到的值，而不要只是相信斷言通過。

- [ ] **步驟 3：對正在執行的堆疊執行測試**

前置條件：`docker compose ps` 顯示 `redis` 與 `worker` 都已啟動（worker 並未定義「healthy」健康檢查，只需確認它正在執行，且其日誌沒有顯示不斷崩潰重啟的情況）。

執行：`cd apps/api && pnpm test:e2e -- jobs`
預期結果：PASS。如果發生逾時，請先檢查 `docker compose logs worker` 是否有崩潰或連線錯誤，再假設是測試本身有問題。

- [ ] **步驟 4：提交（Commit）**

```bash
git add apps/api/test/jobs.e2e-spec.ts
git commit -m "test(infra): verify a real job round-trips through Redis to the worker container"
```

---

### 任務 4：Gotenberg 服務 + 轉換驗證

**檔案：**
- 修改：`docker-compose.yml`（新增 `gotenberg` 服務）
- 建立：`scripts/verify-gotenberg.sh`

**介面：**
- 使用：無新增項目。
- 產出：一個在 Docker 網路上可透過 `http://gotenberg:3000` 存取的執行中 Gotenberg 實例，並經過驗證，確實能將文件轉換為 PDF（而不只是回報自己是健康的）。

- [ ] **步驟 1：在 `docker-compose.yml` 中新增 `gotenberg`**

```yaml
  gotenberg:
    image: gotenberg/gotenberg:8
    healthcheck:
      test: ["CMD", "curl", "-f", "http://127.0.0.1:3000/health"]
      interval: 5s
      timeout: 5s
      retries: 20
    restart: unless-stopped
```

（不發布主機連接埠——僅限內部 Docker 網路使用。Gotenberg 自身的 `/health` 端點是真正的存活檢查，而不只是「容器已啟動」。）

- [ ] **步驟 2：啟動它**

執行：`docker compose up -d gotenberg`
等待其變為健康狀態：`docker compose ps gotenberg`

- [ ] **步驟 3：建立 `scripts/verify-gotenberg.sh`**

透過 Gotenberg 的 LibreOffice 路由（它可以處理 `.txt` 以及真正的 Office 格式）將一個簡單的純文字測試檔案轉換為 PDF，並確認回應是真正的 PDF。

```bash
#!/usr/bin/env bash
set -euo pipefail

WORKDIR=$(mktemp -d)
trap 'rm -rf "$WORKDIR"' EXIT

echo "Phase 4A Gotenberg verification $(date -u +%FT%TZ)" > "$WORKDIR/test.txt"

echo "Converting test.txt to PDF via Gotenberg..."
docker run --rm --network drm_default -v "$WORKDIR:$WORKDIR" curlimages/curl:latest \
  -sf -X POST http://gotenberg:3000/forms/libreoffice/convert \
  -F "files=@$WORKDIR/test.txt" \
  -o "$WORKDIR/output.pdf"

echo "Confirming the output is a real PDF..."
if [ "$(head -c 4 "$WORKDIR/output.pdf")" != "%PDF" ]; then
  echo "FAIL: output does not start with the PDF magic bytes" >&2
  exit 1
fi

echo "Gotenberg verification passed. Output size: $(wc -c < "$WORKDIR/output.pdf") bytes."
```

（如果這份草稿的表單欄位名稱／路由路徑與 Gotenberg 8 真實 API 的預期不符，請據實調整——可查閱 `https://gotenberg.dev` 的文件，或參考執行中容器自身的 `/health`／錯誤回應，抑或請求格式不正確時 Gotenberg 自己的錯誤訊息，這些訊息通常會明確說明所預期的內容。`--network drm_default` 這個名稱應該對照 `docker network ls` 進行核實，這與 Phase 2A 驗證腳本中已提及的相同注意事項一致。）

- [ ] **步驟 4：執行它**

執行：`chmod +x scripts/verify-gotenberg.sh && ./scripts/verify-gotenberg.sh`
預期結果：「Gotenberg verification passed.」

- [ ] **步驟 5：提交（Commit）**

```bash
git add docker-compose.yml scripts/verify-gotenberg.sh
git commit -m "feat(infra): add Gotenberg, verify real document conversion"
```

---

### 任務 5：ClamAV 服務 + 病毒掃描驗證

**檔案：**
- 修改：`docker-compose.yml`（新增 `clamav` 服務）
- 建立：`scripts/verify-clamav.sh`

**介面：**
- 使用：無新增項目。
- 產出：一個在 Docker 網路上可透過 `clamav:3310` 存取的執行中 ClamAV daemon，並經過驗證，確實能偵測到已知的測試病毒特徵碼（EICAR 測試字串），同時也能正確地讓乾淨檔案通過。

- [ ] **步驟 1：在 `docker-compose.yml` 中新增 `clamav`**

```yaml
  clamav:
    image: clamav/clamav:stable
    healthcheck:
      test: ["CMD", "sh", "-c", "clamdcheck.sh || echo unhealthy"]
      interval: 30s
      timeout: 10s
      retries: 20
      start_period: 300s
    restart: unless-stopped
```

`start_period: 300s` 特意設得很寬鬆——根據全域限制的說明，首次啟動下載特徵資料庫可能需要數分鐘，且視網路狀況而定。`clamdcheck.sh` 是該映像檔自帶的健康檢查腳本；在信任它之前，請先確認這個映像檔標籤中確實存在該腳本（`docker compose exec clamav which clamdcheck.sh` 或等效指令），如果實際的映像檔使用不同的機制，請據實調整。

- [ ] **步驟 2：啟動它並耐心等待**

執行：`docker compose up -d clamav`
執行：`docker compose logs -f clamav`（持續觀察，直到看到它回報就緒／特徵資料庫已載入完成——第一次執行可能需要數分鐘；不要僅僅因為速度慢就斷定有東西壞了）
確認健康狀態：`docker compose ps clamav`

- [ ] **步驟 3：尋找 clamd 協定的真實 npm 客戶端**

在撰寫 `scripts/verify-clamav.sh` 之前，先確認是否存在針對 clamd `INSTREAM` 協定、仍有人維護的 npm 套件（可查看的候選項目：`clamdjs`、`clamscan`——實際核實 npm registry 上的狀態，並挑選其中真實存在、有維護且最簡單的那一個，而不是憑空假設某個套件存在）。如果找不到合適的套件，就針對 `INSTREAM` 命令手刻一個最簡單的 TCP 客戶端（將檔案內容以長度前綴分塊傳送，最後傳送一個長度為零的區塊，並讀取回應那一行）——這個協定簡單到可以直接手刻實作作為備援方案，但務必先確認是否已有現成的函式庫。

- [ ] **步驟 4：建立 `scripts/verify-clamav.sh`**

同時測試兩個方向：已知的惡意測試特徵碼會被正確標記，而良性檔案則會被正確判定為乾淨。EICAR 測試字串是業界標準、安全的防毒偵測測試方式——它並不是真正的病毒，每一套防毒引擎（包括 ClamAV）都特別設計成會將它標記為 `Win.Test.EICAR_HDB-1` 或類似名稱，並且可以安全地存放在 git 忽略的測試暫存位置（不要把 EICAR 字串本身提交到受版本控管的檔案中——有些工具／掃描器一看到它就會標記，這是預期且正常的行為，只要不要讓它出現在受版本控管的原始碼中即可）。

```bash
#!/usr/bin/env bash
set -euo pipefail

WORKDIR=$(mktemp -d)
trap 'rm -rf "$WORKDIR"' EXIT

# The standard EICAR antivirus test string -- not a real virus, every AV
# engine is designed to flag it. Kept in a scratch tempdir, never committed.
printf 'X5O!P%%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*' > "$WORKDIR/eicar.txt"
echo "This is a clean, benign test file for Phase 4A verification." > "$WORKDIR/clean.txt"

echo "Scanning the EICAR test file (must be detected)..."
# Adjust this invocation once Step 3 has picked a real client library/approach.
# Placeholder shape -- replace with the actual chosen tool's real CLI/API:
docker run --rm --network drm_default -v "$WORKDIR:$WORKDIR" <clamav-client-image-or-tool> \
  scan --host clamav --port 3310 "$WORKDIR/eicar.txt" | tee "$WORKDIR/eicar-result.txt"

if ! grep -qi "found\|eicar" "$WORKDIR/eicar-result.txt"; then
  echo "FAIL: EICAR test file was not detected" >&2
  exit 1
fi

echo "Scanning the clean file (must pass)..."
docker run --rm --network drm_default -v "$WORKDIR:$WORKDIR" <clamav-client-image-or-tool> \
  scan --host clamav --port 3310 "$WORKDIR/clean.txt" | tee "$WORKDIR/clean-result.txt"

if grep -qi "found" "$WORKDIR/clean-result.txt"; then
  echo "FAIL: clean file was incorrectly flagged" >&2
  exit 1
fi

echo "ClamAV verification passed: EICAR detected, clean file passed."
```

這個腳本中確切的掃描呼叫方式，明確地是步驟 3 真正工具選擇的佔位符——請務必實際填入真實內容，不要在提交的版本中留下 `<clamav-client-image-or-tool>`。兩個斷言（EICAR 被標記、乾淨檔案通過）才是真正的要求；至於實作機制，則由你自行正確判斷決定。

- [ ] **步驟 5：執行它**

執行：`chmod +x scripts/verify-clamav.sh && ./scripts/verify-clamav.sh`
預期結果：「ClamAV verification passed: EICAR detected, clean file passed.」

- [ ] **步驟 6：提交（Commit）**

```bash
git add docker-compose.yml scripts/verify-clamav.sh
git commit -m "feat(infra): add ClamAV, verify real virus detection and clean-file pass"
```

---

### 任務 6：全端驗證

**檔案：**
- 修改：`scripts/smoke-test.sh`
- 建立：`docs/superpowers/plans/2026-08-01-phase4a-verification.md`

**介面：**
- 使用：任務 1 至 5 的所有內容。
- 產出：確認整個背景工作基礎設施在全新環境下，能與既有堆疊一起正常運作。

- [ ] **步驟 1：擴充 `scripts/smoke-test.sh`**

本階段新增的服務（`redis`、`gotenberg`、`clamav`、`worker`）都沒有向主機發布 HTTP 連接埠，因此腳本現有的 `check()` 輔助函式（會執行 HTTP GET）無法直接套用在它們身上。新增第二個輔助函式，透過 `docker compose ps` 檢查容器的健康狀態／狀態，並將它用於這些新服務：

```bash
check_container_state() {
  local service=$1
  local expected=$2
  local actual
  actual=$(docker compose ps --format '{{.State}}' "$service")
  if [ "$actual" != "$expected" ]; then
    echo "FAIL: $service state is '$actual', expected '$expected'" >&2
    exit 1
  fi
  echo "OK: $service is $expected"
}

check_container_state "redis" "running"
check_container_state "gotenberg" "running"
check_container_state "clamav" "running"
check_container_state "worker" "running"
```

如果在這個版本的 Docker Compose 上，`{{.State}}` 回報的內容與預期不符，請據實調整確切的 `docker compose ps --format` 欄位／數值——在信任上面的程式片段之前，請先核對實際輸出（`docker compose ps --format '{{.Service}} {{.State}} {{.Health}}'`），而且對於這四個服務中確實定義了健康檢查的服務，應優先檢查 `{{.Health}}`（`healthy`）而非 `{{.State}}`（`running`）（根據任務 1/4/5，這指的是 `redis`、`gotenberg`、`clamav`——`worker` 沒有定義健康檢查，因此對它而言，`running` 才是正確的判斷標準）。

- [ ] **步驟 2：全新的全端重新建置**

執行：`docker compose down -v && docker compose up -d --build`
等待所有服務變為健康狀態（在負載較高時，Keycloak 冷啟動大約需要 90-170 秒；ClamAV 首次啟動下載特徵資料庫可能需要數分鐘——請耐心等待，如任務 5 中所述）。

- [ ] **步驟 3：一起執行所有自動化測試套件**

`./scripts/smoke-test.sh`、`pnpm --filter api test`、`pnpm --filter api test:e2e`、`pnpm --filter api lint`、`pnpm --filter web test`、`./scripts/verify-gotenberg.sh`、`./scripts/verify-clamav.sh`。必須全部一起通過，而不只是個別通過。

- [ ] **步驟 4：撰寫 `docs/superpowers/plans/2026-08-01-phase4a-verification.md`**

依循 `docs/superpowers/plans/2026-08-01-phase3-verification.md` 的格式，記錄測試套件的結果，並簡短敘述所驗證的內容。記下實際觀察到的 ClamAV 啟動時間（以供未來參考——這會影響未來的 `docker compose up` 腳本／CI 需要有多大的耐心）。

- [ ] **步驟 5：提交（Commit）**

```bash
git add scripts/smoke-test.sh docs/superpowers/plans/2026-08-01-phase4a-verification.md
git commit -m "docs: add Phase 4A verification record, extend smoke test for new services"
```

---

## 自我審查說明

- **規格涵蓋範圍：** 精準涵蓋了 Phase 4B（上傳流程整合：病毒掃描 + Office 轉換）與 Phase 4C（浮水印與到期機制，這需要 Redis/BullMQ/worker 來執行到期排程工作，但不需要 Gotenberg/ClamAV）所需的基礎設施前置條件。不涉及任何商業邏輯——文件上傳／下載／ACL 流程完全未受影響。
- **佔位符掃描：** 存在兩個刻意、明確標示的佔位符，並已註明需要在實作期間真正解決，而非悄悄猜測帶過：ClamAV 客戶端工具的選擇（任務 5，步驟 3-4）以及 smoke-test 擴充的形式（任務 6，步驟 1）——這兩者都需要核對當下實際可用的工具／輸出，而不是本計畫僅憑訓練知識就能負責任地寫死的數值。這與 Phase 2A 針對 KES 設定 schema 所採用、效果良好的明確揭露不確定性做法相呼應。
- **型別一致性：** `health-check` 佇列名稱及其 `ping` 工作類型，在 `apps/api`（生產者）與 `apps/worker`（消費者）之間使用方式完全一致——在任務 1 中定義一次，在任務 2 中被消費，並在任務 3 中被驗證。
- **範圍：** 僅限基礎設施，這是在本階段從原本合併的 Phase 4 範圍中拆分出來時所達成的共識。沒有 `Document` schema 變更，也沒有上傳流程的變更——兩者都明確延後到 Phase 4B/4C。
