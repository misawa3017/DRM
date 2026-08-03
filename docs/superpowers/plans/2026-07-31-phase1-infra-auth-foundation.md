# 第一階段：基礎設施與身份驗證基礎建設實作計畫

> **給代理型工作者的說明：** 必要子技能：請使用 superpowers:subagent-driven-development（建議）或 superpowers:executing-plans 逐一任務地實作此計畫。步驟使用核取方塊（`- [ ]`）語法進行追蹤。

**目標：** 建立 monorepo、本機 Docker Compose 基礎設施，以及一條完整的身份驗證往返流程（React SPA → Keycloak 登入 → NestJS API `/whoami` → Postgres），讓後續每個階段都有可用的基礎可以延伸建置。

**架構：** 一個 pnpm monorepo，內含 `apps/api`（NestJS + Prisma + Postgres）與 `apps/web`（React + Vite），前端由 Traefik 負責本機路由（`app.drm.localhost`、`api.drm.localhost`、`auth.drm.localhost`）。身份驗證由 Keycloak 提供；API 透過 JWKS 驗證 Keycloak 簽發的 JWT，並在第一次已驗證的請求時 upsert 一筆本機 `User` 資料列。

**技術堆疊：** Node.js 20、pnpm、NestJS 10、Prisma 5、PostgreSQL 16、React 18、Vite 5、react-oidc-context、passport-jwt + jwks-rsa、Keycloak 25、Traefik v3.6、Jest + Testcontainers（API）、Vitest + React Testing Library（web）。

## 全域限制條件

- 所有 Node 服務皆使用 Node.js 20 LTS；套件管理工具為 pnpm（每個 `package.json` 都固定 `packageManager: pnpm@9.7.0`）。
- 全面採用 TypeScript 嚴格模式。
- 後端：NestJS 10，以 Prisma 5 作為 ORM，資料庫為 PostgreSQL 16。
- 前端：React 18 + Vite 5 + TypeScript。使用通用 OIDC 的 `react-oidc-context`，而非 Keycloak 專屬轉接器，讓日後更換身份提供者的成本維持低廉。
- 後端 JWT 驗證使用 `passport-jwt` + `jwks-rsa`，針對 Keycloak realm 的 JWKS 端點進行驗證——不使用任何 Keycloak 專屬的 Nest 函式庫。
- 測試執行器：`apps/api` 使用 Jest（單元測試 + e2e），`apps/web` 使用 Vitest + React Testing Library。
- 整合測試：在近似單元測試的情境中使用 `@testcontainers/postgresql` 產生臨時性的 Postgres；身份驗證 e2e 測試則是針對已經在執行中的 `docker compose` 堆疊執行（不會每次測試都重新啟動）。
- 本機路由透過 Traefik v3.6，統一使用 `*.drm.localhost` 網域——不需要修改 `/etc/hosts`（現代作業系統／瀏覽器預設會將 `.localhost` 解析到 loopback）。
- Keycloak realm 名稱：`drm`。SPA client id：`drm-web`（public client，啟用 PKCE 與 direct access grants，以便測試時取得 token）。Realm 角色：`admin`、`deptmanager`、`employee`。預先建立的測試使用者：`testuser` / `testpass`，角色為 `employee`。
- **第一階段範圍界線：** 此階段僅執行 Postgres、Keycloak、Traefik、`api`、`web`。MinIO、KES、OpenBao、Redis、Gotenberg 與 ClamAV 會在第二階段以後、當文件儲存與背景工作實際會用到它們時才會導入。

---

### 任務 1：Monorepo 骨架建置

**檔案：**
- 新增：`package.json`
- 新增：`pnpm-workspace.yaml`
- 新增：`.gitignore`
- 新增：`.env.example`

**介面：**
- 產出：以 repo 根目錄為基礎的 pnpm workspace，並以 `apps/*` 作為 workspace 套件。根目錄的 `dev:api`、`dev:web`、`test:api`、`test:web` 指令會委派給對應的 workspace 套件執行。

- [ ] **步驟 1：建立根目錄 `package.json`**

```json
{
  "name": "drm",
  "private": true,
  "packageManager": "pnpm@9.7.0",
  "engines": {
    "node": ">=20"
  },
  "scripts": {
    "dev:api": "pnpm --filter api start:dev",
    "dev:web": "pnpm --filter web dev",
    "test:api": "pnpm --filter api test",
    "test:web": "pnpm --filter web test"
  }
}
```

- [ ] **步驟 2：建立 `pnpm-workspace.yaml`**

```yaml
packages:
  - "apps/*"
```

- [ ] **步驟 3：建立 `.gitignore`**

```
node_modules/
dist/
.env
apps/*/node_modules
apps/api/generated
apps/api/prisma/migrations/.temp
```

- [ ] **步驟 4：建立 `.env.example`**

```
POSTGRES_USER=drm
POSTGRES_PASSWORD=drm_dev_password
POSTGRES_DB=drm
KEYCLOAK_ADMIN_PASSWORD=admin_dev_password
```

- [ ] **步驟 5：驗證 workspace 能順利安裝**

執行：`pnpm install`
預期：順利完成、沒有錯誤（目前還沒有任何 workspace 套件，所以這一步只是建立根目錄的 lockfile）。

- [ ] **步驟 6：提交（Commit）**

```bash
git add package.json pnpm-workspace.yaml .gitignore .env.example
git commit -m "chore: scaffold pnpm monorepo"
```

