# Phase 2B：文件、資料夾與 ACL 實作計畫

> **給代理工作者的說明：** 必要子技能：使用 superpowers:subagent-driven-development（建議）或 superpowers:executing-plans 逐一任務地實作此計畫。步驟使用核取方塊（`- [ ]`）語法進行追蹤。

**目標：** 在 Phase 2A 的加密儲存鏈與 Phase 1 的驗證基礎之上，建構核心文件管理業務邏輯——資料夾、文件、版本，以及逐資源（per-resource）的 ACL——使文件能夠完全透過 API 進行上傳、版本控管、下載與存取控制。

**架構：** 在 `apps/api/src` 中新增五個 NestJS 模組：`storage`（圍繞 MinIO 的輕量 S3 相容客戶端封裝，使用 Phase 2A 建置的範圍化憑證）、`acl`（權限解析——所有其他模組都依賴的核心邏輯）、`folders`、`documents`、`permissions`。全部建構在既有的 `PrismaModule`（全域）與 `AuthModule` 的 JWT 守衛之上。上傳的檔案會以 `{documentId}/{versionId}` 物件鍵值儲存在 MinIO 中，並透過已經運作中的 SSE-KMS 鏈進行加密——應用程式程式碼從不直接處理加密，只透過 S3 API 進行寫入/讀取，其餘交由 MinIO/KES/OpenBao 處理。

**技術堆疊：** NestJS 10、Prisma 5、`@aws-sdk/client-s3`（S3 相容客戶端，搭配 `forcePathStyle: true` 對接 MinIO）、`multer`（透過 `@nestjs/platform-express` 處理多部分上傳）、Jest + Testcontainers（ACL 邏輯）、針對實際運作堆疊執行的 Jest e2e（儲存與完整文件流程，遵循本專案既有的慣例，不對可以真實執行的基礎設施進行模擬）。

## 全域限制

- 延續既有的 `apps/api` NestJS 應用程式——不建立新應用程式，也不建立新的儲存庫結構。
- TypeScript 嚴格模式（既有的全專案限制，維持不變）。
- **權限等級是階層式的，而非各自獨立的旗標**：`view < download < edit < manage`。授予 `edit` 隱含同時擁有 `view` 與 `download`。這是對設計規格中 `permission_level（view/download/edit/manage）` 的刻意解讀——規格本身並未明確說明順序，但階層式是標準的 ACL 模式（例如對應 Google Drive 的檢視者/評論者/編輯者），且可避免同一個主體需要多筆授權的情況。
- **ACL 解析絕不會跨繼承鏈合併等級。** 若某資源對某主體存在任何明確的權限項目，就完全按該項目的等級使用——只有在該資源對該主體完全沒有明確項目時，才會啟用來自父資料夾的繼承。這與設計規格中「文件若無明確 ACL，向上查詢」的字面描述相符。
- **只有 `admin` 這個 Keycloak realm 角色會完全繞過 ACL。** `deptmanager` 與 `employee` 都是一般主體，和其他人一樣需要明確的 ACL 授權——設計規格中只有 Admin 被指定為例外覆寫角色。
- **`principalType` 在 schema 層級支援 `user` 與 `group`**（與設計規格一致），但本階段只實作 `principalType: user` 的解析/授權邏輯。Keycloak 群組同步目前尚不存在（超出範圍——目前沒有任何階段建置過）。在本階段中，透過 API 嘗試授予 `group` 類型的權限會明確回傳 `400 Bad Request`（「group principals are not yet supported」），而不是悄悄地出現錯誤行為。
- **建立根層級資料夾（`parentId: null`）需要 `admin` 角色**——因為沒有父層可以繼承 edit 授權，所以需要一個明確的例外規則。建立子資料夾則需要對父資料夾擁有 `edit` 權限。
- **下載一律透過 API 代理，絕不使用預先簽署（presigned）、直接指向 MinIO 的 URL。** 設計規格的關鍵工作流程假設每一次檢視/下載都會經過 API 的 ACL 檢查，以及（在後續階段）稽核記錄與浮水印——預先簽署的 URL 會繞過這一切。
- MinIO 物件鍵值：`{documentId}/{versionId}`（UUID）——不內嵌資料夾路徑，因此搬移/重新命名資料夾時，永遠不需要重寫儲存鍵值。
- 測試：ACL 解析邏輯採用基於 Testcontainers 的整合測試（真實 Postgres，遵循 Phase 1 的 `user-persistence.spec.ts` 模式）。儲存與完整文件流程邏輯則針對**實際執行中的 docker-compose 堆疊**進行 e2e 測試（遵循 Phase 1 的 `whoami.e2e-spec.ts` 模式）——本專案在整合層級測試中不對 MinIO、Postgres 或 Keycloak 進行模擬（mock）。
- 多部分上傳大小限制：200MB（刻意設定的預設值，寬鬆但有上限——並非無限制）。
- 此主機上的 Docker daemon 有時會因無關的行程而處於高負載狀態，導致暫時性逾時——在斷定真的出問題之前，先重試一次逾時的指令（這是 Phase 1 與 Phase 2A 中反覆出現、已確認無害的現象）。

---

### 任務 1：Prisma schema — Folder、Document、DocumentVersion、Permission

**檔案：**
- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/<timestamp>_documents_folders_acl/migration.sql`（自動產生）

**介面：**
- 使用：無新增項目。
- 產出：Prisma 模型 `Folder`、`Document`、`DocumentVersion`、`Permission`，以及列舉 `PermissionLevel`（`view`/`download`/`edit`/`manage`）、`ResourceType`（`folder`/`document`）、`PrincipalType`（`user`/`group`）——產生後皆可從 `@prisma/client` 匯入。

- [ ] **步驟 1：擴充 `apps/api/prisma/schema.prisma`**

附加到現有檔案（該檔案已經包含 `generator`、`datasource` 與 `User`）：

```prisma
enum PermissionLevel {
  view
  download
  edit
  manage
}

enum ResourceType {
  folder
  document
}

enum PrincipalType {
  user
  group
}

model Folder {
  id        String     @id @default(uuid())
  name      String
  parentId  String?
  parent    Folder?    @relation("FolderChildren", fields: [parentId], references: [id])
  children  Folder[]   @relation("FolderChildren")
  documents Document[]
  createdBy String
  createdAt DateTime   @default(now())
  updatedAt DateTime   @updatedAt

  @@index([parentId])
  @@map("folders")
}

model Document {
  id               String            @id @default(uuid())
  folderId         String
  folder           Folder            @relation(fields: [folderId], references: [id])
  name             String
  currentVersionId String?           @unique
  currentVersion   DocumentVersion?  @relation("CurrentVersion", fields: [currentVersionId], references: [id])
  versions         DocumentVersion[] @relation("DocumentVersions")
  createdBy        String
  createdAt        DateTime          @default(now())
  updatedAt        DateTime          @updatedAt

  @@index([folderId])
  @@map("documents")
}

model DocumentVersion {
  id            String    @id @default(uuid())
  documentId    String
  document      Document  @relation("DocumentVersions", fields: [documentId], references: [id])
  versionNumber Int
  objectKey     String
  sha256        String
  mimeType      String
  sizeBytes     Int
  uploadedBy    String
  uploadedAt    DateTime  @default(now())
  currentFor    Document? @relation("CurrentVersion")

  @@unique([documentId, versionNumber])
  @@index([documentId])
  @@map("document_versions")
}

