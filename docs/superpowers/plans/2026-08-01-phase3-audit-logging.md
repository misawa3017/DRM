# Phase 3：稽核日誌實作計畫

> **給代理工作者的說明：** 必要子技能：使用 superpowers:subagent-driven-development（建議）或 superpowers:executing-plans 逐工作項目（task-by-task）實作此計畫。步驟使用核取方塊（`- [ ]`）語法進行追蹤。

**目標：** 針對資料夾、文件或權限授予的每一項敏感操作，都會記錄在具防竄改能力、以雜湊鏈（hash-chained）方式串接的 `audit_logs` 資料表中，且該鏈可被獨立進行端對端驗證。

**架構：** 新增的 `AuditModule`（`AuditService` + `AuditController`）與既有的 `FoldersModule`/`DocumentsModule`/`PermissionsModule` 並列運作。上述每個服務都會取得一個 `AuditService` 依賴項，並在狀態變更或敏感讀取操作成功後呼叫 `record(...)`。雜湊鏈寫入操作會透過 Postgres 的 advisory lock 進行序列化，確保並行請求絕不會使鏈分岔。要擷取真實的客戶端 IP，需要將 Traefik 視為此應用程式唯一的反向代理並加以信任（在 `main.ts` 中設定 `app.set('trust proxy', true)`）。

**技術堆疊：** NestJS 10、Prisma 5、Node 內建的 `crypto`（SHA-256）、Jest + Testcontainers（鏈完整性驗證，包含一個並行測試）。

## 全域限制條件

- **動作分類法是將設計規格中七個中文分類（上傳/檢視/下載/編輯/刪除/權限變更/到期）具體對應到此程式碼庫實際操作**，而非逐字轉錄——刻意將範圍限定於 Phase 2B 之後實際存在的功能：
  - `folder_create`、`folder_view`（資料夾建立與 `GET /folders/:id`）
  - `document_create`、`document_version_upload`（兩者皆屬「上傳」）、`document_view`（涵蓋 `GET /documents/:id` 的中繼資料與 `GET /documents/:id/versions` 兩者——兩者皆為對同一資源的讀取操作，不拆分為兩個動作）、`document_download`（「下載」）
  - `permission_grant`、`permission_revoke`（兩者皆屬「權限變更」）
  - 「刪除」（delete）與「到期」（expire）明確不在此列舉（enum）中——目前程式碼庫中尚無任何刪除或到期端點（delete 目前完全不在範圍內；到期則屬於 Phase 4）。為目前還不可能發生的操作新增稽核動作只會是臆測性的。等這些操作實際被建置後再擴充此列舉。
  - 列出權限（`GET .../permissions`）在此階段刻意不進行稽核——對合規性而言，最重要的是狀態變更的授予/撤銷事件；稽核每一次 ACL 清單讀取是合理的未來擴充項目，但目前並非必要。
- **在並行情況下，雜湊鏈必須嚴格保持線性。** 兩筆同時發生的稽核寫入絕不能同時讀取到相同的「最新」雜湊值，並各自插入宣稱擁有相同 `prevHash` 的資料列——那將使鏈分岔，並破壞端對端驗證。每次寫入在讀取目前鏈尾並執行插入之前，都會先取得一個 Postgres advisory lock（`pg_advisory_xact_lock`，在交易期間持有），將整個應用程式範圍內的所有稽核寫入序列化。稽核寫入並非此應用程式的吞吐量瓶頸，因此全域序列化是可接受、簡單的正確性保證——不要以未序列化的「差不多就好」版本取代它。
- **鏈的排序不得僅依賴 `createdAt`**（在負載下時間戳記可能發生碰撞，且此專案已觀察到單 CPU 主機在與無關程序爭用資源時執行的情況）。`AuditLog` 新增了一個自動遞增的 `sequence` 欄位，同時用於「找出鏈尾」與「依序走訪整條鏈」——對鏈完整性至關重要的操作絕不使用 `orderBy: { createdAt: ... }`。
- **雜湊輸入是一個固定、具決定性、以管線符號分隔的字串**——`id|actorId|action|resourceType|resourceId|ipAddress|createdAt(ISO)|prevHash`——而非 JSON（JSON 的鍵值順序決定性是個實際存在的陷阱；完全避開它比正確處理它更簡單）。`createdAt` 是在插入之前由應用程式程式碼產生（`new Date()`），而非交由資料庫的 `@default(now())` 產生，如此一來雜湊中所使用的確切時間戳記，才會與實際儲存的內容逐位元組相符。
- **IP 擷取需要在 `main.ts` 中設定 `app.set('trust proxy', true)`。** 此專案 Phase 1 的最終審查曾指出這個確切的缺口（「`req.ip` 反映的是 Traefik 的位址，而非真實客戶端」），並將其延後處理，直到真的有東西會使用該 IP 為止——現在確實有了。Traefik 是進入 `api` 服務的唯一入口（已確認：沒有其他路由能直接抵達該服務，`docker-compose.yml` 中的 `api` 服務沒有對外發布任何連接埠），因此在此情境下信任所有代理是安全的——請在程式碼註解中記錄這項推理，因為在存在不受信任的中介代理的拓撲中，`trust proxy: true` 會是個陷阱（但此處並非那種情況）。
- 真正的整合測試：以 `AclService` 的風格，針對 `AuditService` 的鏈邏輯撰寫 Testcontainers 測試（包含一個真正的並行測試——同時觸發多個 `record()` 呼叫，並在事後確認鏈仍然嚴格線性），並針對實際運行中的堆疊撰寫 e2e 測試，確認稽核軌跡確實由真實操作所填入。
- 此主機上的 Docker daemon 有時會受到無關程序的負載影響，且本次工作階段已多次在 `docker compose build` 期間遇到磁碟空間不足導致的停滯——若建置異常地長時間卡住，請檢查 `df -h /` 並執行 `docker builder prune -f`。每次重新建置後，務必確認容器確實已被重新建立（檢查 image ID／啟動時間），而不只是確認建置指令的結束碼為 0。