---

### 任務 2：NestJS API 骨架與健康檢查端點

**檔案：**
- 新增：`apps/api/package.json`
- 新增：`apps/api/tsconfig.json`
- 新增：`apps/api/nest-cli.json`
- 新增：`apps/api/src/main.ts`
- 新增：`apps/api/src/app.module.ts`
- 新增：`apps/api/src/health/health.controller.ts`
- 測試：`apps/api/src/health/health.controller.spec.ts`
- 新增：`apps/api/Dockerfile`

**介面：**
- 依賴：無（此為第一個應用層級的任務）。
- 產出：`HealthController.check(): { status: 'ok' }`，掛載於 `GET /health`。`AppModule` 可供後續任務匯入，以註冊其他模組。

- [ ] **步驟 1：建立 `apps/api/package.json`**

```json
{
  "name": "api",
  "version": "0.1.0",
  "private": true,
  "packageManager": "pnpm@9.7.0",
  "scripts": {
    "build": "nest build",
    "start": "nest start",
    "start:dev": "nest start --watch",
    "test": "jest",
    "test:e2e": "jest --config ./test/jest-e2e.json"
  },
  "dependencies": {
    "@nestjs/common": "^10.4.0",
    "@nestjs/core": "^10.4.0",
    "@nestjs/platform-express": "^10.4.0",
    "@nestjs/passport": "^10.0.3",
    "@prisma/client": "^5.19.0",
    "passport": "^0.7.0",
    "passport-jwt": "^4.0.1",
    "jwks-rsa": "^3.1.0",
    "prisma": "^5.19.0",
    "reflect-metadata": "^0.2.2",
    "rxjs": "^7.8.1"
  },
  "devDependencies": {
    "@nestjs/cli": "^10.4.5",
    "@nestjs/testing": "^10.4.0",
    "@testcontainers/postgresql": "^10.13.0",
    "@types/express": "^4.17.21",
    "@types/jest": "^29.5.12",
    "@types/node": "^20.14.0",
    "@types/passport-jwt": "^4.0.1",
    "axios": "^1.7.7",
    "jest": "^29.7.0",
    "supertest": "^7.0.0",
    "ts-jest": "^29.2.4",
    "ts-node": "^10.9.2",
    "typescript": "^5.5.4"
  },
  "jest": {
    "moduleFileExtensions": ["js", "json", "ts"],
    "rootDir": "src",
    "testRegex": ".*\\.spec\\.ts$",
    "transform": { "^.+\\.(t|j)s$": "ts-jest" }
  }
}
```

- [ ] **步驟 2：建立 `apps/api/tsconfig.json`**

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

- [ ] **步驟 3：建立 `apps/api/nest-cli.json`**

```json
{
  "collection": "@nestjs/schematics",
  "sourceRoot": "src"
}
```

- [ ] **步驟 4：安裝相依套件**

執行：`cd apps/api && pnpm install`
預期：順利完成、沒有錯誤。

- [ ] **步驟 5：撰寫會失敗的測試**

`apps/api/src/health/health.controller.spec.ts`：

```ts
import { Test, TestingModule } from '@nestjs/testing';
import { HealthController } from './health.controller';

describe('HealthController', () => {
  let controller: HealthController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [HealthController],
    }).compile();

    controller = module.get<HealthController>(HealthController);
  });

  it('returns ok status', () => {
    expect(controller.check()).toEqual({ status: 'ok' });
  });
});
```

- [ ] **步驟 6：執行測試以確認失敗**

執行：`cd apps/api && pnpm test`
預期：失敗（FAIL）——`Cannot find module './health.controller'`

- [ ] **步驟 7：實作 `HealthController`**

`apps/api/src/health/health.controller.ts`：

```ts
import { Controller, Get } from '@nestjs/common';

@Controller('health')
export class HealthController {
  @Get()
  check() {
    return { status: 'ok' };
  }
}
```

- [ ] **步驟 8：執行測試以確認通過**

執行：`cd apps/api && pnpm test`
預期：通過（PASS）

- [ ] **步驟 9：建立 `AppModule` 與 `main.ts`**

`apps/api/src/app.module.ts`：

```ts
import { Module } from '@nestjs/common';
import { HealthController } from './health/health.controller';

@Module({
  imports: [],
  controllers: [HealthController],
})
export class AppModule {}
```

`apps/api/src/main.ts`：

```ts
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableCors({ origin: process.env.WEB_ORIGIN ?? 'http://app.drm.localhost' });
  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
```

- [ ] **步驟 10：驗證應用程式能正常啟動**

執行：`cd apps/api && pnpm start`
預期：出現日誌訊息 `Nest application successfully started`。在另一個終端機執行 `curl http://localhost:3000/health`，應回傳 `{"status":"ok"}`。驗證完成後停止該行程（Ctrl+C）。

- [ ] **步驟 11：建立 `apps/api/Dockerfile`**

Workspace 的 lockfile 位於 repo 根目錄（任務 1），而非各應用程式目錄下，因此這個 Dockerfile 建置時必須以 **repo 根目錄作為 build context**（`docker build -f apps/api/Dockerfile .`），而非 `./apps/api`。任務 4 的 `docker-compose.yml` 也相應地設定了 `context: .` / `dockerfile: apps/api/Dockerfile`。