model Permission {
  id              String          @id @default(uuid())
  resourceType    ResourceType
  resourceId      String
  principalType   PrincipalType   @default(user)
  principalId     String
  permissionLevel PermissionLevel
  grantedBy       String
  grantedAt       DateTime        @default(now())

  @@unique([resourceType, resourceId, principalType, principalId])
  @@index([resourceType, resourceId])
  @@map("permissions")
}
```

- [ ] **步驟 2：啟動一個本機 Postgres 用於撰寫 migration**

執行：`docker run --rm -d --name drm-dev-postgres -e POSTGRES_USER=drm -e POSTGRES_PASSWORD=drm_dev_password -e POSTGRES_DB=drm -p 5434:5432 postgres:16-alpine`

（此處使用主機連接埠 5434 而非 5433，因為正在執行的 compose 堆疊中真正的 Postgres 已經佔用了 5433——先用 `docker compose ps` 檢查，若 5434 也被佔用則需另作調整。）

- [ ] **步驟 3：產生 migration**

執行：`cd apps/api && DATABASE_URL="postgresql://drm:drm_dev_password@localhost:5434/drm" pnpm exec prisma migrate dev --name documents_folders_acl`
預期結果：在 `apps/api/prisma/migrations/` 下建立一個新的 migration 目錄，套用過程順利，並印出 `Your database is now in sync with your schema.`

- [ ] **步驟 4：停止暫時性的 Postgres**

執行：`docker stop drm-dev-postgres`

- [ ] **步驟 5：重新產生 Prisma client**

執行：`cd apps/api && pnpm exec prisma generate`

- [ ] **步驟 6：確認專案仍可正常建置**

執行：`cd apps/api && pnpm run build`
預期結果：沒有 TypeScript 錯誤（目前還沒有任何程式碼參照新模型，所以這一步只是確認產生出來的 client 是有效的）。

- [ ] **步驟 7：提交（Commit）**

```bash
git add apps/api/prisma
git commit -m "feat(api): add Folder/Document/DocumentVersion/Permission schema"
```

---

### 任務 2：StorageService — MinIO 客戶端封裝

**檔案：**
- Create: `apps/api/src/storage/storage.service.ts`
- Create: `apps/api/src/storage/storage.module.ts`
- Test: `apps/api/test/storage.e2e-spec.ts`

**介面：**
- 使用：`MINIO_ENDPOINT`、`MINIO_BUCKET`、`MINIO_ACCESS_KEY`、`MINIO_SECRET_KEY` 環境變數（已由 Phase 2B 前置任務接好到 `api` 服務中）。
- 產出：`StorageService.putObject(key: string, body: Buffer, contentType: string): Promise<void>`、`StorageService.getObjectStream(key: string): Promise<Readable>`，由 `StorageModule` 匯出。

- [ ] **步驟 1：加入 AWS SDK S3 客戶端相依套件**

加入到 `apps/api/package.json` 的 `dependencies`：

```json
    "@aws-sdk/client-s3": "^3.658.0",
```

執行：`cd apps/api && pnpm install`

- [ ] **步驟 2：建立 `apps/api/src/storage/storage.service.ts`**

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
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  async getObjectStream(key: string): Promise<Readable> {
    const result = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    return result.Body as Readable;
  }
}
```

- [ ] **步驟 3：建立 `apps/api/src/storage/storage.module.ts`**

```ts
import { Module } from '@nestjs/common';
import { StorageService } from './storage.service';

@Module({
  providers: [StorageService],
  exports: [StorageService],
})
export class StorageModule {}
```

- [ ] **步驟 4：針對實際運作中的 MinIO 撰寫 e2e 測試**

此測試在主機上執行（而非在容器內），因此必須透過對外發布到主機的 loopback 連接埠（`127.0.0.1:9000`，於 Phase 2A 建立）來連接 MinIO，而不是 `api` 容器所使用的 Docker 內部網路位址。它使用的是 `.env` 中真實的範圍化 `drm-api` 憑證。

`apps/api/test/storage.e2e-spec.ts`：

```ts
import 'dotenv/config';

process.env.MINIO_ENDPOINT = 'http://127.0.0.1:9000';

import { StorageService } from '../src/storage/storage.service';
import { randomUUID } from 'crypto';

describe('StorageService (e2e, live MinIO)', () => {
  let storage: StorageService;

  beforeAll(() => {
    storage = new StorageService();
  });

  it('round-trips an object through real SSE-KMS encrypted storage', async () => {
    const key = `${randomUUID()}/verify-storage-service.txt`;
    const content = Buffer.from(`storage service e2e check ${new Date().toISOString()}`);

    await storage.putObject(key, content, 'text/plain');

    const stream = await storage.getObjectStream(key);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.from(chunk));
    }
    const downloaded = Buffer.concat(chunks);

    expect(downloaded.equals(content)).toBe(true);
  });

  it('rejects a get for a key that does not exist', async () => {
    await expect(storage.getObjectStream(`${randomUUID()}/does-not-exist.txt`)).rejects.toThrow();
  });
});
```

若 `dotenv` 尚未成為相依套件，將其加入 `apps/api/package.json` 的 `devDependencies`（`"dotenv": "^16.4.5"`）並執行 `pnpm install`——本專案的 `.env` 檔案（已加入 gitignore，本機已存在）內含 `MINIO_API_ACCESS_KEY`/`MINIO_API_SECRET_KEY`，這是將其載入到在 Docker 外執行的測試流程中最簡單的方式。如果本專案的 `.env` 使用的變數名稱與 `StorageService` 建構子讀取的 `MINIO_ACCESS_KEY`/`MINIO_SECRET_KEY` 不同，請調整實際讀取的環境變數名稱——查看 `docker-compose.yml` 的 `api` 服務區塊以取得權威對應關係（`MINIO_ACCESS_KEY: ${MINIO_API_ACCESS_KEY}`），若光靠 `dotenv` 無法產生正確的變數名稱，則在測試的 setup 中加入 `process.env.MINIO_ACCESS_KEY = process.env.MINIO_API_ACCESS_KEY` 等設定。

- [ ] **步驟 5：執行測試**

前置條件：完整堆疊必須正在執行中（`docker compose ps` 顯示 `minio`/`kes`/`openbao` 皆為健康狀態）。

執行：`cd apps/api && pnpm test:e2e -- storage`
預期結果：PASS（2 個測試）

- [ ] **步驟 6：提交（Commit）**

```bash
git add apps/api/package.json apps/api/pnpm-lock.yaml apps/api/src/storage apps/api/test/storage.e2e-spec.ts
git commit -m "feat(api): add StorageService wrapping MinIO via S3 client"
```

---

### 任務 3：AclService — 權限解析

**檔案：**
- Create: `apps/api/src/acl/acl.service.ts`
- Create: `apps/api/src/acl/acl.module.ts`
- Test: `apps/api/src/acl/acl.service.spec.ts`

**介面：**
- 使用：`PrismaService`（全域）。
- 產出：`AclService.can(user: { id: string; roles: string[] }, resourceType: ResourceType, resourceId: string, required: PermissionLevel): Promise<boolean>`。這是本階段中其他所有模組用來授權操作的唯一函式。

- [ ] **步驟 1：撰寫會失敗的測試**

`apps/api/src/acl/acl.service.spec.ts`：

