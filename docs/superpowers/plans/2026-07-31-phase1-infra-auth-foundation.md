# Phase 1: Infrastructure & Auth Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the monorepo, local Docker Compose infrastructure, and an authenticated round-trip (React SPA → Keycloak login → NestJS API `/whoami` → Postgres) so every later phase has a working base to build on.

**Architecture:** A pnpm monorepo with `apps/api` (NestJS + Prisma + Postgres) and `apps/web` (React + Vite), fronted by Traefik for local routing (`app.drm.localhost`, `api.drm.localhost`, `auth.drm.localhost`). Keycloak provides authentication; the API validates Keycloak-issued JWTs via JWKS and upserts a local `User` row on first authenticated request.

**Tech Stack:** Node.js 20, pnpm, NestJS 10, Prisma 5, PostgreSQL 16, React 18, Vite 5, react-oidc-context, passport-jwt + jwks-rsa, Keycloak 25, Traefik v3.1, Jest + Testcontainers (API), Vitest + React Testing Library (web).

## Global Constraints

- Node.js 20 LTS for all Node services; pnpm as the package manager (`packageManager: pnpm@9.7.0` pinned in every `package.json`).
- TypeScript strict mode everywhere.
- Backend: NestJS 10, Prisma 5 as the ORM, PostgreSQL 16.
- Frontend: React 18 + Vite 5 + TypeScript. Use `react-oidc-context` (generic OIDC), not a Keycloak-specific adapter, so swapping identity providers later stays cheap.
- Backend JWT validation uses `passport-jwt` + `jwks-rsa` against the Keycloak realm's JWKS endpoint — no Keycloak-specific Nest library.
- Test runners: Jest for `apps/api` (unit + e2e), Vitest + React Testing Library for `apps/web`.
- Integration tests: `@testcontainers/postgresql` for ephemeral Postgres in unit-adjacent tests; auth e2e tests run against the already-running `docker compose` stack (not spun up per-test).
- Local routing via Traefik v3.1 under `*.drm.localhost` — no `/etc/hosts` edits needed (`.localhost` resolves to loopback by default in modern OS/browsers).
- Keycloak realm name: `drm`. SPA client id: `drm-web` (public client, PKCE, direct access grants enabled for test token retrieval). Realm roles: `admin`, `deptmanager`, `employee`. Seeded test user: `testuser` / `testpass` with role `employee`.
- **Phase 1 scope boundary:** only Postgres, Keycloak, Traefik, `api`, `web` run in this phase. MinIO, KES, OpenBao, Redis, Gotenberg, and ClamAV are introduced in Phase 2+ when document storage and background jobs actually exercise them.

---

### Task 1: Monorepo scaffold

**Files:**
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `.gitignore`
- Create: `.env.example`

**Interfaces:**
- Produces: pnpm workspace rooted at repo root, with `apps/*` as workspace packages. Root scripts `dev:api`, `dev:web`, `test:api`, `test:web` delegate to the corresponding workspace package.

- [ ] **Step 1: Create root `package.json`**

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

- [ ] **Step 2: Create `pnpm-workspace.yaml`**

```yaml
packages:
  - "apps/*"
```

- [ ] **Step 3: Create `.gitignore`**

```
node_modules/
dist/
.env
apps/*/node_modules
apps/api/generated
apps/api/prisma/migrations/.temp
```

- [ ] **Step 4: Create `.env.example`**

```
POSTGRES_USER=drm
POSTGRES_PASSWORD=drm_dev_password
POSTGRES_DB=drm
KEYCLOAK_ADMIN_PASSWORD=admin_dev_password
```

- [ ] **Step 5: Verify workspace installs cleanly**