```dockerfile
FROM node:20-alpine AS build
WORKDIR /repo
RUN corepack enable
RUN apk add --no-cache openssl
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY apps/api/package.json apps/api/package.json
RUN pnpm install --frozen-lockfile
COPY apps/api ./apps/api
RUN pnpm --filter api exec prisma generate || true
RUN pnpm --filter api run build

FROM node:20-alpine
WORKDIR /repo
RUN corepack enable
RUN apk add --no-cache openssl
ENV NODE_ENV=production
COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/apps/api/node_modules ./apps/api/node_modules
COPY --from=build /repo/apps/api/dist ./apps/api/dist
COPY --from=build /repo/apps/api/package.json ./apps/api/package.json
COPY --from=build /repo/apps/api/prisma ./apps/api/prisma
WORKDIR /repo/apps/api
EXPOSE 3000
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/main.js"]
```

（`prisma generate || true` 可容忍目前尚未存在 `prisma/schema.prisma` 的情況——任務 3 會補上它。`CMD` 中的 `migrate deploy` 會在容器啟動時，將任務 3 的遷移套用到實際的 Postgres 上，這也是為什麼 `prisma/`（內含 schema 與遷移檔）也必須複製到執行階段（runtime stage），而不只是 `dist/`。兩個階段都需要 `openssl`，因為 Prisma 在 Alpine 上的查詢引擎二進位檔，在 `generate`／`build` 階段與執行階段都會連結（link）到它。）

- [ ] **步驟 11a：驗證映像檔確實能建置成功**

執行（於 repo 根目錄）：`docker build -f apps/api/Dockerfile -t drm-api-test .`
預期：建置成功（exit 0），最終產生標記為 `drm-api-test` 的映像檔。

- [ ] **步驟 12：提交（Commit）**

```bash
git add apps/api
git commit -m "feat(api): scaffold NestJS app with health endpoint"
```

---

### 任務 3：Prisma + Postgres 整合（User 模型）

**檔案：**
- 新增：`apps/api/prisma/schema.prisma`
- 新增：`apps/api/src/prisma/prisma.service.ts`
- 新增：`apps/api/src/prisma/prisma.module.ts`
- 修改：`apps/api/src/app.module.ts`
- 測試：`apps/api/src/prisma/user-persistence.spec.ts`

**介面：**
- 依賴：除了任務 2 的 `AppModule` 之外沒有新的依賴。
- 產出：`PrismaModule`（global，匯出 `PrismaService`）。`User` 模型：`{ id: string, keycloakSub: string, email: string, displayName: string, department: string | null, createdAt: Date, updatedAt: Date }`。

- [ ] **步驟 1：建立 `apps/api/prisma/schema.prisma`**

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model User {
  id          String   @id @default(uuid())
  keycloakSub String   @unique
  email       String   @unique
  displayName String
  department  String?
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  @@map("users")
}
```

- [ ] **步驟 2：啟動本機 Postgres 以撰寫遷移檔**

執行：`docker run --rm -d --name drm-dev-postgres -e POSTGRES_USER=drm -e POSTGRES_PASSWORD=drm_dev_password -e POSTGRES_DB=drm -p 5432:5432 postgres:16-alpine`
預期：容器啟動成功。

- [ ] **步驟 3：產生初始遷移檔**

執行：`cd apps/api && DATABASE_URL="postgresql://drm:drm_dev_password@localhost:5432/drm" pnpm exec prisma migrate dev --name init`
預期：建立 `apps/api/prisma/migrations/<timestamp>_init/migration.sql` 並套用；輸出 `Your database is now in sync with your schema.`

- [ ] **步驟 4：停止臨時的 Postgres**

執行：`docker stop drm-dev-postgres`

- [ ] **步驟 5：建立 `PrismaService`**

`apps/api/src/prisma/prisma.service.ts`：

```ts
import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
```

- [ ] **步驟 6：建立 `PrismaModule`**

`apps/api/src/prisma/prisma.module.ts`：

```ts
import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
```

- [ ] **步驟 7：將 `PrismaModule` 接入 `AppModule`**

`apps/api/src/app.module.ts`：

```ts
import { Module } from '@nestjs/common';
import { HealthController } from './health/health.controller';
import { PrismaModule } from './prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [HealthController],
})
export class AppModule {}
```

- [ ] **步驟 8：撰寫會失敗的整合測試**

`apps/api/src/prisma/user-persistence.spec.ts`：

```ts
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { execSync } from 'child_process';
import { PrismaClient } from '@prisma/client';
import * as path from 'path';