---

### 工作項目 1：AuditLog 結構描述

**檔案：**
- 修改：`apps/api/prisma/schema.prisma`
- 新增：`apps/api/prisma/migrations/<timestamp>_audit_logs/migration.sql`（自動產生）

**介面：**
- 消費：無新項目。
- 產出：`AuditLog` 模型與 `AuditAction` 列舉（8 個值，詳見全域限制條件），可從 `@prisma/client` 匯入。

- [ ] **步驟 1：擴充 `apps/api/prisma/schema.prisma`**

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
}

model AuditLog {
  id           String       @id @default(uuid())
  sequence     BigInt       @default(autoincrement())
  actorId      String
  action       AuditAction
  resourceType ResourceType
  resourceId   String
  ipAddress    String?
  prevHash     String?
  hash         String
  createdAt    DateTime

  @@unique([sequence])
  @@index([resourceType, resourceId])
  @@index([actorId])
  @@map("audit_logs")
}
```

- [ ] **步驟 2：啟動一個暫時的本機 Postgres 以撰寫 migration**

執行：`docker run --rm -d --name drm-dev-postgres -e POSTGRES_USER=drm -e POSTGRES_PASSWORD=drm_dev_password -e POSTGRES_DB=drm -p 5435:5432 postgres:16-alpine`

（連接埠 5435——5433 是此專案真正的 Postgres，5434 曾在 Phase 2B 的工作項目 1 migration 撰寫時使用；請檢查 `docker compose ps`，若 5435 也已被占用則需調整。）

- [ ] **步驟 3：產生 migration**

執行：`cd apps/api && DATABASE_URL="postgresql://drm:drm_dev_password@localhost:5435/drm" pnpm exec prisma migrate dev --name audit_logs`

- [ ] **步驟 4：停止暫時的 Postgres**

執行：`docker stop drm-dev-postgres`

- [ ] **步驟 5：重新產生 client 並驗證建置**

執行：`cd apps/api && pnpm exec prisma generate && pnpm run build`
預期結果：沒有 TypeScript 錯誤。

- [ ] **步驟 6：提交（Commit）**

```bash
git add apps/api/prisma
git commit -m "feat(api): add AuditLog schema with hash-chain fields"
```

---

### 工作項目 2：AuditService——具雜湊鏈、並行安全的記錄與驗證

**檔案：**
- 新增：`apps/api/src/audit/audit.service.ts`
- 新增：`apps/api/src/audit/audit.module.ts`
- 測試：`apps/api/src/audit/audit.service.spec.ts`

**介面：**
- 消費：`PrismaService`。
- 產出：`AuditService.record(entry: { actorId: string; action: AuditAction; resourceType: ResourceType; resourceId: string; ipAddress: string | null }): Promise<AuditLog>`、`AuditService.verifyChain(): Promise<{ valid: boolean; brokenAtId?: string }>`、`AuditService.listForResource(resourceType: ResourceType, resourceId: string): Promise<AuditLog[]>`。

- [ ] **步驟 1：撰寫會失敗的測試**

`apps/api/src/audit/audit.service.spec.ts`：

```ts
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { execSync } from 'child_process';
import { PrismaClient } from '@prisma/client';
import * as path from 'path';
import { AuditService } from './audit.service';