```ts
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { execSync } from 'child_process';
import { PrismaClient } from '@prisma/client';
import * as path from 'path';
import { AclService } from './acl.service';

describe('AclService', () => {
  let container: StartedPostgreSqlContainer;
  let prisma: PrismaClient;
  let acl: AclService;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    process.env.DATABASE_URL = container.getConnectionUri();
    execSync('pnpm exec prisma migrate deploy', {
      cwd: path.join(__dirname, '..', '..'),
      env: { ...process.env },
      stdio: 'inherit',
    });
    prisma = new PrismaClient();
    acl = new AclService(prisma as any);
  }, 60000);

  afterAll(async () => {
    await prisma.$disconnect();
    await container.stop();
  });

  async function makeFolder(name: string, parentId: string | null = null) {
    return prisma.folder.create({ data: { name, parentId, createdBy: 'seed' } });
  }

  async function makeDocument(folderId: string, name: string) {
    return prisma.document.create({ data: { folderId, name, createdBy: 'seed' } });
  }

  async function grant(
    resourceType: 'folder' | 'document',
    resourceId: string,
    userId: string,
    level: 'view' | 'download' | 'edit' | 'manage',
  ) {
    return prisma.permission.create({
      data: {
        resourceType,
        resourceId,
        principalType: 'user',
        principalId: userId,
        permissionLevel: level,
        grantedBy: 'seed',
      },
    });
  }

  it('denies access when there is no grant anywhere in the chain', async () => {
    const root = await makeFolder('root-1');
    const result = await acl.can({ id: 'user-a', roles: ['employee'] }, 'folder', root.id, 'view');
    expect(result).toBe(false);
  });

  it('allows access via a direct grant on the resource', async () => {
    const root = await makeFolder('root-2');
    await grant('folder', root.id, 'user-b', 'view');
    const result = await acl.can({ id: 'user-b', roles: ['employee'] }, 'folder', root.id, 'view');
    expect(result).toBe(true);
  });

  it('inherits a grant from a parent folder when the child has no explicit ACL', async () => {
    const root = await makeFolder('root-3');
    const child = await makeFolder('child-3', root.id);
    const doc = await makeDocument(child.id, 'doc-3');
    await grant('folder', root.id, 'user-c', 'edit');

    const result = await acl.can({ id: 'user-c', roles: ['employee'] }, 'document', doc.id, 'edit');
    expect(result).toBe(true);
  });

  it('does not merge levels: an explicit lower grant on the resource overrides a higher inherited grant', async () => {
    const root = await makeFolder('root-4');
    const doc = await makeDocument(root.id, 'doc-4');
    await grant('folder', root.id, 'user-d', 'manage');
    await grant('document', doc.id, 'user-d', 'view');

    expect(await acl.can({ id: 'user-d', roles: ['employee'] }, 'document', doc.id, 'view')).toBe(true);
    expect(await acl.can({ id: 'user-d', roles: ['employee'] }, 'document', doc.id, 'edit')).toBe(false);
  });

  it('treats permission levels as hierarchical: edit implies view and download', async () => {
    const root = await makeFolder('root-5');
    await grant('folder', root.id, 'user-e', 'edit');

    expect(await acl.can({ id: 'user-e', roles: ['employee'] }, 'folder', root.id, 'view')).toBe(true);
    expect(await acl.can({ id: 'user-e', roles: ['employee'] }, 'folder', root.id, 'download')).toBe(true);
    expect(await acl.can({ id: 'user-e', roles: ['employee'] }, 'folder', root.id, 'edit')).toBe(true);
    expect(await acl.can({ id: 'user-e', roles: ['employee'] }, 'folder', root.id, 'manage')).toBe(false);
  });

  it('lets the admin role bypass ACL entirely, even with zero grants', async () => {
    const root = await makeFolder('root-6');
    const result = await acl.can({ id: 'user-f', roles: ['admin'] }, 'folder', root.id, 'manage');
    expect(result).toBe(true);
  });

  it('does not let deptmanager or employee roles bypass ACL', async () => {
    const root = await makeFolder('root-7');
    expect(await acl.can({ id: 'user-g', roles: ['deptmanager'] }, 'folder', root.id, 'view')).toBe(false);
  });

  it('fails closed (denies) when the resource does not exist, rather than throwing', async () => {
    const result = await acl.can(
      { id: 'user-i', roles: ['employee'] },
      'folder',
      '00000000-0000-0000-0000-000000000000',
      'view',
    );
    expect(result).toBe(false);
  });

  it('walks up multiple levels of folder nesting to find a grant', async () => {
    const root = await makeFolder('root-8');
    const mid = await makeFolder('mid-8', root.id);
    const leaf = await makeFolder('leaf-8', mid.id);
    await grant('folder', root.id, 'user-h', 'download');

    const result = await acl.can({ id: 'user-h', roles: ['employee'] }, 'folder', leaf.id, 'download');
    expect(result).toBe(true);
  });
});
```

- [ ] **步驟 2：執行測試以確認它們會失敗**

執行：`cd apps/api && pnpm test -- acl.service`
預期結果：FAIL — `Cannot find module './acl.service'`

- [ ] **步驟 3：實作 `AclService`**

`apps/api/src/acl/acl.service.ts`：

```ts
import { Injectable } from '@nestjs/common';
import { PermissionLevel, ResourceType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

const LEVEL_ORDER: Record<PermissionLevel, number> = {
  view: 1,
  download: 2,
  edit: 3,
  manage: 4,
};

const MAX_FOLDER_DEPTH = 100;

interface AuthenticatedUser {
  id: string;
  roles: string[];
}

@Injectable()
export class AclService {
  constructor(private readonly prisma: PrismaService) {}

  async can(
    user: AuthenticatedUser,
    resourceType: ResourceType,
    resourceId: string,
    required: PermissionLevel,
  ): Promise<boolean> {
    if (user.roles.includes('admin')) {
      return true;
    }
    const level = await this.resolveLevel(user.id, resourceType, resourceId);
    if (!level) {
      return false;
    }
    return LEVEL_ORDER[level] >= LEVEL_ORDER[required];
  }

  async resolveLevel(
    userId: string,
    resourceType: ResourceType,
    resourceId: string,
  ): Promise<PermissionLevel | null> {
    if (resourceType === 'document') {
      const direct = await this.findGrant('document', resourceId, userId);
      if (direct) return direct;

      const doc = await this.prisma.document.findUnique({
        where: { id: resourceId },
        select: { folderId: true },
      });
      if (!doc) return null; // fail closed: a non-existent resource never grants access
      return this.resolveLevel(userId, 'folder', doc.folderId);
    }

    let folderId: string | null = resourceId;
    for (let depth = 0; folderId && depth < MAX_FOLDER_DEPTH; depth++) {
      const direct = await this.findGrant('folder', folderId, userId);
      if (direct) return direct;

      const folder: { parentId: string | null } | null = await this.prisma.folder.findUnique({
        where: { id: folderId },
        select: { parentId: true },
      });
      if (!folder) return null; // fail closed: a non-existent resource never grants access
      folderId = folder.parentId;
    }
    return null;
  }

  private async findGrant(
    resourceType: ResourceType,
    resourceId: string,
    userId: string,
  ): Promise<PermissionLevel | null> {
    const permission = await this.prisma.permission.findUnique({
      where: {
        resourceType_resourceId_principalType_principalId: {
          resourceType,
          resourceId,
          principalType: 'user',
          principalId: userId,
        },
      },
    });
    return permission?.permissionLevel ?? null;
  }
}
```

- [ ] **步驟 4：執行測試以確認它們通過**

執行：`cd apps/api && pnpm test -- acl.service`
預期結果：PASS（9 個測試）

- [ ] **步驟 5：建立 `apps/api/src/acl/acl.module.ts`**

```ts
import { Module } from '@nestjs/common';
import { AclService } from './acl.service';

@Module({
  providers: [AclService],
  exports: [AclService],
})
export class AclModule {}
```

- [ ] **步驟 6：提交（Commit）**

```bash
git add apps/api/src/acl
git commit -m "feat(api): add AclService with hierarchical, non-merging permission resolution"
```

---

### 任務 4：FoldersModule