describe('User persistence', () => {
  let container: StartedPostgreSqlContainer;
  let prisma: PrismaClient;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    process.env.DATABASE_URL = container.getConnectionUri();
    execSync('pnpm exec prisma migrate deploy', {
      cwd: path.join(__dirname, '..', '..'),
      env: { ...process.env },
      stdio: 'inherit',
    });
    prisma = new PrismaClient();
  }, 60000);

  afterAll(async () => {
    await prisma.$disconnect();
    await container.stop();
  });

  it('creates and retrieves a user', async () => {
    const created = await prisma.user.create({
      data: {
        keycloakSub: 'abc-123',
        email: 'jane@example.com',
        displayName: 'Jane Doe',
      },
    });

    const found = await prisma.user.findUnique({ where: { id: created.id } });
    expect(found?.email).toBe('jane@example.com');
  });

  it('enforces unique email', async () => {
    await prisma.user.create({
      data: { keycloakSub: 'dup-1', email: 'dup@example.com', displayName: 'Dup One' },
    });

    await expect(
      prisma.user.create({
        data: { keycloakSub: 'dup-2', email: 'dup@example.com', displayName: 'Dup Two' },
      }),
    ).rejects.toThrow();
  });
});
```

- [ ] **步驟 9：執行測試以確認失敗**

執行：`cd apps/api && pnpm test -- user-persistence`
預期：只有在 `@prisma/client` 尚未產生時才會失敗（FAIL）——若錯誤訊息為「did not initialize yet」，請先執行 `pnpm exec prisma generate`，再重新執行以確認這個測試本身確實有意義（一旦 client 產生完成，測試應該會通過，因為步驟 1-7 的實作早已存在；這一步的目的是在繼續之前，先確認 Testcontainers 的串接正確無誤）。

- [ ] **步驟 10：產生 Prisma client 並執行測試以確認通過**

執行：`cd apps/api && pnpm exec prisma generate && pnpm test -- user-persistence`
預期：通過（PASS，共 2 項測試）

- [ ] **步驟 11：提交（Commit）**

```bash
git add apps/api
git commit -m "feat(api): add Prisma User model with Postgres integration test"
```

---

### 任務 4：Docker Compose 基礎設施（Postgres、Keycloak、Traefik、api、web）

**檔案：**
- 新增：`docker-compose.yml`
- 新增：`keycloak/realm-export.json`
- 新增：`scripts/smoke-test.sh`

**介面：**
- 依賴：`apps/api/Dockerfile`（任務 2）、`apps/web` 目錄（本任務中先建立一個佔位版本，並於任務 6 完整建置）。
- 產出：可透過 `http://app.drm.localhost`、`http://api.drm.localhost`、`http://auth.drm.localhost` 存取的運作中服務。Keycloak realm `drm`，含 client `drm-web`、角色 `admin`/`deptmanager`/`employee`，以及預先建立的使用者 `testuser`/`testpass`（角色 `employee`）。

- [ ] **步驟 1：建立 `apps/web` 的佔位內容，讓 Compose 能夠建置它**

執行：
```bash
mkdir -p apps/web
cat > apps/web/Dockerfile << 'EOF'
FROM nginx:1.27-alpine
RUN echo '<html><body>DRM web placeholder</body></html>' > /usr/share/nginx/html/index.html
EXPOSE 80
EOF
```
（這個佔位內容會在任務 6 中被真正的 Vite 建置取代。）

- [ ] **步驟 2：建立 `keycloak/realm-export.json`**

```json
{
  "realm": "drm",
  "enabled": true,
  "sslRequired": "none",
  "registrationAllowed": false,
  "roles": {
    "realm": [
      { "name": "admin" },
      { "name": "deptmanager" },
      { "name": "employee" }
    ]
  },
  "clients": [
    {
      "clientId": "drm-web",
      "publicClient": true,
      "enabled": true,
      "protocol": "openid-connect",
      "redirectUris": ["http://app.drm.localhost/*"],
      "webOrigins": ["http://app.drm.localhost"],
      "standardFlowEnabled": true,
      "directAccessGrantsEnabled": true
    }
  ],
  "users": [
    {
      "username": "testuser",
      "enabled": true,
      "email": "testuser@example.com",
      "firstName": "Test",
      "lastName": "User",
      "emailVerified": true,
      "credentials": [
        { "type": "password", "value": "testpass", "temporary": false }
      ],
      "realmRoles": ["employee"]
    }
  ]
}
```

- [ ] **步驟 3：建立 `docker-compose.yml`**

```yaml
services:
  traefik:
    image: traefik:v3.6  # v3.1's Docker provider fails against Docker Engine 29.x (upstream issue traefik/traefik#12253); fixed in v3.6.1+
    command:
      - --api.insecure=true
      - --providers.docker=true
      - --providers.docker.exposedbydefault=false
      - --entrypoints.web.address=:80
    ports:
      - "80:80"
      - "8080:8080"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro

  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: ${POSTGRES_USER}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: ${POSTGRES_DB}
    ports:
      - "5433:5432"  # host 5432 may already be taken by an unrelated local Postgres; container-internal port stays 5432
    volumes:
      - postgres_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${POSTGRES_USER}"]
      interval: 5s
      timeout: 5s
      retries: 10

  keycloak:
    image: quay.io/keycloak/keycloak:25.0
    command: start-dev --import-realm
    environment:
      KEYCLOAK_ADMIN: admin
      KEYCLOAK_ADMIN_PASSWORD: ${KEYCLOAK_ADMIN_PASSWORD}
      KC_HOSTNAME: auth.drm.localhost
      KC_HOSTNAME_STRICT: "false"
      KC_HTTP_ENABLED: "true"
    volumes:
      - ./keycloak/realm-export.json:/opt/keycloak/data/import/realm-export.json:ro
    labels:
      - traefik.enable=true
      - traefik.http.routers.keycloak.rule=Host(`auth.drm.localhost`)
      - traefik.http.services.keycloak.loadbalancer.server.port=8080

  api:
    build:
      context: .
      dockerfile: apps/api/Dockerfile
    environment:
      DATABASE_URL: postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB}
      KEYCLOAK_ISSUER: http://auth.drm.localhost/realms/drm
      WEB_ORIGIN: http://app.drm.localhost
      PORT: 3000
    depends_on:
      postgres:
        condition: service_healthy
    labels:
      - traefik.enable=true
      - traefik.http.routers.api.rule=Host(`api.drm.localhost`)
      - traefik.http.services.api.loadbalancer.server.port=3000

  web:
    build: ./apps/web
    labels:
      - traefik.enable=true
      - traefik.http.routers.web.rule=Host(`app.drm.localhost`)
      - traefik.http.services.web.loadbalancer.server.port=80

volumes:
  postgres_data:
```