Run: `pnpm install`
Expected: completes with no errors (no workspace packages exist yet, so this just creates the root lockfile).

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-workspace.yaml .gitignore .env.example
git commit -m "chore: scaffold pnpm monorepo"
```

---

### Task 2: NestJS API skeleton with health endpoint

**Files:**
- Create: `apps/api/package.json`
- Create: `apps/api/tsconfig.json`
- Create: `apps/api/nest-cli.json`
- Create: `apps/api/src/main.ts`
- Create: `apps/api/src/app.module.ts`
- Create: `apps/api/src/health/health.controller.ts`
- Test: `apps/api/src/health/health.controller.spec.ts`
- Create: `apps/api/Dockerfile`

**Interfaces:**
- Consumes: nothing (first app-level task).
- Produces: `HealthController.check(): { status: 'ok' }`, mounted at `GET /health`. `AppModule` importable by later tasks to register additional modules.

- [ ] **Step 1: Create `apps/api/package.json`**

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

- [ ] **Step 2: Create `apps/api/tsconfig.json`**

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

- [ ] **Step 3: Create `apps/api/nest-cli.json`**

```json
{
  "collection": "@nestjs/schematics",
  "sourceRoot": "src"
}
```

- [ ] **Step 4: Install dependencies**

Run: `cd apps/api && pnpm install`
Expected: completes with no errors.

- [ ] **Step 5: Write the failing test**

`apps/api/src/health/health.controller.spec.ts`:

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

- [ ] **Step 6: Run test to verify it fails**

Run: `cd apps/api && pnpm test`
Expected: FAIL — `Cannot find module './health.controller'`

- [ ] **Step 7: Implement `HealthController`**

`apps/api/src/health/health.controller.ts`:

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

- [ ] **Step 8: Run test to verify it passes**

Run: `cd apps/api && pnpm test`
Expected: PASS

- [ ] **Step 9: Create `AppModule` and `main.ts`**

`apps/api/src/app.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { HealthController } from './health/health.controller';

@Module({
  imports: [],
  controllers: [HealthController],
})
export class AppModule {}
```

`apps/api/src/main.ts`:

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

- [ ] **Step 10: Verify the app boots**

Run: `cd apps/api && pnpm start`
Expected: log line `Nest application successfully started`. In another terminal: `curl http://localhost:3000/health` returns `{"status":"ok"}`. Stop the process (Ctrl+C) after verifying.

- [ ] **Step 11: Create `apps/api/Dockerfile`**

The workspace lockfile lives at the repo root (Task 1), not per-app, so this Dockerfile is built with the **repo root as build context** (`docker build -f apps/api/Dockerfile .`), not `./apps/api`. Task 4's `docker-compose.yml` sets `context: .` / `dockerfile: apps/api/Dockerfile` accordingly.

```dockerfile
FROM node:20-alpine AS build
WORKDIR /repo
RUN corepack enable
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY apps/api/package.json apps/api/package.json
RUN pnpm install --frozen-lockfile
COPY apps/api ./apps/api
RUN pnpm --filter api exec prisma generate || true
RUN pnpm --filter api run build

FROM node:20-alpine
WORKDIR /repo
RUN corepack enable
ENV NODE_ENV=production
COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/apps/api/node_modules ./apps/api/node_modules
COPY --from=build /repo/apps/api/dist ./apps/api/dist
COPY --from=build /repo/apps/api/package.json ./apps/api/package.json
WORKDIR /repo/apps/api
EXPOSE 3000
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/main.js"]
```