**檔案：**
- Create: `apps/api/src/folders/folders.controller.ts`
- Create: `apps/api/src/folders/folders.service.ts`
- Create: `apps/api/src/folders/folders.module.ts`
- Modify: `apps/api/src/app.module.ts`
- Test: `apps/api/test/folders.e2e-spec.ts`

**介面：**
- 使用：`AclService.can`、`PrismaService`、`UsersService.upsertFromToken`（Phase 1，從 JWT payload 解析出應用程式層級的 `User.id`）。
- 產出：`POST /folders`（`{ name: string; parentId?: string }` → `201 { id, name, parentId, createdBy, createdAt }`）、`GET /folders/:id`（→ `200 { id, name, parentId, children: Folder[], documents: DocumentSummary[] }`）。

- [ ] **步驟 1：建立 `apps/api/src/folders/folders.service.ts`**

```ts
import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AclService } from '../acl/acl.service';

interface AuthenticatedUser {
  id: string;
  roles: string[];
}

@Injectable()
export class FoldersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly acl: AclService,
  ) {}

  async create(user: AuthenticatedUser, name: string, parentId: string | null) {
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

    return this.prisma.folder.create({
      data: { name, parentId: parentId ?? null, createdBy: user.id },
    });
  }

  async getWithContents(user: AuthenticatedUser, id: string) {
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
    return folder;
  }
}
```

- [ ] **步驟 2：建立 `apps/api/src/folders/folders.controller.ts`**

```ts
import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Request } from 'express';
import { FoldersService } from './folders.service';
import { UsersService } from '../users/users.service';

interface AuthenticatedRequest extends Request {
  user: { sub: string; email: string; name: string; roles: string[] };
}

@Controller('folders')
@UseGuards(AuthGuard('jwt'))
export class FoldersController {
  constructor(
    private readonly foldersService: FoldersService,
    private readonly usersService: UsersService,
  ) {}

  @Post()
  async create(@Req() req: AuthenticatedRequest, @Body() body: { name: string; parentId?: string }) {
    const user = await this.usersService.upsertFromToken(req.user);
    return this.foldersService.create(
      { id: user.id, roles: req.user.roles },
      body.name,
      body.parentId ?? null,
    );
  }

  @Get(':id')
  async get(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    const user = await this.usersService.upsertFromToken(req.user);
    return this.foldersService.getWithContents({ id: user.id, roles: req.user.roles }, id);
  }
}
```

- [ ] **步驟 3：建立 `apps/api/src/folders/folders.module.ts`**

```ts
import { Module } from '@nestjs/common';
import { FoldersController } from './folders.controller';
import { FoldersService } from './folders.service';
import { AclModule } from '../acl/acl.module';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [AclModule, UsersModule],
  controllers: [FoldersController],
  providers: [FoldersService],
  exports: [FoldersService],
})
export class FoldersModule {}
```

`UsersModule` 目前僅將 `UsersController`/`UsersService` 宣告為 providers，並未匯出 `UsersService`——請檢查 `apps/api/src/users/users.module.ts`，若缺少 `exports: [UsersService]` 則補上，因為 `FoldersModule`（以及後續的 `DocumentsModule`/`PermissionsModule`）都需要注入它。

- [ ] **步驟 4：將 `FoldersModule` 接入 `AppModule`**

將 `FoldersModule` 加入 `apps/api/src/app.module.ts` 的 `imports` 陣列。

- [ ] **步驟 5：撰寫 e2e 測試**

`apps/api/test/folders.e2e-spec.ts`：

```ts
import axios from 'axios';

const KEYCLOAK_TOKEN_URL = 'http://auth.drm.localhost/realms/drm/protocol/openid-connect/token';
const API_BASE_URL = 'http://api.drm.localhost';

async function getToken(username: string, password: string): Promise<string> {
  const response = await axios.post(
    KEYCLOAK_TOKEN_URL,
    new URLSearchParams({
      grant_type: 'password',
      client_id: 'drm-web',
      username,
      password,
    }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
  );
  return response.data.access_token;
}

describe('Folders (e2e)', () => {
  it('a non-admin cannot create a root folder', async () => {
    const token = await getToken('testuser', 'testpass');
    await expect(
      axios.post(
        `${API_BASE_URL}/folders`,
        { name: 'should-fail' },
        { headers: { Authorization: `Bearer ${token}` } },
      ),
    ).rejects.toMatchObject({ response: { status: 403 } });
  });

  it('a non-admin cannot view a folder they have no grant on', async () => {
    // This test depends on at least one folder already existing that testuser has no
    // access to. If no such folder exists yet in a fresh environment, this test should
    // first create one using an admin token (see Task 8's realm-export.json addition for
    // a seeded admin test user), then attempt to view it as testuser and expect 403.
    // Adjust once Task 8's admin test user is available — for now this documents the
    // intended check; implement it fully once that fixture exists, or use direct Prisma
    // access in a beforeAll to seed a folder if that's simpler for this task alone.
  });
});
```

第二個測試在此刻意留成一個有文件說明的佔位測試，因為它需要一個管理員身分來建立一個目前測試使用者看不到的資料夾——任務 8 會加入該項固定裝置（fixture）。等到任務 8 的 `testadmin` 使用者存在後就實作它，或者如果比較簡單，也可以在 `beforeAll` 中直接透過 Prisma 對正在執行的 Postgres（`postgresql://drm:drm_dev_password@localhost:5433/drm`）建立種子資料——依實際情況自行判斷；不要在任務 4 最終提交的檔案版本中留下一個實際上什麼都沒有斷言的測試。若選擇直接以 Prisma 建立種子資料的做法，請現在就寫出完整測試，而不要延後處理。

- [ ] **步驟 6：重新建置 API 並執行測試**

執行：`docker compose up -d --build api`
執行：`cd apps/api && pnpm test:e2e -- folders`
預期結果：PASS

- [ ] **步驟 7：提交（Commit）**

```bash
git add apps/api/src/folders apps/api/src/app.module.ts apps/api/src/users/users.module.ts apps/api/test/folders.e2e-spec.ts
git commit -m "feat(api): add folders module (create + view, ACL-enforced)"
```

---

### 任務 5：DocumentsModule — 上傳、版本控管

**檔案：**
- Create: `apps/api/src/documents/documents.controller.ts`
- Create: `apps/api/src/documents/documents.service.ts`
- Create: `apps/api/src/documents/documents.module.ts`
- Modify: `apps/api/src/app.module.ts`
- Test: `apps/api/test/documents-write.e2e-spec.ts`

**介面：**
- 使用：`AclService.can`、`StorageService.putObject`、`PrismaService`、`UsersService.upsertFromToken`。
- 產出：`POST /documents`（multipart：`file`，主體 `folderId`、`name` → `201` 文件 + 版本 1）、`POST /documents/:id/versions`（multipart：`file` → `201` 新版本，並更新 `currentVersionId`）、`GET /documents/:id/versions`（→ `200 DocumentVersion[]`，最新的排在最前面）。

- [ ] **步驟 1：加入 multer 型別**

加入到 `apps/api/package.json` 的 `devDependencies`：`"@types/multer": "^1.4.12"`（multer 本身作為 `@nestjs/platform-express` 的傳遞相依套件已經安裝）。

執行：`cd apps/api && pnpm install`

- [ ] **步驟 2：建立 `apps/api/src/documents/documents.service.ts`**