- [ ] **步驟 4：從範例建立 `.env`**

執行：`cp .env.example .env`

- [ ] **步驟 5：建立 `scripts/smoke-test.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail

check() {
  local url=$1
  local code
  code=$(curl -s -o /dev/null -w '%{http_code}' "$url")
  if [ "$code" != "200" ]; then
    echo "FAIL: $url returned $code"
    exit 1
  fi
  echo "OK: $url"
}

check "http://api.drm.localhost/health"
check "http://auth.drm.localhost/realms/drm/.well-known/openid-configuration"
check "http://app.drm.localhost/"

echo "Smoke test passed."
```

執行：`chmod +x scripts/smoke-test.sh`

- [ ] **步驟 6：啟動整套堆疊並執行 smoke test**

執行：`docker compose up -d --build`
等待 Postgres 與 Keycloak 回報 healthy（`docker compose ps`），接著：
執行：`./scripts/smoke-test.sh`
預期：
```
OK: http://api.drm.localhost/health
OK: http://auth.drm.localhost/realms/drm/.well-known/openid-configuration
OK: http://app.drm.localhost/
Smoke test passed.
```

- [ ] **步驟 7：驗證 realm 匯入結果**

執行：`curl -s http://auth.drm.localhost/realms/drm/.well-known/openid-configuration | grep -o '"issuer":"[^"]*"'`
預期：`"issuer":"http://auth.drm.localhost/realms/drm"`

- [ ] **步驟 8：提交（Commit）**

```bash
git add docker-compose.yml keycloak/realm-export.json scripts/smoke-test.sh apps/web/Dockerfile .gitignore
git commit -m "feat: add docker-compose infra (postgres, keycloak, traefik, api, web placeholder)"
```

---

### 任務 5：以 Keycloak 驗證身份的 `/whoami` 端點

**檔案：**
- 新增：`apps/api/src/auth/jwt.strategy.ts`
- 新增：`apps/api/src/auth/auth.module.ts`
- 新增：`apps/api/src/users/users.service.ts`
- 新增：`apps/api/src/users/users.controller.ts`
- 新增：`apps/api/src/users/users.module.ts`
- 修改：`apps/api/src/app.module.ts`
- 測試：`apps/api/test/whoami.e2e-spec.ts`
- 新增：`apps/api/test/jest-e2e.json`

**介面：**
- 依賴：`PrismaService`（任務 3）、執行中且含測試使用者 `testuser`/`testpass` 的 Keycloak realm `drm`（任務 4）。
- 產出：`GET /whoami`（以 Bearer token 保護）→ `{ id: string, email: string, displayName: string, roles: string[] }`。`UsersService.upsertFromToken(payload: { sub: string; email: string; name: string }): Promise<User>`。

- [ ] **步驟 1：建立 `JwtStrategy`**

`apps/api/src/auth/jwt.strategy.ts`：

```ts
import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import * as jwksRsa from 'jwks-rsa';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor() {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      secretOrKeyProvider: jwksRsa.passportJwtSecret({
        cache: true,
        rateLimit: true,
        jwksRequestsPerMinute: 5,
        jwksUri: `${process.env.KEYCLOAK_ISSUER}/protocol/openid-connect/certs`,
      }),
      issuer: process.env.KEYCLOAK_ISSUER,
      algorithms: ['RS256'],
    });
  }

  async validate(payload: any) {
    return {
      sub: payload.sub,
      email: payload.email,
      name: payload.name ?? payload.preferred_username,
      roles: payload.realm_access?.roles ?? [],
    };
  }
}
```

- [ ] **步驟 2：建立 `AuthModule`**

`apps/api/src/auth/auth.module.ts`：

```ts
import { Module } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { JwtStrategy } from './jwt.strategy';

@Module({
  imports: [PassportModule],
  providers: [JwtStrategy],
})
export class AuthModule {}
```

- [ ] **步驟 3：建立 `UsersService`**

`apps/api/src/users/users.service.ts`：

```ts
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

interface TokenPayload {
  sub: string;
  email: string;
  name: string;
}

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async upsertFromToken(payload: TokenPayload) {
    return this.prisma.user.upsert({
      where: { keycloakSub: payload.sub },
      update: { email: payload.email, displayName: payload.name },
      create: {
        keycloakSub: payload.sub,
        email: payload.email,
        displayName: payload.name,
      },
    });
  }
}
```

- [ ] **步驟 4：建立 `UsersController`**

`apps/api/src/users/users.controller.ts`：

```ts
import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Request } from 'express';
import { UsersService } from './users.service';

interface AuthenticatedRequest extends Request {
  user: { sub: string; email: string; name: string; roles: string[] };
}

@Controller()
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @UseGuards(AuthGuard('jwt'))
  @Get('whoami')
  async whoami(@Req() req: AuthenticatedRequest) {
    const { sub, email, name, roles } = req.user;
    const user = await this.usersService.upsertFromToken({ sub, email, name });
    return {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      roles,
    };
  }
}
```

- [ ] **步驟 5：建立 `UsersModule`**