describe('AuditService', () => {
  let container: StartedPostgreSqlContainer;
  let prisma: PrismaClient;
  let audit: AuditService;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    process.env.DATABASE_URL = container.getConnectionUri();
    execSync('pnpm exec prisma migrate deploy', {
      cwd: path.join(__dirname, '..', '..'),
      env: { ...process.env },
      stdio: 'inherit',
    });
    prisma = new PrismaClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument -- constructing AuditService directly against a raw PrismaClient for the test, matching this project's established AclService test pattern
    audit = new AuditService(prisma as any);
  }, 60000);

  afterAll(async () => {
    await prisma.$disconnect();
    await container.stop();
  });

  it('the first entry has a null prevHash and a real hash', async () => {
    const entry = await audit.record({
      actorId: 'user-a',
      action: 'folder_create',
      resourceType: 'folder',
      resourceId: 'folder-1',
      ipAddress: '10.0.0.1',
    });
    expect(entry.prevHash).toBeNull();
    expect(entry.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('chains each subsequent entry to the previous one\'s hash', async () => {
    const first = await audit.record({
      actorId: 'user-b',
      action: 'folder_create',
      resourceType: 'folder',
      resourceId: 'folder-2',
      ipAddress: null,
    });
    const second = await audit.record({
      actorId: 'user-b',
      action: 'folder_view',
      resourceType: 'folder',
      resourceId: 'folder-2',
      ipAddress: null,
    });
    expect(second.prevHash).toBe(first.hash);
  });

  it('verifyChain reports valid for an untampered chain', async () => {
    await audit.record({
      actorId: 'user-c',
      action: 'document_view',
      resourceType: 'document',
      resourceId: 'doc-1',
      ipAddress: '10.0.0.2',
    });
    const result = await audit.verifyChain();
    expect(result.valid).toBe(true);
  });

  it('verifyChain detects a tampered row', async () => {
    const entry = await audit.record({
      actorId: 'user-d',
      action: 'document_download',
      resourceType: 'document',
      resourceId: 'doc-2',
      ipAddress: '10.0.0.3',
    });

    await prisma.auditLog.update({
      where: { id: entry.id },
      data: { actorId: 'user-d-tampered' },
    });

    const result = await audit.verifyChain();
    expect(result.valid).toBe(false);
    expect(result.brokenAtId).toBe(entry.id);
  });

  it('serializes concurrent writes into a single strictly linear chain', async () => {
    const concurrentWrites = Array.from({ length: 10 }, (_, i) =>
      audit.record({
        actorId: `concurrent-user-${i}`,
        action: 'folder_view',
        resourceType: 'folder',
        resourceId: 'folder-concurrent',
        ipAddress: null,
      }),
    );
    await Promise.all(concurrentWrites);

    const result = await audit.verifyChain();
    expect(result.valid).toBe(true);
  });

  it('listForResource returns only entries for that resource, in order', async () => {
    await audit.record({
      actorId: 'user-e',
      action: 'document_view',
      resourceType: 'document',
      resourceId: 'doc-list-test',
      ipAddress: null,
    });
    await audit.record({
      actorId: 'user-e',
      action: 'document_download',
      resourceType: 'document',
      resourceId: 'doc-list-test',
      ipAddress: null,
    });
    await audit.record({
      actorId: 'user-e',
      action: 'document_view',
      resourceType: 'document',
      resourceId: 'doc-unrelated',
      ipAddress: null,
    });

    const entries = await audit.listForResource('document', 'doc-list-test');
    expect(entries).toHaveLength(2);
    expect(entries[0].action).toBe('document_view');
    expect(entries[1].action).toBe('document_download');
  });
});
```

- [ ] **步驟 2：執行測試以確認其失敗**

執行：`cd apps/api && pnpm test -- audit.service`
預期結果：FAIL——`Cannot find module './audit.service'`

- [ ] **步驟 3：實作 `AuditService`**

`apps/api/src/audit/audit.service.ts`：

```ts
import { Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'crypto';
import { AuditAction, AuditLog, Prisma, ResourceType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

const AUDIT_CHAIN_LOCK_KEY = 727310;

interface RecordAuditEntry {
  actorId: string;
  action: AuditAction;
  resourceType: ResourceType;
  resourceId: string;
  ipAddress: string | null;
}

interface HashInput {
  id: string;
  actorId: string;
  action: AuditAction;
  resourceType: ResourceType;
  resourceId: string;
  ipAddress: string | null;
  createdAt: Date;
  prevHash: string | null;
}

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async record(entry: RecordAuditEntry): Promise<AuditLog> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${AUDIT_CHAIN_LOCK_KEY})`;

      const last = await tx.auditLog.findFirst({ orderBy: { sequence: 'desc' } });
      const prevHash = last?.hash ?? null;

      const id = randomUUID();
      const createdAt = new Date();
      const hash = this.computeHash({ id, ...entry, createdAt, prevHash });

      return tx.auditLog.create({
        data: { id, ...entry, createdAt, prevHash, hash },
      });
    });
  }

  async verifyChain(): Promise<{ valid: boolean; brokenAtId?: string }> {
    const rows = await this.prisma.auditLog.findMany({ orderBy: { sequence: 'asc' } });
    let expectedPrevHash: string | null = null;

    for (const row of rows) {
      if (row.prevHash !== expectedPrevHash) {
        return { valid: false, brokenAtId: row.id };
      }
      const recomputed = this.computeHash({
        id: row.id,
        actorId: row.actorId,
        action: row.action,
        resourceType: row.resourceType,
        resourceId: row.resourceId,
        ipAddress: row.ipAddress,
        createdAt: row.createdAt,
        prevHash: row.prevHash,
      });
      if (recomputed !== row.hash) {
        return { valid: false, brokenAtId: row.id };
      }
      expectedPrevHash = row.hash;
    }

    return { valid: true };
  }

  async listForResource(resourceType: ResourceType, resourceId: string): Promise<AuditLog[]> {
    return this.prisma.auditLog.findMany({
      where: { resourceType, resourceId },
      orderBy: { sequence: 'asc' },
    });
  }

  private computeHash(input: HashInput): string {
    const raw = [
      input.id,
      input.actorId,
      input.action,
      input.resourceType,
      input.resourceId,
      input.ipAddress ?? '',
      input.createdAt.toISOString(),
      input.prevHash ?? '',
    ].join('|');
    return createHash('sha256').update(raw).digest('hex');
  }
}
```

`Prisma` 被匯入，但若你的編輯器／tsc 標記為未使用匯入，它只在需要其命名空間型別時才會用到——如果 `tx` 的推斷型別不需要明確標註 `Prisma.TransactionClient`，就將其移除；無論哪種方式都要確保程式碼能順利編譯。

- [ ] **步驟 4：執行測試以確認其通過**

執行：`cd apps/api && pnpm test -- audit.service`
預期結果：PASS（6 個測試）。並行測試是最有可能揭露 advisory lock 是否真的有序列化寫入的一項測試——如果它間歇性失敗，這是一個需要修正的真實正確性問題，而不是應該重試帶過的不穩定測試。

- [ ] **步驟 5：建立 `apps/api/src/audit/audit.module.ts`**

```ts
import { Module } from '@nestjs/common';
import { AuditService } from './audit.service';

@Module({
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
```

- [ ] **步驟 6：提交（Commit）**

```bash
git add apps/api/src/audit
git commit -m "feat(api): add AuditService with concurrency-safe hash-chained recording"
```

---

### 工作項目 3：Trust proxy 設定 + 將稽核記錄整合進 FoldersModule

**檔案：**
- 修改：`apps/api/src/main.ts`
- 修改：`apps/api/src/folders/folders.controller.ts`
- 修改：`apps/api/src/folders/folders.service.ts`
- 修改：`apps/api/src/folders/folders.module.ts`
- 測試：`apps/api/test/audit-folders.e2e-spec.ts`

**介面：**
- 消費：`AuditService.record`（工作項目 2）。
- 產出：整個應用程式中的 `req.ip` 現在會反映真實客戶端 IP（而非 Traefik 的 IP）——在此處一次性設定完成，供工作項目 4-5 重複使用，無需重複設定。`FoldersService.create`/`.getWithContents` 現在接受一個尾端的 `ipAddress: string | null` 參數，並在成功後記錄 `folder_create`/`folder_view` 稽核項目。

此工作項目將 trust-proxy 設定「與」第一個模組的稽核記錄整合工作放在一起完成（而非拆成兩個獨立工作項目），原因是要避免出現中間某個提交（commit）使程式碼無法編譯的狀況——`req.ip` 的擷取與消費它的服務方法會在同一個工作項目中一起完成。

- [ ] **步驟 1：在 `apps/api/src/main.ts` 中設定 trust proxy**

在 `app.listen(...)` 之前加入：

```ts
  // Traefik is the sole entry point into this service — docker-compose.yml
  // publishes no other route directly to `api`, so trusting all proxies is
  // safe here and lets req.ip reflect the real client address (forwarded by
  // Traefik via X-Forwarded-For) instead of Traefik's own container IP.
  app.set('trust proxy', true);
```

- [ ] **步驟 2：更新 `FoldersService` 以接受 `ipAddress` 並記錄稽核項目**

```ts
import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AclService } from '../acl/acl.service';
import { AuditService } from '../audit/audit.service';

interface AuthenticatedUser {
  id: string;
  roles: string[];
}

@Injectable()
export class FoldersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly acl: AclService,
    private readonly audit: AuditService,
  ) {}

  async create(user: AuthenticatedUser, name: string, parentId: string | null, ipAddress: string | null) {
    if (parentId === null || parentId === undefined) {
      if (!user.roles.includes('admin')) {
        throw new ForbiddenException('Only admins can create root-level folders');
      }
    } else {
      const allowed = await this.acl.can(user, 'folder', parentId, 'edit');
      if (!allowed) {
        throw new ForbiddenException('You do not have edit access to the parent folder');
      }
    }

    const folder = await this.prisma.folder.create({
      data: { name, parentId: parentId ?? null, createdBy: user.id },
    });

    await this.audit.record({
      actorId: user.id,
      action: 'folder_create',
      resourceType: 'folder',
      resourceId: folder.id,
      ipAddress,
    });

    return folder;
  }

  async getWithContents(user: AuthenticatedUser, id: string, ipAddress: string | null) {
    const allowed = await this.acl.can(user, 'folder', id, 'view');
    if (!allowed) {
      throw new ForbiddenException('You do not have view access to this folder');
    }

    const folder = await this.prisma.folder.findUnique({
      where: { id },
      include: {
        children: true,
        documents: { include: { currentVersion: true } },
      },
    });
    if (!folder) {
      throw new NotFoundException('Folder not found');
    }

    await this.audit.record({
      actorId: user.id,
      action: 'folder_view',
      resourceType: 'folder',
      resourceId: id,
      ipAddress,
    });

    return folder;
  }
}
```

請注意，稽核呼叫是在操作「成功之後」才發生（在 `create` 之後／`NotFoundException` 檢查之後），而不是在之前——失敗或未經授權的嘗試不會被記錄成好像已經發生過一樣。這是此階段一項刻意的範圍決策：僅稽核成功的操作，這與設計規格中將稽核日誌定位為「已執行操作的記錄」而非「存取嘗試日誌」的框架一致。（記錄被拒絕的嘗試是合理的未來擴充項目，但此處未實作。）

- [ ] **步驟 3：更新 `FoldersController` 以擷取並傳遞 `req.ip`**

```ts
  @Post()
  async create(@Req() req: AuthenticatedRequest, @Body() body: CreateFolderDto) {
    const user = await this.usersService.upsertFromToken(req.user);
    return this.foldersService.create(
      { id: user.id, roles: req.user.roles },
      body.name,
      body.parentId ?? null,
      req.ip ?? null,
    );
  }

  @Get(':id')
  async get(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    const user = await this.usersService.upsertFromToken(req.user);
    return this.foldersService.getWithContents({ id: user.id, roles: req.user.roles }, id, req.ip ?? null);
  }
```

- [ ] **步驟 4：將 `AuditModule` 匯入 `FoldersModule`**

```ts
import { Module } from '@nestjs/common';
import { FoldersController } from './folders.controller';
import { FoldersService } from './folders.service';
import { AclModule } from '../acl/acl.module';
import { UsersModule } from '../users/users.module';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [AclModule, UsersModule, AuditModule],
  controllers: [FoldersController],
  providers: [FoldersService],
  exports: [FoldersService],
})
export class FoldersModule {}
```

- [ ] **步驟 5：撰寫 e2e 測試**

`apps/api/test/audit-folders.e2e-spec.ts`：

```ts
import axios from 'axios';
import { PrismaClient } from '@prisma/client';

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

describe('Folder audit logging (e2e)', () => {
  const prisma = new PrismaClient({
    datasources: { db: { url: 'postgresql://drm:drm_dev_password@localhost:5433/drm' } },
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('records folder_create and folder_view with a valid chain link and a real IP', async () => {
    const adminToken = await getToken('testadmin', 'testadminpass');
    const authHeader = { Authorization: `Bearer ${adminToken}` };

    const createRes = await axios.post<FolderResponse>(
      `${API_BASE_URL}/folders`,
      { name: `audit-test-${Date.now()}` },
      { headers: authHeader },
    );
    const folderId = createRes.data.id;

    await axios.get(`${API_BASE_URL}/folders/${folderId}`, { headers: authHeader });

    const entries = await prisma.auditLog.findMany({
      where: { resourceType: 'folder', resourceId: folderId },
      orderBy: { sequence: 'asc' },
    });

    expect(entries).toHaveLength(2);
    expect(entries[0].action).toBe('folder_create');
    expect(entries[1].action).toBe('folder_view');
    expect(entries[1].prevHash).toBe(entries[0].hash);
    expect(entries[0].ipAddress).not.toBeNull();
    expect(entries[0].ipAddress).not.toBe('::ffff:127.0.0.1');
  });
});
```

最後一個斷言（`ipAddress` 不是被 loopback 包裝過的位址）是一項確實有意義的檢查，用來確認 `trust proxy` 真的有作用——如果沒有設定它，每個請求顯示的都會是 Traefik 或原始 socket 的位址，而不是被轉發過來的位址。請根據你在修正 trust-proxy 之前的失敗執行結果中實際觀察到的內容，來調整你所斷言的確切「錯誤」值（暫時在本機註解掉步驟 1 中對 `main.ts` 的修改、執行測試、記下它擷取到的 IP，然後再還原修正）——不要只是猜測那個字串，要實際驗證。

- [ ] **步驟 6：重新建置並執行**

執行：`docker compose up -d --build api`（驗證容器確實已重新建立）
執行：`cd apps/api && pnpm test:e2e -- audit-folders`
預期結果：PASS

- [ ] **步驟 7：提交（Commit）**

```bash
git add apps/api/src/main.ts apps/api/src/folders apps/api/test/audit-folders.e2e-spec.ts
git commit -m "feat(api): trust Traefik as sole proxy, audit-log folder create and view"
```

---

### 工作項目 4：將稽核記錄整合進 DocumentsModule

**檔案：**
- 修改：`apps/api/src/documents/documents.service.ts`
- 修改：`apps/api/src/documents/documents.controller.ts`
- 修改：`apps/api/src/documents/documents.module.ts`
- 測試：`apps/api/test/audit-documents.e2e-spec.ts`

**介面：**
- 消費：`AuditService.record`（工作項目 2）。
- 產出：`DocumentsService.createDocument`/`.addVersion`/`.getMetadata`/`.getDownloadStream` 現在都接受一個尾端的 `ipAddress` 參數，並分別記錄 `document_create`/`document_version_upload`/`document_view`/`document_download`。

- [ ] **步驟 1：將 `AuditService` 加入 `DocumentsService` 的建構子，新增 `ipAddress` 參數，並在每次成功後進行記錄**

更新 `apps/api/src/documents/documents.service.ts`：
- 在建構子中加入 `private readonly audit: AuditService`（從 `'../audit/audit.service'` 匯入）。
- `createDocument(user, folderId, name, file, ipAddress: string | null)`——在 `$transaction` 成功解析後，呼叫 `this.audit.record({ actorId: user.id, action: 'document_create', resourceType: 'document', resourceId: documentId, ipAddress })`。
- `addVersion(user, documentId, file, ipAddress: string | null)`——在交易解析後，`action: 'document_version_upload'`。
- `getMetadata(user, documentId, ipAddress: string | null)`——在成功取得資料後，`action: 'document_view'`。（若你選擇讓版本清單讀取也走同一個方法路徑，也請將此邏輯套用於該讀取上——根據此計畫的全域限制條件，`document_view` 涵蓋這兩者；若 `listVersions` 仍是獨立的方法，你可以依照限制條件不對其進行稽核，或為求完整性也以 `document_view` 對其進行稽核——兩種做法皆可接受，只需保持一致並在提交（commit）中註明你的選擇。）
- `getDownloadStream(user, documentId, versionId, ipAddress: string | null)`——在 ACL 通過且版本已解析後（但稽核寫入不需要等到串流傳輸完成才進行——只要你知道下載已獲授權且即將開始，就可以記錄，不必等到客戶端接收完所有位元組），`action: 'document_download'`。

- [ ] **步驟 2：更新 `DocumentsController` 以傳遞 `req.ip`**

依照工作項目 3/4 所建立的模式，將 `req.ip ?? null` 作為尾端引數傳入上述四個呼叫中。

- [ ] **步驟 3：將 `AuditModule` 匯入 `DocumentsModule`**

將 `AuditModule` 加入 `apps/api/src/documents/documents.module.ts` 的 `imports` 陣列中。

- [ ] **步驟 4：撰寫 e2e 測試**

`apps/api/test/audit-documents.e2e-spec.ts`——依照 `audit-folders.e2e-spec.ts`（工作項目 4）的確切結構，但需：建立一個資料夾、上傳一份文件（預期 `document_create`）、取得中繼資料（預期 `document_view`）、下載它（預期 `document_download`）、上傳第二個版本（預期 `document_version_upload`）。斷言該文件 `resourceId` 的完整 4 筆項目鏈依序存在，且每一筆都正確地透過 `prevHash` 與前一筆連結。全程使用具型別的 axios 呼叫（此專案既有慣例——參見 `documents-read.e2e-spec.ts` 的做法）以及 `form-data` 進行多部分（multipart）上傳（參見 `documents-write.e2e-spec.ts`）。

- [ ] **步驟 5：重新建置並執行**

執行：`docker compose up -d --build api`（驗證確實已重新建立）
執行：`cd apps/api && pnpm test:e2e -- audit-documents`
預期結果：PASS

- [ ] **步驟 6：提交（Commit）**

```bash
git add apps/api/src/documents apps/api/test/audit-documents.e2e-spec.ts
git commit -m "feat(api): audit-log document create, view, download, and version upload"
```

---

### 工作項目 5：將稽核記錄整合進 PermissionsModule

**檔案：**
- 修改：`apps/api/src/permissions/permissions.service.ts`
- 修改：`apps/api/src/permissions/permissions.controller.ts`
- 修改：`apps/api/src/permissions/permissions.module.ts`
- 測試：`apps/api/test/audit-permissions.e2e-spec.ts`

**介面：**
- 消費：`AuditService.record`（工作項目 2）。
- 產出：`PermissionsService.grant`/`.revoke` 接受一個尾端的 `ipAddress` 參數，並記錄 `permission_grant`/`permission_revoke`。

- [ ] **步驟 1：將 `AuditService` 加入 `PermissionsService`，傳入 `ipAddress`，並在成功後記錄**

- `grant(user, resourceType, resourceId, principalType, principalId, permissionLevel, ipAddress: string | null)`——在群組拒絕檢查與 `manage` ACL 檢查皆通過、且 `upsert` 完成後，針對 `(resourceType, resourceId)` 記錄 `permission_grant`（是被授予權限的資源，而非接收權限的主體——授予是發生在資源 ACL 上的事件，而這也正是呼叫者原本就已被授權操作的 `resourceType`/`resourceId`）。
- `revoke(user, resourceType, resourceId, permissionId, ipAddress: string | null)`——在範圍限定的 `deleteMany` 成功後（count > 0），記錄 `permission_revoke`。

- [ ] **步驟 2：更新 `PermissionsController` 以傳遞 `req.ip`**

將 `req.ip ?? null` 傳入所有四個授予/撤銷處理常式（資料夾與文件兩種變體皆需）。

- [ ] **步驟 3：將 `AuditModule` 匯入 `PermissionsModule`**

- [ ] **步驟 4：撰寫 e2e 測試**

`apps/api/test/audit-permissions.e2e-spec.ts`——建立一個資料夾、授予一項權限（預期 `permission_grant`）、撤銷它（預期 `permission_revoke`），斷言該資料夾 `resourceId` 下兩筆項目皆存在，且正確地鏈結在一起。

- [ ] **步驟 5：重新建置並執行**

執行：`docker compose up -d --build api`（驗證確實已重新建立）
執行：`cd apps/api && pnpm test:e2e -- audit-permissions`
預期結果：PASS

- [ ] **步驟 6：提交（Commit）**

```bash
git add apps/api/src/permissions apps/api/test/audit-permissions.e2e-spec.ts
git commit -m "feat(api): audit-log permission grant and revoke"
```

---

### 工作項目 6：稽核日誌讀取端點與鏈驗證端點

**檔案：**
- 新增：`apps/api/src/audit/audit.controller.ts`
- 修改：`apps/api/src/audit/audit.module.ts`
- 修改：`apps/api/src/app.module.ts`
- 測試：`apps/api/test/audit-endpoints.e2e-spec.ts`

**介面：**
- 消費：`AuditService.listForResource`、`AuditService.verifyChain`、`AclService.can`、`UsersService.upsertFromToken`。
- 產出：`GET /folders/:id/audit-logs` 與 `GET /documents/:id/audit-logs`（皆需要對該資源具備 `manage` 權限 → `200 AuditLog[]`）、`GET /audit-logs/verify`（僅限管理員 → `200 { valid: boolean; brokenAtId?: string }`）。

- [ ] **步驟 1：建立 `apps/api/src/audit/audit.controller.ts`**

```ts
import { Controller, ForbiddenException, Get, Param, Req, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Request } from 'express';
import { AuditService } from './audit.service';
import { AclService } from '../acl/acl.service';
import { UsersService } from '../users/users.service';

interface AuthenticatedRequest extends Request {
  user: { sub: string; email: string; name: string; roles: string[] };
}

@UseGuards(AuthGuard('jwt'))
@Controller()
export class AuditController {
  constructor(
    private readonly auditService: AuditService,
    private readonly aclService: AclService,
    private readonly usersService: UsersService,
  ) {}

  @Get('folders/:id/audit-logs')
  async folderAuditLogs(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    const user = await this.usersService.upsertFromToken(req.user);
    const allowed = await this.aclService.can({ id: user.id, roles: req.user.roles }, 'folder', id, 'manage');
    if (!allowed) {
      throw new ForbiddenException('You do not have manage access to this folder');
    }
    return this.auditService.listForResource('folder', id);
  }

  @Get('documents/:id/audit-logs')
  async documentAuditLogs(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    const user = await this.usersService.upsertFromToken(req.user);
    const allowed = await this.aclService.can({ id: user.id, roles: req.user.roles }, 'document', id, 'manage');
    if (!allowed) {
      throw new ForbiddenException('You do not have manage access to this document');
    }
    return this.auditService.listForResource('document', id);
  }

  @Get('audit-logs/verify')
  async verify(@Req() req: AuthenticatedRequest) {
    if (!req.user.roles.includes('admin')) {
      throw new ForbiddenException('Only admins can verify the audit chain');
    }
    return this.auditService.verifyChain();
  }
}
```

- [ ] **步驟 2：更新 `apps/api/src/audit/audit.module.ts`**

```ts
import { Module } from '@nestjs/common';
import { AuditController } from './audit.controller';
import { AuditService } from './audit.service';
import { AclModule } from '../acl/acl.module';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [AclModule, UsersModule],
  controllers: [AuditController],
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
```

（`AclModule`/`UsersModule` 現在需要在此匯入，因為 `AuditController` 直接使用它們——這是一個新的依賴方向，但不會造成循環匯入：`AclModule` 和 `UsersModule` 都不會匯入 `AuditModule`。）

- [ ] **步驟 3：將 `AuditModule` 接入 `AppModule`**

將 `AuditModule` 加入 `apps/api/src/app.module.ts` 的 `imports` 陣列中（它可能已經透過 `FoldersModule`/`DocumentsModule`/`PermissionsModule` 被間接匯入了，但由於它現在有自己的 `controllers`，因此也需要直接匯入）。

- [ ] **步驟 4：撰寫 e2e 測試**

`apps/api/test/audit-endpoints.e2e-spec.ts`——以 testadmin 身分建立一個資料夾，將 `view`（而非 `manage`）授予 testuser，確認 testuser 在 `GET /folders/:id/audit-logs` 上會得到 `403`，確認 testadmin 會得到 `200` 且其中含有 `folder_create` 項目。確認非管理員在 `GET /audit-logs/verify` 上會得到 `403`，而 testadmin 會得到 `200 { valid: true }`。

- [ ] **步驟 5：重新建置並執行**

執行：`docker compose up -d --build api`（驗證確實已重新建立）
執行：`cd apps/api && pnpm test:e2e -- audit-endpoints`
預期結果：PASS

- [ ] **步驟 6：提交（Commit）**

```bash
git add apps/api/src/audit apps/api/src/app.module.ts apps/api/test/audit-endpoints.e2e-spec.ts
git commit -m "feat(api): add audit log read endpoints and chain-verification endpoint"
```

---

### 工作項目 7：完整套件驗證

**檔案：**
- 新增：`docs/superpowers/plans/2026-08-01-phase3-verification.md`

**介面：**
- 消費：工作項目 1-7 的所有內容。
- 產出：一份書面驗證記錄，確認稽核軌跡與雜湊鏈在完整測試套件與真實人工走查下皆能維持正確。

- [ ] **步驟 1：全新的全端重新建置**

執行：`docker compose down -v && docker compose up -d --build`
等待所有服務進入健康（healthy）狀態。

- [ ] **步驟 2：一併執行所有自動化套件**

`./scripts/smoke-test.sh`、`pnpm --filter api test`、`pnpm --filter api test:e2e`、`pnpm --filter api lint`、`pnpm --filter web test`。全部都必須通過。修正任何僅在整合層級才會出現、個別工作項目層級測試無法察覺的失敗（例如測試資料衝突、負載下的時序問題）——此專案先前已經遇過完全相同類型的問題（Phase 2B 的最終驗證工作項目）。

- [ ] **步驟 3：人工走查**

以 testadmin 身分：建立一個資料夾、上傳一份文件、檢視其中繼資料、下載它、上傳第二個版本、將 `view` 授予 testuser、再撤銷它。每個步驟之後，查詢 `GET /folders/:id/audit-logs` 或 `GET /documents/:id/audit-logs`，確認預期的項目出現，且 `prevHash` 正確連結。最後呼叫 `GET /audit-logs/verify`，確認結果為 `{ valid: true }`。

接著，進行一項刻意的竄改檢查：直接連線到 Postgres（`postgresql://drm:drm_dev_password@localhost:5433/drm`），手動編輯某一筆 `audit_logs` 資料列的 `actorId`（與工作項目 2 的竄改偵測測試相符，但這次是針對真實運行中的資料庫）。再次呼叫 `GET /audit-logs/verify`，確認它現在回報 `{ valid: false, brokenAtId: "<你所編輯的資料列>" }`。之後請還原你的手動編輯（或者也可以保留該被竄改的資料列，並在驗證文件中註明——無論哪種方式，這都是可拋棄的開發用資料；請記錄你實際採取了哪一種做法）。

- [ ] **步驟 4：撰寫 `docs/superpowers/plans/2026-08-01-phase3-verification.md`**

記錄套件執行結果與走查敘述，遵循 `docs/superpowers/plans/2026-08-01-phase2b-verification.md` 所建立的格式。

- [ ] **步驟 5：提交（Commit）**

```bash
git add docs/superpowers/plans/2026-08-01-phase3-verification.md
git commit -m "docs: add Phase 3 verification record"
```

---

## 自我審查備註

- **規格涵蓋範圍：** 完整實作設計規格中對 `audit_logs` 的要求——規格中提及、且在此程式碼庫中確實有對應真實端點的每一種操作分類，都已被稽核，並透過雜湊鏈提供防竄改證據，再加上一個驗證端點，讓這項防竄改能力能被真正實際運用（規格中提到「以達防竄改效果」——防竄改的證據，唯有在有東西能偵測到竄改時才有用，這也正是工作項目 6 中 `/audit-logs/verify` 存在的原因）。「刪除」／「到期」明確不在範圍內，因為目前尚無刪除或到期操作存在。
- **佔位符掃描：** 沒有 TBD/TODO 標記。工作項目 3 特意將 trust-proxy 設定與 FoldersModule 的稽核整合合併在一起，確保沒有任何工作項目會讓建置在提交（commit）之間處於無法編譯的狀態。
- **型別一致性：** `AuditService.record` 的項目形狀（`actorId`、`action`、`resourceType`、`resourceId`、`ipAddress`）在工作項目 2 中定義一次，並在工作項目 4-6 中以相同方式使用。`ipAddress: string | null` 這個尾端參數慣例是在工作項目 3 中引入，並在其餘三個既有服務中一致地套用。
- **範圍：** 僅涉及稽核記錄。不變更 ACL 語意、儲存機制，或任何 Phase 4 以上的功能（浮水印、到期、病毒掃描、Office 轉換）——這些皆維持不動。