```ts
import { ForbiddenException, Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AclService } from '../acl/acl.service';
import { StorageService } from '../storage/storage.service';

interface AuthenticatedUser {
  id: string;
  roles: string[];
}

interface UploadedFile {
  buffer: Buffer;
  mimetype: string;
}

@Injectable()
export class DocumentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly acl: AclService,
    private readonly storage: StorageService,
  ) {}

  async createDocument(
    user: AuthenticatedUser,
    folderId: string,
    name: string,
    file: UploadedFile,
  ) {
    const allowed = await this.acl.can(user, 'folder', folderId, 'edit');
    if (!allowed) {
      throw new ForbiddenException('You do not have edit access to this folder');
    }

    const documentId = randomUUID();
    const versionId = randomUUID();
    const objectKey = `${documentId}/${versionId}`;
    const sha256 = createHash('sha256').update(file.buffer).digest('hex');

    await this.storage.putObject(objectKey, file.buffer, file.mimetype);

    return this.prisma.$transaction(async (tx) => {
      await tx.document.create({
        data: {
          id: documentId,
          folderId,
          name,
          createdBy: user.id,
        },
      });
      const version = await tx.documentVersion.create({
        data: {
          id: versionId,
          documentId,
          versionNumber: 1,
          objectKey,
          sha256,
          mimeType: file.mimetype,
          sizeBytes: file.buffer.length,
          uploadedBy: user.id,
        },
      });
      return tx.document.update({
        where: { id: documentId },
        data: { currentVersionId: version.id },
        include: { currentVersion: true },
      });
    });
  }

  async addVersion(user: AuthenticatedUser, documentId: string, file: UploadedFile) {
    const allowed = await this.acl.can(user, 'document', documentId, 'edit');
    if (!allowed) {
      throw new ForbiddenException('You do not have edit access to this document');
    }

    const latest = await this.prisma.documentVersion.findFirst({
      where: { documentId },
      orderBy: { versionNumber: 'desc' },
    });
    const nextVersionNumber = (latest?.versionNumber ?? 0) + 1;

    const versionId = randomUUID();
    const objectKey = `${documentId}/${versionId}`;
    const sha256 = createHash('sha256').update(file.buffer).digest('hex');

    await this.storage.putObject(objectKey, file.buffer, file.mimetype);

    const version = await this.prisma.documentVersion.create({
      data: {
        id: versionId,
        documentId,
        versionNumber: nextVersionNumber,
        objectKey,
        sha256,
        mimeType: file.mimetype,
        sizeBytes: file.buffer.length,
        uploadedBy: user.id,
      },
    });

    await this.prisma.document.update({
      where: { id: documentId },
      data: { currentVersionId: version.id },
    });

    return version;
  }

  async listVersions(user: AuthenticatedUser, documentId: string) {
    const allowed = await this.acl.can(user, 'document', documentId, 'view');
    if (!allowed) {
      throw new ForbiddenException('You do not have view access to this document');
    }
    return this.prisma.documentVersion.findMany({
      where: { documentId },
      orderBy: { versionNumber: 'desc' },
    });
  }
}
```

請注意 `$transaction` 內看似循環的 `document.create` → `documentVersion.create` → `document.update` 順序——這是必要的，因為 `DocumentVersion.documentId` 要求 `Document` 資料列必須先存在，但 `Document.currentVersionId` 又要求 `DocumentVersion` 資料列必須先存在。先以未設定 `currentVersionId` 的狀態建立文件，等版本存在後再更新它，就能在單一原子交易內解決這個循環相依問題。

- [ ] **步驟 3：建立 `apps/api/src/documents/documents.controller.ts`**

```ts
import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { AuthGuard } from '@nestjs/passport';
import { Request } from 'express';
import { DocumentsService } from './documents.service';
import { UsersService } from '../users/users.service';

interface AuthenticatedRequest extends Request {
  user: { sub: string; email: string; name: string; roles: string[] };
}

const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;

@Controller('documents')
@UseGuards(AuthGuard('jwt'))
export class DocumentsController {
  constructor(
    private readonly documentsService: DocumentsService,
    private readonly usersService: UsersService,
  ) {}

  @Post()
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_BYTES } }))
  async create(
    @Req() req: AuthenticatedRequest,
    @UploadedFile() file: Express.Multer.File,
    @Body() body: { folderId: string; name: string },
  ) {
    const user = await this.usersService.upsertFromToken(req.user);
    return this.documentsService.createDocument(
      { id: user.id, roles: req.user.roles },
      body.folderId,
      body.name,
      { buffer: file.buffer, mimetype: file.mimetype },
    );
  }

  @Post(':id/versions')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_BYTES } }))
  async addVersion(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    const user = await this.usersService.upsertFromToken(req.user);
    return this.documentsService.addVersion({ id: user.id, roles: req.user.roles }, id, {
      buffer: file.buffer,
      mimetype: file.mimetype,
    });
  }

  @Get(':id/versions')
  async listVersions(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    const user = await this.usersService.upsertFromToken(req.user);
    return this.documentsService.listVersions({ id: user.id, roles: req.user.roles }, id);
  }
}
```

- [ ] **步驟 4：建立 `apps/api/src/documents/documents.module.ts`**

```ts
import { Module } from '@nestjs/common';
import { DocumentsController } from './documents.controller';
import { DocumentsService } from './documents.service';
import { AclModule } from '../acl/acl.module';
import { StorageModule } from '../storage/storage.module';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [AclModule, StorageModule, UsersModule],
  controllers: [DocumentsController],
  providers: [DocumentsService],
  exports: [DocumentsService],
})
export class DocumentsModule {}
```

- [ ] **步驟 5：將 `DocumentsModule` 接入 `AppModule`**

將 `DocumentsModule` 加入 `apps/api/src/app.module.ts` 的 `imports` 陣列。

- [ ] **步驟 6：撰寫 e2e 測試**

`apps/api/test/documents-write.e2e-spec.ts`：

```ts
import axios from 'axios';
import FormData from 'form-data';

const KEYCLOAK_TOKEN_URL = 'http://auth.drm.localhost/realms/drm/protocol/openid-connect/token';
const API_BASE_URL = 'http://api.drm.localhost';

async function getToken(username: string, password: string): Promise<string> {
  const response = await axios.post(
    KEYCLOAK_TOKEN_URL,
    new URLSearchParams({ grant_type: 'password', client_id: 'drm-web', username, password }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
  );
  return response.data.access_token;
}

describe('Documents write path (e2e)', () => {
  it('a user with edit access can upload a document and a new version', async () => {
    const token = await getToken('testadmin', 'testadminpass');
    const authHeader = { Authorization: `Bearer ${token}` };

    const folderRes = await axios.post(
      `${API_BASE_URL}/folders`,
      { name: `test-folder-${Date.now()}` },
      { headers: authHeader },
    );
    const folderId = folderRes.data.id;

    const form1 = new FormData();
    form1.append('folderId', folderId);
    form1.append('name', 'test-doc.txt');
    form1.append('file', Buffer.from('version one content'), { filename: 'v1.txt' });

    const createRes = await axios.post(`${API_BASE_URL}/documents`, form1, {
      headers: { ...authHeader, ...form1.getHeaders() },
    });
    expect(createRes.status).toBe(201);
    expect(createRes.data.currentVersion.versionNumber).toBe(1);
    const documentId = createRes.data.id;

    const form2 = new FormData();
    form2.append('file', Buffer.from('version two content'), { filename: 'v2.txt' });

    const versionRes = await axios.post(`${API_BASE_URL}/documents/${documentId}/versions`, form2, {
      headers: { ...authHeader, ...form2.getHeaders() },
    });
    expect(versionRes.status).toBe(201);
    expect(versionRes.data.versionNumber).toBe(2);

    const listRes = await axios.get(`${API_BASE_URL}/documents/${documentId}/versions`, {
      headers: authHeader,
    });
    expect(listRes.data).toHaveLength(2);
    expect(listRes.data[0].versionNumber).toBe(2);
  });

  it('a user with no grant cannot upload into a folder they cannot edit', async () => {
    const adminToken = await getToken('testadmin', 'testadminpass');
    const folderRes = await axios.post(
      `${API_BASE_URL}/folders`,
      { name: `locked-folder-${Date.now()}` },
      { headers: { Authorization: `Bearer ${adminToken}` } },
    );

    const employeeToken = await getToken('testuser', 'testpass');
    const form = new FormData();
    form.append('folderId', folderRes.data.id);
    form.append('name', 'nope.txt');
    form.append('file', Buffer.from('should not be allowed'), { filename: 'nope.txt' });

    await expect(
      axios.post(`${API_BASE_URL}/documents`, form, {
        headers: { Authorization: `Bearer ${employeeToken}`, ...form.getHeaders() },
      }),
    ).rejects.toMatchObject({ response: { status: 403 } });
  });
});
```