`apps/api/src/users/users.module.ts`：

```ts
import { Module } from '@nestjs/common';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

@Module({
  controllers: [UsersController],
  providers: [UsersService],
})
export class UsersModule {}
```

- [ ] **步驟 6：將模組接入 `AppModule`**

`apps/api/src/app.module.ts`：

```ts
import { Module } from '@nestjs/common';
import { HealthController } from './health/health.controller';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';

@Module({
  imports: [PrismaModule, AuthModule, UsersModule],
  controllers: [HealthController],
})
export class AppModule {}
```

- [ ] **步驟 7：建立 `apps/api/test/jest-e2e.json`**

```json
{
  "moduleFileExtensions": ["js", "json", "ts"],
  "rootDir": "..",
  "testEnvironment": "node",
  "testRegex": ".e2e-spec.ts$",
  "transform": { "^.+\\.(t|j)s$": "ts-jest" }
}
```

- [ ] **步驟 8：撰寫會失敗的 e2e 測試**

`apps/api/test/whoami.e2e-spec.ts`：

```ts
import axios from 'axios';
import { PrismaClient } from '@prisma/client';

const KEYCLOAK_TOKEN_URL = 'http://auth.drm.localhost/realms/drm/protocol/openid-connect/token';
const API_BASE_URL = 'http://api.drm.localhost';

async function getTestUserToken(): Promise<string> {
  const response = await axios.post(
    KEYCLOAK_TOKEN_URL,
    new URLSearchParams({
      grant_type: 'password',
      client_id: 'drm-web',
      username: 'testuser',
      password: 'testpass',
    }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
  );
  return response.data.access_token;
}

describe('GET /whoami (e2e)', () => {
  const prisma = new PrismaClient({
    datasources: { db: { url: 'postgresql://drm:drm_dev_password@localhost:5433/drm' } },
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('returns the authenticated user and persists it', async () => {
    const token = await getTestUserToken();

    const res = await axios.get(`${API_BASE_URL}/whoami`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);
    expect(res.data.email).toBe('testuser@example.com');
    expect(res.data.roles).toContain('employee');

    const dbUser = await prisma.user.findUnique({ where: { email: 'testuser@example.com' } });
    expect(dbUser).not.toBeNull();
    expect(dbUser?.keycloakSub).toBeDefined();
  });

  it('rejects requests without a token', async () => {
    await expect(axios.get(`${API_BASE_URL}/whoami`)).rejects.toMatchObject({
      response: { status: 401 },
    });
  });
});
```

- [ ] **步驟 9：執行測試以確認失敗**

前置條件：任務 4 的堆疊必須正在執行中（`docker compose ps` 顯示 `api`、`keycloak`、`postgres` 皆為 up），且需以本任務的新程式碼重新建置——請先執行 `docker compose up -d --build api`。

執行：`cd apps/api && pnpm test:e2e`
預期：失敗（FAIL）——`/whoami` 回傳 404（因為執行中的容器尚不存在此路由，畢竟它是在本任務程式碼寫成之前建置的）。

- [ ] **步驟 10：以新程式碼重新建置 API 容器並重新執行**

執行：`docker compose up -d --build api`
執行：`cd apps/api && pnpm test:e2e`
預期：通過（PASS，共 2 項測試）

- [ ] **步驟 11：提交（Commit）**

```bash
git add apps/api
git commit -m "feat(api): add Keycloak JWT auth guard and /whoami endpoint"
```

---

### 任務 6：具備 Keycloak 登入功能的 React web 應用程式

**檔案：**
- 新增：`apps/web/package.json`
- 新增：`apps/web/tsconfig.json`
- 新增：`apps/web/vite.config.ts`
- 新增：`apps/web/vite-env.d.ts`
- 新增：`apps/web/index.html`
- 新增：`apps/web/test/setup.ts`
- 新增：`apps/web/src/main.tsx`
- 新增：`apps/web/src/App.tsx`
- 新增：`apps/web/src/Home.tsx`
- 新增：`apps/web/src/auth/authConfig.ts`
- 測試：`apps/web/test/Home.test.tsx`
- 修改：`apps/web/Dockerfile`（取代任務 4 的佔位版本）

**介面：**
- 依賴：任務 5 的 `GET /whoami` 契約（`{ id, email, displayName, roles }`）、任務 4 的 Keycloak realm/client。
- 產出：`Home` 元件（props：`{ accessToken: string }`），負責渲染 whoami 的個人資料；`App` 元件透過 `react-oidc-context` 處理登入/登出。

- [ ] **步驟 1：建立 `apps/web/package.json`**

```json
{
  "name": "web",
  "version": "0.1.0",
  "private": true,
  "packageManager": "pnpm@9.7.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "preview": "vite preview",
    "test": "vitest run"
  },
  "dependencies": {
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "react-oidc-context": "^3.1.0"
  },
  "devDependencies": {
    "@testing-library/jest-dom": "^6.5.0",
    "@testing-library/react": "^16.0.1",
    "@types/react": "^18.3.5",
    "@types/react-dom": "^18.3.0",
    "@vitejs/plugin-react": "^4.3.1",
    "jsdom": "^25.0.0",
    "typescript": "^5.5.4",
    "vite": "^5.4.3",
    "vitest": "^2.0.5"
  }
}
```

- [ ] **步驟 2：建立 `apps/web/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "useDefineForClassFields": true,
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "jsx": "react-jsx",
    "strict": true,
    "types": ["vitest/globals", "@testing-library/jest-dom"]
  },
  "include": ["src", "test", "vite-env.d.ts"]
}
```