(The `prisma generate || true` tolerates there being no `prisma/schema.prisma` yet — Task 3 adds it. The `migrate deploy` in `CMD` applies Task 3's migrations against the real Postgres at container startup.)

- [ ] **Step 11a: Verify the image actually builds**

Run (from repo root): `docker build -f apps/api/Dockerfile -t drm-api-test .`
Expected: build succeeds (exit 0), ending with an image tagged `drm-api-test`.

- [ ] **Step 12: Commit**

```bash
git add apps/api
git commit -m "feat(api): scaffold NestJS app with health endpoint"
```

---

### Task 3: Prisma + Postgres integration (User model)

**Files:**
- Create: `apps/api/prisma/schema.prisma`
- Create: `apps/api/src/prisma/prisma.service.ts`
- Create: `apps/api/src/prisma/prisma.module.ts`
- Modify: `apps/api/src/app.module.ts`
- Test: `apps/api/src/prisma/user-persistence.spec.ts`

**Interfaces:**
- Consumes: nothing new from Task 2 besides `AppModule`.
- Produces: `PrismaModule` (global, exports `PrismaService`). `User` model: `{ id: string, keycloakSub: string, email: string, displayName: string, department: string | null, createdAt: Date, updatedAt: Date }`.

- [ ] **Step 1: Create `apps/api/prisma/schema.prisma`**

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

- [ ] **Step 2: Start a local Postgres for migration authoring**

Run: `docker run --rm -d --name drm-dev-postgres -e POSTGRES_USER=drm -e POSTGRES_PASSWORD=drm_dev_password -e POSTGRES_DB=drm -p 5432:5432 postgres:16-alpine`
Expected: container starts.

- [ ] **Step 3: Generate the initial migration**

Run: `cd apps/api && DATABASE_URL="postgresql://drm:drm_dev_password@localhost:5432/drm" pnpm exec prisma migrate dev --name init`
Expected: creates `apps/api/prisma/migrations/<timestamp>_init/migration.sql` and applies it; prints `Your database is now in sync with your schema.`

- [ ] **Step 4: Stop the temporary Postgres**

Run: `docker stop drm-dev-postgres`

- [ ] **Step 5: Create `PrismaService`**

`apps/api/src/prisma/prisma.service.ts`:

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

- [ ] **Step 6: Create `PrismaModule`**

`apps/api/src/prisma/prisma.module.ts`:

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

- [ ] **Step 7: Wire `PrismaModule` into `AppModule`**

`apps/api/src/app.module.ts`:

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

- [ ] **Step 8: Write the failing integration test**

`apps/api/src/prisma/user-persistence.spec.ts`:

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

- [ ] **Step 9: Run test to verify it fails**

Run: `cd apps/api && pnpm test -- user-persistence`
Expected: FAIL at this point only if `@prisma/client` hasn't been generated yet — run `pnpm exec prisma generate` first if the error is "did not initialize yet", then re-run to confirm the test itself is meaningful (it should PASS once the client is generated, since the implementation already exists from Steps 1-7; this step exists to confirm the Testcontainers wiring is correct before moving on).

- [ ] **Step 10: Generate the Prisma client and run test to verify it passes**

Run: `cd apps/api && pnpm exec prisma generate && pnpm test -- user-persistence`
Expected: PASS (2 tests)

- [ ] **Step 11: Commit**

```bash
git add apps/api
git commit -m "feat(api): add Prisma User model with Postgres integration test"
```

---

### Task 4: Docker Compose infrastructure (Postgres, Keycloak, Traefik, api, web)

**Files:**
- Create: `docker-compose.yml`
- Create: `keycloak/realm-export.json`
- Create: `scripts/smoke-test.sh`

**Interfaces:**
- Consumes: `apps/api/Dockerfile` (Task 2), `apps/web` directory (created as a stub in this task, fully built out in Task 6).
- Produces: running services reachable at `http://app.drm.localhost`, `http://api.drm.localhost`, `http://auth.drm.localhost`. Keycloak realm `drm` with client `drm-web`, roles `admin`/`deptmanager`/`employee`, seeded user `testuser`/`testpass` (role `employee`).

- [ ] **Step 1: Create a placeholder `apps/web` so Compose can build it**

Run:
```bash
mkdir -p apps/web
cat > apps/web/Dockerfile << 'EOF'
FROM nginx:1.27-alpine
RUN echo '<html><body>DRM web placeholder</body></html>' > /usr/share/nginx/html/index.html
EXPOSE 80
EOF
```
(This placeholder is replaced by the real Vite build in Task 6.)

- [ ] **Step 2: Create `keycloak/realm-export.json`**

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

- [ ] **Step 3: Create `docker-compose.yml`**

```yaml
services:
  traefik:
    image: traefik:v3.1
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
      - "5432:5432"
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

- [ ] **Step 4: Create `.env` from the example**

Run: `cp .env.example .env`

- [ ] **Step 5: Create `scripts/smoke-test.sh`**

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

Run: `chmod +x scripts/smoke-test.sh`

- [ ] **Step 6: Bring the stack up and run the smoke test**

Run: `docker compose up -d --build`
Wait for Postgres and Keycloak to report healthy (`docker compose ps`), then:
Run: `./scripts/smoke-test.sh`
Expected:
```
OK: http://api.drm.localhost/health
OK: http://auth.drm.localhost/realms/drm/.well-known/openid-configuration
OK: http://app.drm.localhost/
Smoke test passed.
```

- [ ] **Step 7: Verify the realm import**

Run: `curl -s http://auth.drm.localhost/realms/drm/.well-known/openid-configuration | grep -o '"issuer":"[^"]*"'`
Expected: `"issuer":"http://auth.drm.localhost/realms/drm"`

- [ ] **Step 8: Commit**

```bash
git add docker-compose.yml keycloak/realm-export.json scripts/smoke-test.sh apps/web/Dockerfile .gitignore
git commit -m "feat: add docker-compose infra (postgres, keycloak, traefik, api, web placeholder)"
```

---

### Task 5: Keycloak-authenticated `/whoami` endpoint

**Files:**
- Create: `apps/api/src/auth/jwt.strategy.ts`
- Create: `apps/api/src/auth/auth.module.ts`
- Create: `apps/api/src/users/users.service.ts`
- Create: `apps/api/src/users/users.controller.ts`
- Create: `apps/api/src/users/users.module.ts`
- Modify: `apps/api/src/app.module.ts`
- Test: `apps/api/test/whoami.e2e-spec.ts`
- Create: `apps/api/test/jest-e2e.json`

**Interfaces:**
- Consumes: `PrismaService` (Task 3), running Keycloak realm `drm` with test user `testuser`/`testpass` (Task 4).
- Produces: `GET /whoami` (Bearer-token protected) → `{ id: string, email: string, displayName: string, roles: string[] }`. `UsersService.upsertFromToken(payload: { sub: string; email: string; name: string }): Promise<User>`.

- [ ] **Step 1: Create `JwtStrategy`**

`apps/api/src/auth/jwt.strategy.ts`:

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

- [ ] **Step 2: Create `AuthModule`**

`apps/api/src/auth/auth.module.ts`:

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

- [ ] **Step 3: Create `UsersService`**

`apps/api/src/users/users.service.ts`:

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

- [ ] **Step 4: Create `UsersController`**

`apps/api/src/users/users.controller.ts`:

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

- [ ] **Step 5: Create `UsersModule`**

`apps/api/src/users/users.module.ts`:

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

- [ ] **Step 6: Wire modules into `AppModule`**

`apps/api/src/app.module.ts`:

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

- [ ] **Step 7: Create `apps/api/test/jest-e2e.json`**

```json
{
  "moduleFileExtensions": ["js", "json", "ts"],
  "rootDir": "..",
  "testEnvironment": "node",
  "testRegex": ".e2e-spec.ts$",
  "transform": { "^.+\\.(t|j)s$": "ts-jest" }
}
```

- [ ] **Step 8: Write the failing e2e test**

`apps/api/test/whoami.e2e-spec.ts`:

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
    datasources: { db: { url: 'postgresql://drm:drm_dev_password@localhost:5432/drm' } },
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

- [ ] **Step 9: Run test to verify it fails**

Precondition: stack from Task 4 must be running (`docker compose ps` shows `api`, `keycloak`, `postgres` up) but rebuilt with this task's new code — run `docker compose up -d --build api` first.

Run: `cd apps/api && pnpm test:e2e`
Expected: FAIL — `/whoami` returns 404 (route doesn't exist in the running container yet, since it was built before this task's code existed).

- [ ] **Step 10: Rebuild the API container with the new code and re-run**

Run: `docker compose up -d --build api`
Run: `cd apps/api && pnpm test:e2e`
Expected: PASS (2 tests)

- [ ] **Step 11: Commit**

```bash
git add apps/api
git commit -m "feat(api): add Keycloak JWT auth guard and /whoami endpoint"
```

---

### Task 6: React web app with Keycloak login

**Files:**
- Create: `apps/web/package.json`
- Create: `apps/web/tsconfig.json`
- Create: `apps/web/vite.config.ts`
- Create: `apps/web/vite-env.d.ts`
- Create: `apps/web/index.html`
- Create: `apps/web/test/setup.ts`
- Create: `apps/web/src/main.tsx`
- Create: `apps/web/src/App.tsx`
- Create: `apps/web/src/Home.tsx`
- Create: `apps/web/src/auth/authConfig.ts`
- Test: `apps/web/test/Home.test.tsx`
- Modify: `apps/web/Dockerfile` (replace placeholder from Task 4)

**Interfaces:**
- Consumes: `GET /whoami` contract from Task 5 (`{ id, email, displayName, roles }`), Keycloak realm/client from Task 4.
- Produces: `Home` component (props: `{ accessToken: string }`) rendering the whoami profile; `App` component handling login/logout via `react-oidc-context`.

- [ ] **Step 1: Create `apps/web/package.json`**

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

- [ ] **Step 2: Create `apps/web/tsconfig.json`**

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

- [ ] **Step 3: Create `apps/web/vite.config.ts`**

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

- [ ] **Step 4: Create `apps/web/vite-env.d.ts`**

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

- [ ] **Step 5: Create `apps/web/index.html`**

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

- [ ] **Step 6: Create `apps/web/test/setup.ts`**

```ts
import '@testing-library/jest-dom';
```

- [ ] **Step 7: Install dependencies**

Run: `cd apps/web && pnpm install`
Expected: completes with no errors.

- [ ] **Step 8: Write the failing test for `Home`**

`apps/web/test/Home.test.tsx`:

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

- [ ] **Step 9: Run test to verify it fails**

Run: `cd apps/web && pnpm test`
Expected: FAIL — `Cannot find module '../src/Home'`

- [ ] **Step 10: Implement `Home`**

`apps/web/src/Home.tsx`:

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

- [ ] **Step 11: Run test to verify it passes**

Run: `cd apps/web && pnpm test`
Expected: PASS (2 tests)

- [ ] **Step 12: Create `authConfig` and `App`**

`apps/web/src/auth/authConfig.ts`:

```ts
import type { AuthProviderProps } from 'react-oidc-context';

export const oidcConfig: AuthProviderProps = {
  authority: import.meta.env.VITE_KEYCLOAK_ISSUER,
  client_id: import.meta.env.VITE_KEYCLOAK_CLIENT_ID,
  redirect_uri: window.location.origin,
  scope: 'openid profile email',
};
```

`apps/web/src/App.tsx`:

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

`apps/web/src/main.tsx`:

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

- [ ] **Step 13: Verify the app builds**

Run: `cd apps/web && pnpm build`
Expected: completes with a `dist/` directory produced, no TypeScript errors.

- [ ] **Step 14: Replace the placeholder `apps/web/Dockerfile`**

Like `apps/api/Dockerfile` (Task 2), the lockfile lives at the repo root, so this builds with the **repo root as build context**, not `./apps/web`.

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

- [ ] **Step 14a: Verify the image actually builds**

Run (from repo root): `docker build -f apps/web/Dockerfile -t drm-web-test --build-arg VITE_KEYCLOAK_ISSUER=http://auth.drm.localhost/realms/drm --build-arg VITE_KEYCLOAK_CLIENT_ID=drm-web --build-arg VITE_API_BASE_URL=http://api.drm.localhost .`
Expected: build succeeds (exit 0), ending with an image tagged `drm-web-test`.

- [ ] **Step 15: Wire build args into `docker-compose.yml`**

Modify the `web` service in `docker-compose.yml`:

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

- [ ] **Step 16: Rebuild and smoke-test**

Run: `docker compose up -d --build web`
Run: `./scripts/smoke-test.sh`
Expected: all three checks `OK`, `Smoke test passed.`

- [ ] **Step 17: Commit**

```bash
git add apps/web docker-compose.yml
git commit -m "feat(web): add React app with Keycloak login and whoami view"
```

---

### Task 7: End-to-end manual verification

**Files:**
- Create: `docs/superpowers/plans/2026-07-31-phase1-verification.md`

**Interfaces:**
- Consumes: full stack from Tasks 1-6.
- Produces: a written, repeatable manual verification checklist confirming the browser login round-trip works (this cannot be fully automated yet — Playwright E2E is scoped for a later phase per the design spec).

- [ ] **Step 1: Bring the full stack up fresh**

Run: `docker compose down -v && docker compose up -d --build`
Wait for `postgres` and `keycloak` to report healthy: `docker compose ps`

- [ ] **Step 2: Run the automated smoke test**

Run: `./scripts/smoke-test.sh`
Expected: `Smoke test passed.`

- [ ] **Step 3: Run all automated tests**

Run: `pnpm --filter api test`
Expected: PASS (health + user-persistence specs)

Run: `pnpm --filter api test:e2e`
Expected: PASS (whoami e2e spec — requires the compose stack running from Step 1)

Run: `pnpm --filter web test`
Expected: PASS (Home component tests)

- [ ] **Step 4: Write the manual browser verification checklist**

`docs/superpowers/plans/2026-07-31-phase1-verification.md`:

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

- [ ] **Step 5: Perform the manual verification**

Follow the checklist above in a real browser. Confirm every step matches the expected outcome.

- [ ] **Step 6: Commit**

```bash
git add docs/superpowers/plans/2026-07-31-phase1-verification.md
git commit -m "docs: add Phase 1 manual verification checklist"
```

---

## Self-Review Notes

- **Spec coverage:** This plan covers the design spec's "身份驗證" (Keycloak, Google/MS OIDC broker readiness) and infrastructure foundation. Document/ACL/versioning/encryption/watermark/expiration/audit are explicitly out of scope for Phase 1 and are covered by later phases (2-6) as already agreed with the user.
- **Placeholder scan:** No TBD/TODO markers; the one intentional placeholder (`apps/web` stub Dockerfile in Task 4) is explicitly created and explicitly replaced in Task 6, both with real file contents.
- **Type consistency:** `UsersService.upsertFromToken` signature (`{ sub, email, name }` → `Promise<User>`) is defined once in Task 5 and used consistently by `UsersController`. The `/whoami` response shape (`{ id, email, displayName, roles }`) is defined in Task 5 and consumed identically by `Home` in Task 6.
- **Scope:** Single cohesive deliverable — auth + infra foundation — with no unrelated work folded in.