這個測試使用 `testadmin`/`testadminpass`，這是本任務假設已存在的 Keycloak 使用者。如果依照你的執行順序任務 8 尚未執行，請直接在本任務中把一個最小化的 `testadmin` 使用者（角色為 `admin`）加入 `keycloak/realm-export.json`，不必等待——先檢查是否已經存在（`grep testadmin keycloak/realm-export.json`）；若不存在，現在就加入（形狀與既有的 `testuser` 項目相同，`realmRoles: ["admin"]`），並在報告中註明你把這個固定裝置從任務 8 提前拉過來使用。重新建置 Keycloak（`docker compose up -d --build keycloak`——請留意 Phase 1 中提到的 Keycloak 開發模式且未使用全新資料卷時的注意事項：如果 realm 先前已經匯入過一次，可能需要執行 `docker compose rm -sf keycloak && docker compose up -d keycloak` 才能強制進行真正全新的匯入，這也是本專案 Phase 1 報告歷史中已記載過的先例）。

另外，如果尚未加入，請將 `form-data` 加為相依套件：`apps/api/package.json` 的 `devDependencies`：`"form-data": "^4.0.0"`。

- [ ] **步驟 7：重新建置並執行**

執行：`docker compose up -d --build api`
執行：`cd apps/api && pnpm test:e2e -- documents-write`
預期結果：PASS

- [ ] **步驟 8：提交（Commit）**

```bash
git add apps/api/package.json apps/api/pnpm-lock.yaml apps/api/src/documents apps/api/src/app.module.ts apps/api/test/documents-write.e2e-spec.ts keycloak/realm-export.json
git commit -m "feat(api): add document upload and versioning (ACL-enforced, real MinIO storage)"
```

---

### 任務 6：文件讀取 — 中繼資料與下載

**檔案：**
- Modify: `apps/api/src/documents/documents.controller.ts`
- Modify: `apps/api/src/documents/documents.service.ts`
- Test: `apps/api/test/documents-read.e2e-spec.ts`

**介面：**
- 使用：`StorageService.getObjectStream`、`AclService.can`（兩者皆已在任務 5 中提供）。
- 產出：`GET /documents/:id`（→ `200` 文件中繼資料 + 目前版本）、`GET /documents/:id/download?versionId=`（→ 串流檔案位元組，預設為目前版本）。

- [ ] **步驟 1：在 `DocumentsService` 中加入方法**

附加到 `apps/api/src/documents/documents.service.ts`：

```ts
  async getMetadata(user: AuthenticatedUser, documentId: string) {
    const allowed = await this.acl.can(user, 'document', documentId, 'view');
    if (!allowed) {
      throw new ForbiddenException('You do not have view access to this document');
    }
    return this.prisma.document.findUniqueOrThrow({
      where: { id: documentId },
      include: { currentVersion: true },
    });
  }

  async getDownloadStream(user: AuthenticatedUser, documentId: string, versionId?: string) {
    const allowed = await this.acl.can(user, 'document', documentId, 'download');
    if (!allowed) {
      throw new ForbiddenException('You do not have download access to this document');
    }

    const version = versionId
      ? await this.prisma.documentVersion.findFirstOrThrow({
          where: { id: versionId, documentId },
        })
      : await this.prisma.document
          .findUniqueOrThrow({ where: { id: documentId }, include: { currentVersion: true } })
          .then((doc) => {
            if (!doc.currentVersion) {
              throw new Error(`Document ${documentId} has no current version`);
            }
            return doc.currentVersion;
          });

    const stream = await this.storage.getObjectStream(version.objectKey);
    return { stream, mimeType: version.mimeType, fileName: version.id };
  }
```

- [ ] **步驟 2：加入 controller 路由**

附加到 `apps/api/src/documents/documents.controller.ts`（在 `@nestjs/common` 的匯入中加入 `Query`、`Res`，並在 `express` 的匯入中加入 `Response`）：

```ts
  @Get(':id')
  async getMetadata(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    const user = await this.usersService.upsertFromToken(req.user);
    return this.documentsService.getMetadata({ id: user.id, roles: req.user.roles }, id);
  }

  @Get(':id/download')
  async download(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Query('versionId') versionId: string | undefined,
    @Res() res: Response,
  ) {
    const user = await this.usersService.upsertFromToken(req.user);
    const { stream, mimeType, fileName } = await this.documentsService.getDownloadStream(
      { id: user.id, roles: req.user.roles },
      id,
      versionId,
    );
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    stream.pipe(res);
  }
```

- [ ] **步驟 3：撰寫 e2e 測試**

`apps/api/test/documents-read.e2e-spec.ts`：

```ts
import axios from 'axios';
import FormData from 'form-data';

const KEYCLOAK_TOKEN_URL = 'http://auth.drm.localhost/realms/drm/protocol/openid-connect/token';
const API_BASE_URL = 'http://api.drm.localhost';

async function getToken(username: string, password: string): Promise<string> {
  const response = await axios.post(
    KEYCLOAK_TOKEN_URL,
    new URLSearchParams({ grant_type: 'password', client_id: 'drm-web', username, password }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
  );
  return response.data.access_token;
}

describe('Documents read path (e2e)', () => {
  it('downloads the current version content correctly, and is blocked without a grant', async () => {
    const adminToken = await getToken('testadmin', 'testadminpass');
    const adminHeader = { Authorization: `Bearer ${adminToken}` };

    const folderRes = await axios.post(
      `${API_BASE_URL}/folders`,
      { name: `read-test-${Date.now()}` },
      { headers: adminHeader },
    );

    const content = `download check ${Date.now()}`;
    const form = new FormData();
    form.append('folderId', folderRes.data.id);
    form.append('name', 'readme.txt');
    form.append('file', Buffer.from(content), { filename: 'readme.txt' });
    const createRes = await axios.post(`${API_BASE_URL}/documents`, form, {
      headers: { ...adminHeader, ...form.getHeaders() },
    });
    const documentId = createRes.data.id;

    const downloadRes = await axios.get(`${API_BASE_URL}/documents/${documentId}/download`, {
      headers: adminHeader,
      responseType: 'text',
    });
    expect(downloadRes.data).toBe(content);

    const employeeToken = await getToken('testuser', 'testpass');
    await expect(
      axios.get(`${API_BASE_URL}/documents/${documentId}/download`, {
        headers: { Authorization: `Bearer ${employeeToken}` },
      }),
    ).rejects.toMatchObject({ response: { status: 403 } });
  });
});
```

- [ ] **步驟 4：重新建置並執行**

執行：`docker compose up -d --build api`
執行：`cd apps/api && pnpm test:e2e -- documents-read`
預期結果：PASS

- [ ] **步驟 5：提交（Commit）**