- [ ] **步驟 3：建立 `apps/web/vite.config.ts`**

```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: './test/setup.ts',
  },
});
```

- [ ] **步驟 4：建立 `apps/web/vite-env.d.ts`**

```ts
/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_KEYCLOAK_ISSUER: string;
  readonly VITE_KEYCLOAK_CLIENT_ID: string;
  readonly VITE_API_BASE_URL: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
```

- [ ] **步驟 5：建立 `apps/web/index.html`**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>DRM</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **步驟 6：建立 `apps/web/test/setup.ts`**

```ts
import '@testing-library/jest-dom';
```

- [ ] **步驟 7：安裝相依套件**

執行：`cd apps/web && pnpm install`
預期：順利完成、沒有錯誤。

- [ ] **步驟 8：為 `Home` 撰寫會失敗的測試**

`apps/web/test/Home.test.tsx`：

```tsx
import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Home } from '../src/Home';

describe('Home', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  it('renders the whoami response once loaded', async () => {
    (fetch as any).mockResolvedValue({
      ok: true,
      json: async () => ({
        id: '1',
        email: 'testuser@example.com',
        displayName: 'Test User',
        roles: ['employee'],
      }),
    });

    render(<Home accessToken="fake-token" />);

    await waitFor(() => screen.getByTestId('whoami'));
    expect(screen.getByText('Email: testuser@example.com')).toBeInTheDocument();
  });

  it('renders an error when the request fails', async () => {
    (fetch as any).mockResolvedValue({ ok: false, status: 401 });

    render(<Home accessToken="fake-token" />);

    await waitFor(() => screen.getByTestId('error'));
  });
});
```

- [ ] **步驟 9：執行測試以確認失敗**

執行：`cd apps/web && pnpm test`
預期：失敗（FAIL）——`Cannot find module '../src/Home'`

- [ ] **步驟 10：實作 `Home`**

`apps/web/src/Home.tsx`：

```tsx
import { useEffect, useState } from 'react';

interface WhoAmI {
  id: string;
  email: string;
  displayName: string;
  roles: string[];
}

export function Home({ accessToken }: { accessToken: string }) {
  const [data, setData] = useState<WhoAmI | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!accessToken) return;
    fetch(`${import.meta.env.VITE_API_BASE_URL}/whoami`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
      .then((res) => {
        if (!res.ok) throw new Error(`Request failed: ${res.status}`);
        return res.json();
      })
      .then(setData)
      .catch((err) => setError(err.message));
  }, [accessToken]);

  if (error) return <p data-testid="error">{error}</p>;
  if (!data) return <p data-testid="loading">Loading profile...</p>;

  return (
    <div data-testid="whoami">
      <p>Email: {data.email}</p>
      <p>Name: {data.displayName}</p>
      <p>Roles: {data.roles.join(', ')}</p>
    </div>
  );
}
```

- [ ] **步驟 11：執行測試以確認通過**

執行：`cd apps/web && pnpm test`
預期：通過（PASS，共 2 項測試）

- [ ] **步驟 12：建立 `authConfig` 與 `App`**

`apps/web/src/auth/authConfig.ts`：

```ts
import type { AuthProviderProps } from 'react-oidc-context';

export const oidcConfig: AuthProviderProps = {
  authority: import.meta.env.VITE_KEYCLOAK_ISSUER,
  client_id: import.meta.env.VITE_KEYCLOAK_CLIENT_ID,
  redirect_uri: window.location.origin,
  scope: 'openid profile email',
};
```

`apps/web/src/App.tsx`：

```tsx
import { useAuth } from 'react-oidc-context';
import { Home } from './Home';

export default function App() {
  const auth = useAuth();

  if (auth.isLoading) return <p>Loading...</p>;
  if (auth.error) return <p>Auth error: {auth.error.message}</p>;

  if (!auth.isAuthenticated) {
    return <button onClick={() => auth.signinRedirect()}>Log in</button>;
  }

  return (
    <div>
      <button onClick={() => auth.signoutRedirect()}>Log out</button>
      <Home accessToken={auth.user?.access_token ?? ''} />
    </div>
  );
}
```

`apps/web/src/main.tsx`：

```tsx
import React from 'react';
import ReactDOM from 'react-dom/client';
import { AuthProvider } from 'react-oidc-context';
import App from './App';
import { oidcConfig } from './auth/authConfig';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AuthProvider {...oidcConfig}>
      <App />
    </AuthProvider>
  </React.StrictMode>,
);
```

- [ ] **步驟 13：驗證應用程式能建置成功**

執行：`cd apps/web && pnpm build`
預期：順利完成並產生 `dist/` 目錄，沒有 TypeScript 錯誤。

- [ ] **步驟 14：取代佔位版本的 `apps/web/Dockerfile`**

與 `apps/api/Dockerfile`（任務 2）相同，lockfile 位於 repo 根目錄，因此建置時必須以 **repo 根目錄作為 build context**，而非 `./apps/web`。

```dockerfile
FROM node:20-alpine AS build
WORKDIR /repo
RUN corepack enable
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY apps/web/package.json apps/web/package.json
RUN pnpm install --frozen-lockfile
COPY apps/web ./apps/web
ARG VITE_KEYCLOAK_ISSUER
ARG VITE_KEYCLOAK_CLIENT_ID
ARG VITE_API_BASE_URL
ENV VITE_KEYCLOAK_ISSUER=$VITE_KEYCLOAK_ISSUER
ENV VITE_KEYCLOAK_CLIENT_ID=$VITE_KEYCLOAK_CLIENT_ID
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL
RUN pnpm --filter web build

FROM nginx:1.27-alpine
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
EXPOSE 80
```

- [ ] **步驟 14a：驗證映像檔確實能建置成功**

執行（於 repo 根目錄）：`docker build -f apps/web/Dockerfile -t drm-web-test --build-arg VITE_KEYCLOAK_ISSUER=http://auth.drm.localhost/realms/drm --build-arg VITE_KEYCLOAK_CLIENT_ID=drm-web --build-arg VITE_API_BASE_URL=http://api.drm.localhost .`
預期：建置成功（exit 0），最終產生標記為 `drm-web-test` 的映像檔。

- [ ] **步驟 15：將 build args 接入 `docker-compose.yml`**

修改 `docker-compose.yml` 中的 `web` service：

```yaml
  web:
    build:
      context: .
      dockerfile: apps/web/Dockerfile
      args:
        VITE_KEYCLOAK_ISSUER: http://auth.drm.localhost/realms/drm
        VITE_KEYCLOAK_CLIENT_ID: drm-web
        VITE_API_BASE_URL: http://api.drm.localhost
    labels:
      - traefik.enable=true
      - traefik.http.routers.web.rule=Host(`app.drm.localhost`)
      - traefik.http.services.web.loadbalancer.server.port=80
```

- [ ] **步驟 16：重新建置並執行 smoke test**

執行：`docker compose up -d --build web`
執行：`./scripts/smoke-test.sh`
預期：三項檢查皆為 `OK`，並顯示 `Smoke test passed.`

- [ ] **步驟 17：提交（Commit）**

```bash
git add apps/web docker-compose.yml
git commit -m "feat(web): add React app with Keycloak login and whoami view"
```

---

### 任務 7：端對端手動驗證

**檔案：**
- 新增：`docs/superpowers/plans/2026-07-31-phase1-verification.md`

**介面：**
- 依賴：任務 1 至 6 建立的完整堆疊。
- 產出：一份書面、可重複執行的手動驗證檢查清單，用以確認瀏覽器登入往返流程正常運作（目前尚無法完全自動化——依設計規格，Playwright E2E 排定於後續階段進行）。

- [ ] **步驟 1：從頭啟動完整堆疊**

執行：`docker compose down -v && docker compose up -d --build`
等待 `postgres` 與 `keycloak` 回報 healthy：`docker compose ps`

- [ ] **步驟 2：執行自動化 smoke test**

執行：`./scripts/smoke-test.sh`
預期：`Smoke test passed.`

- [ ] **步驟 3：執行所有自動化測試**

執行：`pnpm --filter api test`
預期：通過（PASS，包含 health 與 user-persistence 測試規格）

執行：`pnpm --filter api test:e2e`
預期：通過（PASS，whoami e2e 測試規格——需要步驟 1 啟動的 compose 堆疊正在執行）

執行：`pnpm --filter web test`
預期：通過（PASS，Home 元件測試）

- [ ] **步驟 4：撰寫手動瀏覽器驗證檢查清單**

`docs/superpowers/plans/2026-07-31-phase1-verification.md`：

```markdown
# Phase 1 Manual Verification Checklist

1. Open http://app.drm.localhost in a browser.
2. Click "Log in" — expect a redirect to http://auth.drm.localhost.
3. Log in with `testuser` / `testpass`.
4. Expect a redirect back to http://app.drm.localhost showing:
   - Email: testuser@example.com
   - Name: Test User
   - Roles: employee
5. Click "Log out" — expect the "Log in" button to reappear.
6. Confirm a row exists in Postgres: `docker compose exec postgres psql -U drm -d drm -c "select email, keycloak_sub from users;"` should list `testuser@example.com`.
```

- [ ] **步驟 5：執行手動驗證**

依照上述檢查清單，在實際瀏覽器中操作。確認每一個步驟都符合預期結果。

- [ ] **步驟 6：提交（Commit）**

```bash
git add docs/superpowers/plans/2026-07-31-phase1-verification.md
git commit -m "docs: add Phase 1 manual verification checklist"
```

---

## 自我審查備註

- **規格涵蓋範圍：** 本計畫涵蓋設計規格中的「身份驗證」（Keycloak、Google/MS OIDC broker 就緒性）與基礎設施建置。文件／ACL／版本控制／加密／浮水印／到期機制／稽核明確不在第一階段範圍內，將由後續階段（2-6）涵蓋，此點已與使用者達成共識。
- **佔位內容檢查：** 沒有任何 TBD/TODO 標記；唯一刻意保留的佔位內容（任務 4 中 `apps/web` 的簡易 Dockerfile）已明確建立，並於任務 6 中明確以真實檔案內容取代。
- **型別一致性：** `UsersService.upsertFromToken` 的簽章（`{ sub, email, name }` → `Promise<User>`）於任務 5 中定義一次，並由 `UsersController` 一致地使用。`/whoami` 的回應結構（`{ id, email, displayName, roles }`）於任務 5 中定義，並由任務 6 的 `Home` 以相同方式使用。
- **範圍：** 單一且完整的交付內容——身份驗證＋基礎設施建置——沒有摻雜任何無關的工作。