```bash
git add apps/api/src/documents apps/api/test/documents-read.e2e-spec.ts
git commit -m "feat(api): add document metadata and download endpoints (ACL-enforced streaming)"
```

---

### 任務 7：PermissionsModule — 授予、列出、撤銷

**檔案：**
- Create: `apps/api/src/permissions/permissions.controller.ts`
- Create: `apps/api/src/permissions/permissions.service.ts`
- Create: `apps/api/src/permissions/permissions.module.ts`
- Modify: `apps/api/src/app.module.ts`
- Test: `apps/api/test/permissions.e2e-spec.ts`

**介面：**
- 使用：`AclService.can`、`PrismaService`、`UsersService.upsertFromToken`。
- 產出：`POST /folders/:id/permissions` 與 `POST /documents/:id/permissions`（主體 `{ principalType: 'user' | 'group'; principalId: string; permissionLevel: PermissionLevel }` → `201` 建立授權，若 `principalType` 為 `group` 則回傳 `400`）、`GET .../permissions`（→ `200` 清單）、`DELETE .../permissions/:permissionId`（→ `204`）——全部都要求對目標資源擁有 `manage` 權限。

- [ ] **步驟 1：建立 `apps/api/src/permissions/permissions.service.ts`**

```ts
import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { PermissionLevel, PrincipalType, ResourceType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AclService } from '../acl/acl.service';

interface AuthenticatedUser {
  id: string;
  roles: string[];
}

@Injectable()
export class PermissionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly acl: AclService,
  ) {}

  async grant(
    user: AuthenticatedUser,
    resourceType: ResourceType,
    resourceId: string,
    principalType: PrincipalType,
    principalId: string,
    permissionLevel: PermissionLevel,
  ) {
    if (principalType === 'group') {
      throw new BadRequestException('group principals are not yet supported');
    }

    const allowed = await this.acl.can(user, resourceType, resourceId, 'manage');
    if (!allowed) {
      throw new ForbiddenException('You do not have manage access to this resource');
    }

    return this.prisma.permission.upsert({
      where: {
        resourceType_resourceId_principalType_principalId: {
          resourceType,
          resourceId,
          principalType,
          principalId,
        },
      },
      update: { permissionLevel, grantedBy: user.id },
      create: {
        resourceType,
        resourceId,
        principalType,
        principalId,
        permissionLevel,
        grantedBy: user.id,
      },
    });
  }

  async list(user: AuthenticatedUser, resourceType: ResourceType, resourceId: string) {
    const allowed = await this.acl.can(user, resourceType, resourceId, 'manage');
    if (!allowed) {
      throw new ForbiddenException('You do not have manage access to this resource');
    }
    return this.prisma.permission.findMany({ where: { resourceType, resourceId } });
  }

  async revoke(
    user: AuthenticatedUser,
    resourceType: ResourceType,
    resourceId: string,
    permissionId: string,
  ) {
    const allowed = await this.acl.can(user, resourceType, resourceId, 'manage');
    if (!allowed) {
      throw new ForbiddenException('You do not have manage access to this resource');
    }
    await this.prisma.permission.delete({ where: { id: permissionId } });
  }
}
```

`grant` 使用 `upsert` 而非單純的 `create`，因為 schema 中的 `@@unique([resourceType, resourceId, principalType, principalId])` 表示對同一資源上同一主體授予第二個、不同等級的權限時，應該更新既有資料列，而不是拋出唯一性約束錯誤——這是「變更某人存取等級」時自然且預期的行為。

- [ ] **步驟 2：建立 `apps/api/src/permissions/permissions.controller.ts`**

```ts
import { Body, Controller, Delete, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Request } from 'express';
import { PermissionLevel, PrincipalType } from '@prisma/client';
import { PermissionsService } from './permissions.service';
import { UsersService } from '../users/users.service';

interface AuthenticatedRequest extends Request {
  user: { sub: string; email: string; name: string; roles: string[] };
}

interface GrantBody {
  principalType: PrincipalType;
  principalId: string;
  permissionLevel: PermissionLevel;
}

@UseGuards(AuthGuard('jwt'))
@Controller()
export class PermissionsController {
  constructor(
    private readonly permissionsService: PermissionsService,
    private readonly usersService: UsersService,
  ) {}

  @Post('folders/:id/permissions')
  async grantOnFolder(@Req() req: AuthenticatedRequest, @Param('id') id: string, @Body() body: GrantBody) {
    const user = await this.usersService.upsertFromToken(req.user);
    return this.permissionsService.grant(
      { id: user.id, roles: req.user.roles },
      'folder',
      id,
      body.principalType,
      body.principalId,
      body.permissionLevel,
    );
  }

  @Get('folders/:id/permissions')
  async listOnFolder(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    const user = await this.usersService.upsertFromToken(req.user);
    return this.permissionsService.list({ id: user.id, roles: req.user.roles }, 'folder', id);
  }

  @Delete('folders/:id/permissions/:permissionId')
  async revokeOnFolder(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Param('permissionId') permissionId: string,
  ) {
    const user = await this.usersService.upsertFromToken(req.user);
    await this.permissionsService.revoke({ id: user.id, roles: req.user.roles }, 'folder', id, permissionId);
    return { success: true };
  }

  @Post('documents/:id/permissions')
  async grantOnDocument(@Req() req: AuthenticatedRequest, @Param('id') id: string, @Body() body: GrantBody) {
    const user = await this.usersService.upsertFromToken(req.user);
    return this.permissionsService.grant(
      { id: user.id, roles: req.user.roles },
      'document',
      id,
      body.principalType,
      body.principalId,
      body.permissionLevel,
    );
  }

  @Get('documents/:id/permissions')
  async listOnDocument(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    const user = await this.usersService.upsertFromToken(req.user);
    return this.permissionsService.list({ id: user.id, roles: req.user.roles }, 'document', id);
  }

  @Delete('documents/:id/permissions/:permissionId')
  async revokeOnDocument(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Param('permissionId') permissionId: string,
  ) {
    const user = await this.usersService.upsertFromToken(req.user);
    await this.permissionsService.revoke({ id: user.id, roles: req.user.roles }, 'document', id, permissionId);
    return { success: true };
  }
}
```

- [ ] **步驟 3：建立 `apps/api/src/permissions/permissions.module.ts`**

```ts
import { Module } from '@nestjs/common';
import { PermissionsController } from './permissions.controller';
import { PermissionsService } from './permissions.service';
import { AclModule } from '../acl/acl.module';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [AclModule, UsersModule],
  controllers: [PermissionsController],
  providers: [PermissionsService],
})
export class PermissionsModule {}
```

- [ ] **步驟 4：接入 `AppModule`**

將 `PermissionsModule` 加入 `apps/api/src/app.module.ts`。

- [ ] **步驟 5：撰寫 e2e 測試**

`apps/api/test/permissions.e2e-spec.ts`：

```ts
import axios from 'axios';

const KEYCLOAK_TOKEN_URL = 'http://auth.drm.localhost/realms/drm/protocol/openid-connect/token';
const API_BASE_URL = 'http://api.drm.localhost';

async function getToken(username: string, password: string): Promise<string> {
  const response = await axios.post(
    KEYCLOAK_TOKEN_URL,
    new URLSearchParams({ grant_type: 'password', client_id: 'drm-web', username, password }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
  );
  return response.data.access_token;
}

async function whoami(token: string) {
  const res = await axios.get(`${API_BASE_URL}/whoami`, { headers: { Authorization: `Bearer ${token}` } });
  return res.data as { id: string };
}

describe('Permissions (e2e)', () => {
  it('grants view access to another user, who can then see the folder but not manage it', async () => {
    const adminToken = await getToken('testadmin', 'testadminpass');
    const adminHeader = { Authorization: `Bearer ${adminToken}` };

    const folderRes = await axios.post(
      `${API_BASE_URL}/folders`,
      { name: `perm-test-${Date.now()}` },
      { headers: adminHeader },
    );
    const folderId = folderRes.data.id;

    const employeeToken = await getToken('testuser', 'testpass');
    const employeeUser = await whoami(employeeToken);

    await expect(
      axios.get(`${API_BASE_URL}/folders/${folderId}`, {
        headers: { Authorization: `Bearer ${employeeToken}` },
      }),
    ).rejects.toMatchObject({ response: { status: 403 } });

    await axios.post(
      `${API_BASE_URL}/folders/${folderId}/permissions`,
      { principalType: 'user', principalId: employeeUser.id, permissionLevel: 'view' },
      { headers: adminHeader },
    );

    const viewRes = await axios.get(`${API_BASE_URL}/folders/${folderId}`, {
      headers: { Authorization: `Bearer ${employeeToken}` },
    });
    expect(viewRes.status).toBe(200);

    await expect(
      axios.post(
        `${API_BASE_URL}/folders/${folderId}/permissions`,
        { principalType: 'user', principalId: employeeUser.id, permissionLevel: 'manage' },
        { headers: { Authorization: `Bearer ${employeeToken}` } },
      ),
    ).rejects.toMatchObject({ response: { status: 403 } });
  });

  it('rejects granting a group-type principal with 400', async () => {
    const adminToken = await getToken('testadmin', 'testadminpass');
    const folderRes = await axios.post(
      `${API_BASE_URL}/folders`,
      { name: `perm-group-test-${Date.now()}` },
      { headers: { Authorization: `Bearer ${adminToken}` } },
    );

    await expect(
      axios.post(
        `${API_BASE_URL}/folders/${folderRes.data.id}/permissions`,
        { principalType: 'group', principalId: 'some-group', permissionLevel: 'view' },
        { headers: { Authorization: `Bearer ${adminToken}` } },
      ),
    ).rejects.toMatchObject({ response: { status: 400 } });
  });
});
```

- [ ] **步驟 6：重新建置並執行**

執行：`docker compose up -d --build api`
執行：`cd apps/api && pnpm test:e2e -- permissions`
預期結果：PASS

- [ ] **步驟 7：提交（Commit）**

```bash
git add apps/api/src/permissions apps/api/src/app.module.ts apps/api/test/permissions.e2e-spec.ts
git commit -m "feat(api): add permissions module (grant/list/revoke, manage-gated)"
```

---

### 任務 8：建立第二個測試身分並執行完整套件驗證

**檔案：**
- Modify: `keycloak/realm-export.json`（僅在任務 5 尚未加入 `testadmin` 時才需要——請先確認）
- Create: `docs/superpowers/plans/2026-08-01-phase2b-verification.md`

**介面：**
- 使用：任務 1 至任務 7 的所有內容。
- 產出：一份書面、可重複執行的 Phase 2B 驗證紀錄，並確認所有自動化套件在一起執行時皆能通過（而非僅逐一任務個別通過）。

- [ ] **步驟 1：確認 `testadmin` 存在於 realm 中**

執行：`grep -A3 testadmin keycloak/realm-export.json`
若缺少（任務 5 的實作者因為以不同方式建立資料夾種子而不需要加入，或者你是以不同順序執行任務），現在就將其加入 `keycloak/realm-export.json` 的 `users` 陣列，形狀與既有的 `testuser` 項目相同，但使用 `"username": "testadmin"`、`"email": "testadmin@example.com"`、`password` 憑證為 `testadminpass`，以及 `"realmRoles": ["admin"]`。強制執行一次全新的 Keycloak realm 匯入（`docker compose rm -sf keycloak && docker compose up -d keycloak`，依照本專案中針對 realm 設定變更已建立的先例），並透過一次 token 請求確認 `testadmin` 能夠登入且帶有 `admin` 角色。

- [ ] **步驟 2：全新地一起執行所有自動化套件**

執行：`docker compose down -v && docker compose up -d --build`
等待所有服務進入健康狀態（在主機負載下，Keycloak 冷啟動約需 90-170 秒）。
執行：`./scripts/smoke-test.sh`
執行：`pnpm --filter api test`
執行：`pnpm --filter api test:e2e`
執行：`pnpm --filter web test`

全部都必須通過。如果先前在各自任務中獨立執行時通過的測試，在與其他一切一起執行時卻失敗了（例如 `folders.e2e-spec.ts` 與 `documents-write.e2e-spec.ts` 都建立了名稱相近的資料夾而發生測試資料衝突，或是在高負載下 Testcontainers 發生連接埠衝突），請修正它——這正是逐任務層級測試可能會遺漏的整合性問題。

- [ ] **步驟 3：手動端對端走查**

使用 `curl` 或 REST 客戶端，手動走過一次完整流程，作為自動化套件之外的健全性檢查：以 `testadmin` 登入、建立一個根資料夾、上傳一份文件進去、下載回來確認位元組相符、上傳第二個版本、將 `view` 授予 `testuser`、以 `testuser` 登入並確認能檢視但不能編輯或管理、撤銷該授權、確認 `testuser` 再次被鎖住無法存取。

- [ ] **步驟 4：撰寫 `docs/superpowers/plans/2026-08-01-phase2b-verification.md`**

記錄步驟 2-3 中檢查過的內容（套件執行結果，以及手動走查的簡短敘述），格式比照 `docs/superpowers/plans/2026-07-31-phase1-verification.md`。

- [ ] **步驟 5：提交（Commit）**

```bash
git add keycloak/realm-export.json docs/superpowers/plans/2026-08-01-phase2b-verification.md
git commit -m "docs: add Phase 2B verification record, confirm testadmin fixture"
```

---

## 自我審查備註

- **規格涵蓋範圍：** 涵蓋設計規格中 folders/documents/document_versions/permissions 資料表，以及本階段所負責範圍內的「上傳」/「檢視/下載」/「版本管理」工作流程。明確延後處理的項目（依照先前議定的設計規格分階段規劃）：稽核記錄（`audit_logs` 資料表，Phase 3）、浮水印、Office 轉 PDF、到期/自動失效、病毒掃描（全部屬於 Phase 4——目前 schema 尚未加入 `documents.expires_at`/`documents.watermark_enabled`，因為本階段沒有任何程式碼會讀寫它們；現在就加入用不到的欄位會是一種臆測性的做法）。
- **佔位符掃描：** 有一處刻意保留的軟性缺口，已明確標註而非悄悄略過：任務 4 的第二個 e2e 測試被寫成一個附有文件說明的佔位測試，並清楚指示要嘛直接透過 Prisma 建立種子資料，要嘛等待任務 8 的 `testadmin` 固定裝置——本計畫要求在該任務被視為完成之前必須真正解決它，而不是留下一段死程式碼。
- **型別一致性：** `AclService.can(user, resourceType, resourceId, required)` 的簽章只在任務 3 中定義一次，並由 `FoldersService`、`DocumentsService`、`PermissionsService` 以完全相同的方式使用。`{ id: string; roles: string[] }` 這個已驗證使用者的形狀在每個服務中都一致。`PermissionLevel`/`ResourceType`/`PrincipalType` 列舉值（`view`/`download`/`edit`/`manage`、`folder`/`document`、`user`/`group`）只在任務 1 的 schema 中定義一次，並在各處以完全相同的方式參照。
- **範圍：** 僅涉及業務邏輯，完全建構在 Phase 2A 已驗證的儲存鏈與 Phase 1 已驗證的驗證機制之上——本計畫並未引入任何新的基礎設施服務。
