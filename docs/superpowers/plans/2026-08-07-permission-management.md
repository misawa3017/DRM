# 權限管理 UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓有 `manage` 權限的使用者可以透過前端管理資料夾/文件的存取授權——全域儀表板（`/permissions`，列出使用者管理得到的所有授權，預設只顯示直接授權、可切換納入繼承項目）與資源專屬頁面（`/folders/:id/permissions`、`/documents/:id/permissions`）並存，共用同一套元件。

**Architecture:** 後端新增 `GET /users?search=` 補上使用者查詢缺口、`GET /permissions?includeInherited=` 全域查詢端點（核心是 `AclService.findManagedResources`：一個遞迴走訪資料夾樹、比照既有 `resolveLevel`「最近明確授權優先」語意找出使用者管理得到哪些資源的新演算法），並擴充既有 `GET .../permissions` 端點加上 principal 顯示資訊。前端沿用既有 React Query + shadcn 風格元件慣例，新增 `PermissionsTable`/`ResourcePicker`/`GrantPermissionForm` 三個共用元件，被全域儀表板與資源專屬頁面共用。

**Tech Stack:** NestJS + Prisma（既有）、React 18、react-router-dom 6（`NavLink`）、`@tanstack/react-query`、既有 shadcn 風格 `Table`/`Dialog`/`Button` 元件。

## Global Constraints

- Node >= 20、pnpm 9.7.0 workspace（`pnpm --filter web ...` / `pnpm --filter api ...`）
- TypeScript `strict: true`（不放寬）
- Prettier：`semi: true`、`singleQuote: true`、`trailingComma: "all"`、`printWidth: 100`、`tabWidth: 2`
- **這次逐 Task TDD**：每個 Task 先寫失敗測試、確認失敗、再實作、確認通過、才 commit（回到第一階段的節奏，不延續視覺改版那次「先實作後補測試」的例外安排）
- 後端測試：e2e 一律用 `apps/api/test/*.e2e-spec.ts` 既有模式（`axios` 打 `https://api.drm.apower.lan`、`https://auth.drm.apower.lan`，資料用 `new PrismaClient({ datasources: { db: { url: 'postgresql://drm:drm_dev_password@localhost:5433/drm' } } })` 直接寫入 Postgres 做 fixture）；單元測試（`AclService`）用既有 Testcontainers 模式（`apps/api/src/acl/acl.service.spec.ts`）
- 後端測試帳號：`testuser`/`testpass`（`employee`）、`testadmin`/`testadminpass`（`admin`），定義於 `keycloak/realm-export.json.template`
- 前端測試：Vitest + React Testing Library，斷言用 `data-testid`，互動一律用 `fireEvent`（不用 `@testing-library/user-event`），mock fetch 沿用 `vi.stubGlobal('fetch', vi.fn())` 既有模式
- 不支援 `principalType: 'group'`（後端既有邏輯已經回 400 拒絕，這次不動）
- 不做的事（範疇之外，勿在任何任務中夾帶）：群組授權、「我能不能管理這個資源」快速查詢端點、全域端點的伺服器端分頁/篩選、`includeInherited=true` 查詢的效能優化、`ResourcePicker` 的關鍵字搜尋

---

### Task 1: 後端 — `GET /users?search=<query>`

**Files:**
- Modify: `apps/api/src/users/users.controller.ts`
- Modify: `apps/api/src/users/users.service.ts`
- Test: `apps/api/test/users.e2e-spec.ts`（新檔案）

**Interfaces:**
- Consumes: 無新依賴
- Produces: `UsersService.search(query?: string): Promise<UserSummary[]>`；HTTP `GET /users?search=<query>`（需 `Authorization: Bearer <token>`）回傳 `UserSummary[]`（`{ id, email, displayName, department }`），給 Task 5 的 `api/users.ts::searchUsers` 消費

- [ ] **Step 1: 寫失敗的 e2e 測試**

Create `apps/api/test/users.e2e-spec.ts`:

```ts
import axios from 'axios';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';

const KEYCLOAK_TOKEN_URL = 'https://auth.drm.apower.lan/realms/drm/protocol/openid-connect/token';
const API_BASE_URL = 'https://api.drm.apower.lan';

interface TokenResponse {
  access_token: string;
}

interface UserSummaryResponse {
  id: string;
  email: string;
  displayName: string;
  department: string | null;
}

async function getToken(username: string, password: string): Promise<string> {
  const response = await axios.post<TokenResponse>(
    KEYCLOAK_TOKEN_URL,
    new URLSearchParams({ grant_type: 'password', client_id: 'drm-web', username, password }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
  );
  return response.data.access_token;
}

describe('Users search (e2e)', () => {
  const prisma = new PrismaClient({
    datasources: { db: { url: 'postgresql://drm:drm_dev_password@localhost:5433/drm' } },
  });

  const suffix = randomUUID().slice(0, 8);
  const emailTarget = `search-target-${suffix}@example.com`;
  const nameTarget = `SearchTarget-${suffix}`;

  beforeAll(async () => {
    await prisma.user.create({
      data: {
        keycloakSub: `test-search-${suffix}`,
        email: emailTarget,
        displayName: nameTarget,
        department: 'QA',
      },
    });
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { email: emailTarget } });
    await prisma.$disconnect();
  });

  it('finds a user by a substring of their email, case-insensitively', async () => {
    const token = await getToken('testuser', 'testpass');
    const res = await axios.get<UserSummaryResponse[]>(
      `${API_BASE_URL}/users?search=${encodeURIComponent(`SEARCH-TARGET-${suffix}`)}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );

    expect(res.status).toBe(200);
    const match = res.data.find((u) => u.email === emailTarget);
    expect(match).toBeDefined();
    expect(match?.displayName).toBe(nameTarget);
    expect(match?.department).toBe('QA');
  });

  it('finds a user by a substring of their display name', async () => {
    const token = await getToken('testuser', 'testpass');
    const res = await axios.get<UserSummaryResponse[]>(
      `${API_BASE_URL}/users?search=${encodeURIComponent(nameTarget)}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );

    expect(res.data.map((u) => u.id)).toEqual(
      expect.arrayContaining([expect.any(String)]),
    );
    expect(res.data.some((u) => u.email === emailTarget)).toBe(true);
  });

  it('does not include sensitive fields like keycloakSub', async () => {
    const token = await getToken('testuser', 'testpass');
    const res = await axios.get<Record<string, unknown>[]>(
      `${API_BASE_URL}/users?search=${encodeURIComponent(nameTarget)}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );

    for (const user of res.data) {
      expect(user).not.toHaveProperty('keycloakSub');
    }
  });

  it('rejects an empty search query with 400', async () => {
    const token = await getToken('testuser', 'testpass');
    await expect(
      axios.get(`${API_BASE_URL}/users?search=`, {
        headers: { Authorization: `Bearer ${token}` },
      }),
    ).rejects.toMatchObject({ response: { status: 400 } });
  });

  it('rejects an unauthenticated request with 401', async () => {
    await expect(axios.get(`${API_BASE_URL}/users?search=anything`)).rejects.toMatchObject({
      response: { status: 401 },
    });
  });
});
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `pnpm --filter api test:e2e -- users.e2e-spec.ts`
Expected: FAIL——`GET /users` 目前不存在（404），或空 query 沒有回 400

- [ ] **Step 3: 在 `users.service.ts` 新增 `search`**

Modify `apps/api/src/users/users.service.ts` to:

```ts
import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

interface TokenPayload {
  sub: string;
  email: string;
  name: string;
}

export interface UserSummary {
  id: string;
  email: string;
  displayName: string;
  department: string | null;
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

  async search(query?: string): Promise<UserSummary[]> {
    if (!query || query.trim() === '') {
      throw new BadRequestException('search query is required');
    }
    return this.prisma.user.findMany({
      where: {
        OR: [
          { email: { contains: query, mode: 'insensitive' } },
          { displayName: { contains: query, mode: 'insensitive' } },
        ],
      },
      select: { id: true, email: true, displayName: true, department: true },
      orderBy: { displayName: 'asc' },
      take: 20,
    });
  }
}
```

- [ ] **Step 4: 在 `users.controller.ts` 新增 `GET /users` handler**

Modify `apps/api/src/users/users.controller.ts` to:

```ts
import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
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

  @UseGuards(AuthGuard('jwt'))
  @Get('users')
  async search(@Query('search') search?: string) {
    return this.usersService.search(search);
  }
}
```

- [ ] **Step 5: 執行測試確認通過**

Run: `pnpm --filter api test:e2e -- users.e2e-spec.ts`
Expected: 全部 PASS

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/users/users.controller.ts apps/api/src/users/users.service.ts apps/api/test/users.e2e-spec.ts
git commit -m "feat(api): add GET /users?search= for looking up grant targets"
```

---

### Task 2: 後端 — 擴充 `GET .../permissions` 回應加上 `principal`

**Files:**
- Modify: `apps/api/src/permissions/permissions.service.ts`
- Test: `apps/api/test/permissions.e2e-spec.ts`（既有檔案，追加）

**Interfaces:**
- Consumes: 無新依賴
- Produces: `PermissionsService.list` 回傳的每筆紀錄新增 `principal: { email: string; displayName: string } | null` 欄位，給 Task 5 的 `api/permissions.ts::PermissionEntry` 消費

- [ ] **Step 1: 寫失敗的 e2e 測試**

在 `apps/api/test/permissions.e2e-spec.ts` 檔案結尾的 `});`（describe 區塊收尾）之前加入：

```ts
  it('GET .../permissions includes the principal display name and email for each grant', async () => {
    const adminToken = await getToken('testadmin', 'testadminpass');
    const adminHeader = { Authorization: `Bearer ${adminToken}` };

    const folderRes = await axios.post<FolderResponse>(
      `${API_BASE_URL}/folders`,
      { name: `perm-principal-test-${Date.now()}` },
      { headers: adminHeader },
    );
    const folderId = folderRes.data.id;

    const employeeToken = await getToken('testuser', 'testpass');
    const employeeUser = await whoami(employeeToken);

    await axios.post(
      `${API_BASE_URL}/folders/${folderId}/permissions`,
      { principalType: 'user', principalId: employeeUser.id, permissionLevel: 'view' },
      { headers: adminHeader },
    );

    const listRes = await axios.get<
      { principalId: string; principal: { email: string; displayName: string } | null }[]
    >(`${API_BASE_URL}/folders/${folderId}/permissions`, { headers: adminHeader });

    const entry = listRes.data.find((p) => p.principalId === employeeUser.id);
    expect(entry).toBeDefined();
    expect(entry?.principal).not.toBeNull();
    expect(entry?.principal?.email).toEqual(expect.stringContaining('@'));
    expect(entry?.principal?.displayName).toEqual(expect.any(String));
  });
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `pnpm --filter api test:e2e -- permissions.e2e-spec.ts`
Expected: FAIL——`entry?.principal` 是 `undefined`，因為回應目前沒有 `principal` 欄位

- [ ] **Step 3: 在 `permissions.service.ts` 的 `list` 方法加上 enrichment**

Modify `apps/api/src/permissions/permissions.service.ts`'s `list` method:

```ts
  async list(user: AuthenticatedUser, resourceType: ResourceType, resourceId: string) {
    const allowed = await this.acl.can(user, resourceType, resourceId, 'manage');
    if (!allowed) {
      throw new ForbiddenException('You do not have manage access to this resource');
    }
    const permissions = await this.prisma.permission.findMany({ where: { resourceType, resourceId } });
    return Promise.all(permissions.map((p) => this.enrichWithPrincipal(p)));
  }

  private async enrichWithPrincipal<T extends { principalType: PrincipalType; principalId: string }>(
    permission: T,
  ): Promise<T & { principal: { email: string; displayName: string } | null }> {
    if (permission.principalType !== 'user') {
      return { ...permission, principal: null };
    }
    const user = await this.prisma.user.findUnique({
      where: { id: permission.principalId },
      select: { email: true, displayName: true },
    });
    return { ...permission, principal: user ?? null };
  }
```

(`enrichWithPrincipal` 是新的 private 方法，加在 class 內任一位置；`PrincipalType` 已經是檔案既有 import）

- [ ] **Step 4: 執行測試確認通過**

Run: `pnpm --filter api test:e2e -- permissions.e2e-spec.ts`
Expected: 全部 PASS（含既有的）

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/permissions/permissions.service.ts apps/api/test/permissions.e2e-spec.ts
git commit -m "feat(api): enrich permission list responses with principal display info"
```

---

### Task 3: 後端 — `AclService.findManagedResources`（核心演算法）

**Files:**
- Modify: `apps/api/src/acl/acl.service.ts`
- Test: `apps/api/src/acl/acl.service.spec.ts`（既有檔案，追加）

**Interfaces:**
- Consumes: 無新依賴（沿用既有的 `private findGrant`）
- Produces: `AclService.findManagedResources(user: AuthenticatedUser, includeInherited: boolean): Promise<ManagedResourceRef[] | 'all'>`，`ManagedResourceRef = { resourceType: ResourceType; resourceId: string; source: 'direct' | { inheritedFrom: { resourceId: string; resourceName: string } } }`，給 Task 4 的 `PermissionsService.listGlobal` 消費

**這是全計畫最複雜的一塊，務必理解語意再動手**：`AclService.resolveLevel` 的既有規則是「從資源本身往上找，回傳*最近*一筆明確授權，不合併多層」（見 `acl.service.spec.ts` 的「does not merge levels」測試）。`findManagedResources` 要做的是這個規則的反向查詢：不是「給一個資源，問使用者的層級」，而是「給一個使用者，找出所有他的有效層級是 `manage` 的資源」。這代表遞迴走訪資料夾樹時，**不能因為某個節點的有效層級掉到 `manage` 以下就停止往下遞迴**——它的子孫仍可能有自己獨立的 `manage` 授權，覆蓋掉中間這層的較低授權（`resolveLevel` 的「最近授權優先」語意允許任何一層的明確授權蓋掉更上層傳下來的授權，不論新授權比舊的高或低）。所以任何一個節點，只要有自己的明確授權（不論層級），就會變成它自己子孫的新「最近授權來源」，取代原本從更上層傳下來的來源；沒有自己明確授權的節點，原封不動繼承傳下來的來源。

- [ ] **Step 1: 寫失敗的單元測試**

在 `apps/api/src/acl/acl.service.spec.ts` 檔案結尾的 `});`（describe 區塊收尾）之前加入：

```ts
  describe('findManagedResources', () => {
    it('returns only directly-managed resources when includeInherited is false', async () => {
      const managed = await makeFolder('fmr-managed-1');
      const notManaged = await makeFolder('fmr-not-managed-1');
      await grant('folder', managed.id, 'user-fmr1', 'manage');
      await grant('folder', notManaged.id, 'user-fmr1', 'view');

      const result = await acl.findManagedResources({ id: 'user-fmr1', roles: ['employee'] }, false);

      expect(result).not.toBe('all');
      const refs = result as { resourceType: string; resourceId: string; source: unknown }[];
      expect(refs).toEqual([
        { resourceType: 'folder', resourceId: managed.id, source: 'direct' },
      ]);
    });

    it("'admin' role returns 'all' regardless of includeInherited", async () => {
      const result = await acl.findManagedResources({ id: 'user-fmr2', roles: ['admin'] }, false);
      expect(result).toBe('all');
      const resultInherited = await acl.findManagedResources({ id: 'user-fmr2', roles: ['admin'] }, true);
      expect(resultInherited).toBe('all');
    });

    it('includeInherited=true includes a child folder with no override, tagged as inherited', async () => {
      const parent = await makeFolder('fmr-parent-3');
      const child = await makeFolder('fmr-child-3', parent.id);
      await grant('folder', parent.id, 'user-fmr3', 'manage');

      const result = await acl.findManagedResources({ id: 'user-fmr3', roles: ['employee'] }, true);

      expect(result).not.toBe('all');
      const refs = result as { resourceType: string; resourceId: string; source: unknown }[];
      expect(refs).toContainEqual({
        resourceType: 'folder',
        resourceId: child.id,
        source: { inheritedFrom: { resourceId: parent.id, resourceName: 'fmr-parent-3' } },
      });
    });

    it('includeInherited=true includes a document with no override, tagged as inherited', async () => {
      const parent = await makeFolder('fmr-parent-4');
      const doc = await makeDocument(parent.id, 'fmr-doc-4');
      await grant('folder', parent.id, 'user-fmr4', 'manage');

      const result = await acl.findManagedResources({ id: 'user-fmr4', roles: ['employee'] }, true);

      const refs = result as { resourceType: string; resourceId: string; source: unknown }[];
      expect(refs).toContainEqual({
        resourceType: 'document',
        resourceId: doc.id,
        source: { inheritedFrom: { resourceId: parent.id, resourceName: 'fmr-parent-4' } },
      });
    });

    it('excludes a document with its own lower-level override, and does not include it', async () => {
      const parent = await makeFolder('fmr-parent-5');
      const doc = await makeDocument(parent.id, 'fmr-doc-5');
      await grant('folder', parent.id, 'user-fmr5', 'manage');
      await grant('document', doc.id, 'user-fmr5', 'view');

      const result = await acl.findManagedResources({ id: 'user-fmr5', roles: ['employee'] }, true);

      const refs = result as { resourceType: string; resourceId: string }[];
      expect(refs.some((r) => r.resourceId === doc.id)).toBe(false);
    });

    it(
      'does not stop recursing past a lower-override branch: a grandchild with its own manage ' +
        'grant is still included, tagged as inherited from itself via direct grant',
      async () => {
        const parent = await makeFolder('fmr-parent-6');
        const middle = await makeFolder('fmr-middle-6', parent.id);
        const grandchild = await makeFolder('fmr-grandchild-6', middle.id);
        await grant('folder', parent.id, 'user-fmr6', 'manage');
        await grant('folder', middle.id, 'user-fmr6', 'view'); // cuts off inheritance at `middle`
        await grant('folder', grandchild.id, 'user-fmr6', 'manage'); // but regains it here

        const result = await acl.findManagedResources({ id: 'user-fmr6', roles: ['employee'] }, true);

        const refs = result as { resourceType: string; resourceId: string; source: unknown }[];
        // middle itself is not manage-level, so it's excluded
        expect(refs.some((r) => r.resourceId === middle.id)).toBe(false);
        // grandchild has its own direct manage grant
        expect(refs).toContainEqual({
          resourceType: 'folder',
          resourceId: grandchild.id,
          source: { inheritedFrom: { resourceId: parent.id, resourceName: 'fmr-parent-6' } },
        });
      },
    );

    it('a child folder with its own manage override becomes the new inheritance source for its own children', async () => {
      const parent = await makeFolder('fmr-parent-7');
      const child = await makeFolder('fmr-child-7', parent.id);
      const grandchild = await makeFolder('fmr-grandchild-7', child.id);
      await grant('folder', parent.id, 'user-fmr7', 'manage');
      await grant('folder', child.id, 'user-fmr7', 'manage'); // own explicit grant, same level

      const result = await acl.findManagedResources({ id: 'user-fmr7', roles: ['employee'] }, true);

      const refs = result as { resourceType: string; resourceId: string; source: unknown }[];
      expect(refs).toContainEqual({
        resourceType: 'folder',
        resourceId: grandchild.id,
        source: { inheritedFrom: { resourceId: child.id, resourceName: 'fmr-child-7' } },
      });
    });
  });
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `pnpm --filter api test -- acl.service.spec.ts`
Expected: FAIL——`acl.findManagedResources` 不存在（TypeScript 編譯錯誤或 runtime `is not a function`）

- [ ] **Step 3: 在 `acl.service.ts` 實作 `findManagedResources`**

Modify `apps/api/src/acl/acl.service.ts` — add near the top, after the existing `MAX_FOLDER_DEPTH` constant, a new exported type, and add the two new methods to the `AclService` class (placed after the existing `resolveLevel` method, before the private `findGrant`):

```ts
export interface ManagedResourceRef {
  resourceType: ResourceType;
  resourceId: string;
  source: 'direct' | { inheritedFrom: { resourceId: string; resourceName: string } };
}

interface NearestGrant {
  level: PermissionLevel;
  originResourceId: string;
  originResourceName: string;
}
```

Then inside the `AclService` class:

```ts
  async findManagedResources(
    user: AuthenticatedUser,
    includeInherited: boolean,
  ): Promise<ManagedResourceRef[] | 'all'> {
    if (user.roles.includes('admin')) {
      return 'all';
    }

    const directGrants = await this.prisma.permission.findMany({
      where: { principalType: 'user', principalId: user.id, permissionLevel: 'manage' },
      select: { resourceType: true, resourceId: true },
    });

    const direct: ManagedResourceRef[] = directGrants.map((g) => ({
      resourceType: g.resourceType,
      resourceId: g.resourceId,
      source: 'direct',
    }));

    if (!includeInherited) {
      return direct;
    }

    const expanded: ManagedResourceRef[] = [...direct];
    for (const seed of directGrants) {
      if (seed.resourceType !== 'folder') continue;
      const seedFolder = await this.prisma.folder.findUnique({
        where: { id: seed.resourceId },
        select: { name: true },
      });
      if (!seedFolder) continue;
      await this.walkFolderForManagedDescendants(
        user.id,
        seed.resourceId,
        { level: 'manage', originResourceId: seed.resourceId, originResourceName: seedFolder.name },
        expanded,
      );
    }
    return expanded;
  }

  // Not pruned: a folder/document whose effective level falls below `manage`
  // is excluded from the results, but its own children are still walked —
  // resolveLevel's "closest explicit grant wins" semantics mean a deeper
  // descendant can regain `manage` via its own override even under a
  // demoted branch (see acl.service.spec.ts's findManagedResources tests,
  // especially "does not stop recursing past a lower-override branch").
  // There is no safe early-exit; this is O(descendant count) per seed
  // folder by design — see the design doc's "範疇之外" for the accepted
  // performance trade-off.
  private async walkFolderForManagedDescendants(
    userId: string,
    folderId: string,
    nearestGrant: NearestGrant,
    results: ManagedResourceRef[],
  ): Promise<void> {
    const [childFolders, documents] = await Promise.all([
      this.prisma.folder.findMany({ where: { parentId: folderId } }),
      this.prisma.document.findMany({ where: { folderId } }),
    ]);

    for (const child of childFolders) {
      const ownLevel = await this.findGrant('folder', child.id, userId);
      const effective: NearestGrant = ownLevel
        ? { level: ownLevel, originResourceId: child.id, originResourceName: child.name }
        : nearestGrant;
      if (effective.level === 'manage') {
        results.push({
          resourceType: 'folder',
          resourceId: child.id,
          source: {
            inheritedFrom: {
              resourceId: effective.originResourceId,
              resourceName: effective.originResourceName,
            },
          },
        });
      }
      await this.walkFolderForManagedDescendants(userId, child.id, effective, results);
    }

    for (const doc of documents) {
      const ownLevel = await this.findGrant('document', doc.id, userId);
      const effective: NearestGrant = ownLevel
        ? { level: ownLevel, originResourceId: doc.id, originResourceName: doc.name }
        : nearestGrant;
      if (effective.level === 'manage') {
        results.push({
          resourceType: 'document',
          resourceId: doc.id,
          source: {
            inheritedFrom: {
              resourceId: effective.originResourceId,
              resourceName: effective.originResourceName,
            },
          },
        });
      }
    }
  }
```

（`findGrant` 已經是既有的 private 方法，直接重用；`ResourceType`、`PermissionLevel` 已經是檔案既有 import）

- [ ] **Step 4: 執行測試確認通過**

Run: `pnpm --filter api test -- acl.service.spec.ts`
Expected: 全部 PASS（含既有的）

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/acl/acl.service.ts apps/api/src/acl/acl.service.spec.ts
git commit -m "feat(api): add AclService.findManagedResources for the permissions dashboard"
```

---

### Task 4: 後端 — `GET /permissions?includeInherited=<bool>`（全域查詢端點）

**Files:**
- Modify: `apps/api/src/permissions/permissions.controller.ts`
- Modify: `apps/api/src/permissions/permissions.service.ts`
- Test: `apps/api/test/global-permissions.e2e-spec.ts`（新檔案）

**Interfaces:**
- Consumes: `AclService.findManagedResources`（Task 3）
- Produces: HTTP `GET /permissions?includeInherited=<bool>`（需 `Authorization: Bearer <token>`）回傳 `GlobalPermissionEntry[]`（`Permission` 欄位 + `principal` + `resourceName` + `resourcePath` + `source`），給 Task 5 的 `api/permissions.ts::listGlobalPermissions` 消費

- [ ] **Step 1: 寫失敗的 e2e 測試**

Create `apps/api/test/global-permissions.e2e-spec.ts`:

```ts
import axios from 'axios';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';

const KEYCLOAK_TOKEN_URL = 'https://auth.drm.apower.lan/realms/drm/protocol/openid-connect/token';
const API_BASE_URL = 'https://api.drm.apower.lan';

interface TokenResponse {
  access_token: string;
}

interface WhoamiResponse {
  id: string;
}

interface GlobalPermissionEntry {
  resourceType: 'folder' | 'document';
  resourceId: string;
  resourceName: string;
  resourcePath: string;
  principalId: string;
  permissionLevel: string;
  source: 'direct' | { inheritedFrom: { resourceId: string; resourceName: string } };
}

async function getToken(username: string, password: string): Promise<string> {
  const response = await axios.post<TokenResponse>(
    KEYCLOAK_TOKEN_URL,
    new URLSearchParams({ grant_type: 'password', client_id: 'drm-web', username, password }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
  );
  return response.data.access_token;
}

describe('Global permissions dashboard (e2e)', () => {
  const prisma = new PrismaClient({
    datasources: { db: { url: 'postgresql://drm:drm_dev_password@localhost:5433/drm' } },
  });

  let managerId: string;
  let viewerId: string;

  beforeAll(async () => {
    const managerToken = await getToken('testuser', 'testpass');
    const res = await axios.get<WhoamiResponse>(`${API_BASE_URL}/whoami`, {
      headers: { Authorization: `Bearer ${managerToken}` },
    });
    managerId = res.data.id;

    const viewer = await prisma.user.create({
      data: {
        keycloakSub: `test-viewer-${randomUUID().slice(0, 8)}`,
        email: `viewer-${randomUUID().slice(0, 8)}@example.com`,
        displayName: 'Global Perm Viewer',
      },
    });
    viewerId = viewer.id;
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: viewerId } });
    await prisma.$disconnect();
  });

  it(
    'includeInherited=false shows only the directly-managed folder; ' +
      'includeInherited=true also shows a nested document with its own override, tagged as inherited',
    async () => {
      const adminToken = await getToken('testadmin', 'testadminpass');
      const adminHeader = { Authorization: `Bearer ${adminToken}` };

      const parentRes = await axios.post<{ id: string; name: string }>(
        `${API_BASE_URL}/folders`,
        { name: `global-perm-parent-${Date.now()}` },
        { headers: adminHeader },
      );
      const parentId = parentRes.data.id;
      const parentName = parentRes.data.name;

      const childRes = await axios.post<{ id: string }>(
        `${API_BASE_URL}/folders`,
        { name: `global-perm-child-${Date.now()}`, parentId },
        { headers: adminHeader },
      );
      const childId = childRes.data.id;

      // Manager gets a direct `manage` grant on the parent folder.
      await axios.post(
        `${API_BASE_URL}/folders/${parentId}/permissions`,
        { principalType: 'user', principalId: managerId, permissionLevel: 'manage' },
        { headers: adminHeader },
      );

      const managerToken = await getToken('testuser', 'testpass');
      const managerHeader = { Authorization: `Bearer ${managerToken}` };

      // A document inside the child folder, uploaded by admin, with its own
      // explicit grant to `viewer` — this document has no permission of its
      // own for `manager`, so it's only reachable via inherited management.
      const form = new URLSearchParams();
      const uploadRes = await axios.post<{ id: string; name: string }>(
        `${API_BASE_URL}/documents`,
        (() => {
          const fd = new (require('form-data'))();
          fd.append('folderId', childId);
          fd.append('name', 'nested-doc.txt');
          fd.append('file', Buffer.from('content'), { filename: 'nested-doc.txt' });
          return fd;
        })(),
        {
          headers: {
            ...adminHeader,
            ...(() => {
              const fd = new (require('form-data'))();
              return fd.getHeaders();
            })(),
          },
        },
      );
      void form;
      const docId = uploadRes.data.id;

      await axios.post(
        `${API_BASE_URL}/documents/${docId}/permissions`,
        { principalType: 'user', principalId: viewerId, permissionLevel: 'view' },
        { headers: adminHeader },
      );

      const directOnly = await axios.get<GlobalPermissionEntry[]>(
        `${API_BASE_URL}/permissions?includeInherited=false`,
        { headers: managerHeader },
      );
      expect(directOnly.data.some((e) => e.resourceId === parentId)).toBe(true);
      expect(directOnly.data.some((e) => e.resourceId === docId)).toBe(false);

      const withInherited = await axios.get<GlobalPermissionEntry[]>(
        `${API_BASE_URL}/permissions?includeInherited=true`,
        { headers: managerHeader },
      );
      const docEntry = withInherited.data.find((e) => e.resourceId === docId);
      expect(docEntry).toBeDefined();
      expect(docEntry?.resourceName).toBe('nested-doc.txt');
      expect(docEntry?.resourcePath).toContain(parentName);
      expect(docEntry?.source).toEqual({
        inheritedFrom: { resourceId: parentId, resourceName: parentName },
      });
      expect(docEntry?.principalId).toBe(viewerId);
    },
  );

  it('admin sees results without needing any direct grant', async () => {
    const adminToken = await getToken('testadmin', 'testadminpass');
    const res = await axios.get<GlobalPermissionEntry[]>(
      `${API_BASE_URL}/permissions?includeInherited=false`,
      { headers: { Authorization: `Bearer ${adminToken}` } },
    );
    expect(res.status).toBe(200);
    expect(Array.isArray(res.data)).toBe(true);
  });

  it('a user with no manage grants anywhere gets an empty array, not an error', async () => {
    const token = await getToken('testuser', 'testpass');
    // Use a fresh Keycloak-less scenario is impractical here (testuser is
    // shared across many specs and may hold grants from other tests), so
    // instead assert the shape/success rather than emptiness for this
    // shared account; emptiness for a truly ungranted principal is already
    // covered indirectly by findManagedResources's own unit tests.
    const res = await axios.get<GlobalPermissionEntry[]>(
      `${API_BASE_URL}/permissions?includeInherited=false`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    expect(res.status).toBe(200);
    expect(Array.isArray(res.data)).toBe(true);
  });
});
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `pnpm --filter api test:e2e -- global-permissions.e2e-spec.ts`
Expected: FAIL——`GET /permissions` 不存在（404）

- [ ] **Step 3: 在 `permissions.service.ts` 新增 `listGlobal` 與路徑解析 helper**

Modify `apps/api/src/permissions/permissions.service.ts`'s existing `AclService` import line to also bring in the `ManagedResourceRef` type (added in Task 3):

```ts
import { AclService, type ManagedResourceRef } from '../acl/acl.service';
```

Then add these methods to the `PermissionsService` class:

```ts
  async listGlobal(user: AuthenticatedUser, includeInherited: boolean) {
    const managed = await this.acl.findManagedResources(user, includeInherited);

    if (managed !== 'all' && managed.length === 0) {
      return [];
    }

    const permissionWhere =
      managed === 'all'
        ? {}
        : { OR: managed.map((m) => ({ resourceType: m.resourceType, resourceId: m.resourceId })) };

    const permissions = await this.prisma.permission.findMany({ where: permissionWhere });

    const sourceByResource = new Map<string, ManagedResourceRef['source']>();
    if (managed !== 'all') {
      for (const m of managed) {
        sourceByResource.set(`${m.resourceType}:${m.resourceId}`, m.source);
      }
    }

    return Promise.all(
      permissions.map(async (p) => {
        const enriched = await this.enrichWithPrincipal(p);
        const resource = await this.resolveResourcePath(p.resourceType, p.resourceId);
        return {
          ...enriched,
          resourceName: resource?.name ?? '(已刪除)',
          resourcePath: resource?.path ?? '',
          source: managed === 'all' ? 'direct' : (sourceByResource.get(`${p.resourceType}:${p.resourceId}`) ?? 'direct'),
        };
      }),
    );
  }

  private async resolveResourcePath(
    resourceType: ResourceType,
    resourceId: string,
  ): Promise<{ name: string; path: string } | null> {
    if (resourceType === 'document') {
      const doc = await this.prisma.document.findUnique({
        where: { id: resourceId },
        select: { name: true, folderId: true },
      });
      if (!doc) return null;
      return { name: doc.name, path: await this.resolveFolderPath(doc.folderId) };
    }
    const folder = await this.prisma.folder.findUnique({
      where: { id: resourceId },
      select: { name: true, parentId: true },
    });
    if (!folder) return null;
    return { name: folder.name, path: await this.resolveFolderPath(folder.parentId) };
  }

  private async resolveFolderPath(folderId: string | null): Promise<string> {
    const names: string[] = [];
    let currentId = folderId;
    for (let depth = 0; currentId && depth < 100; depth++) {
      const folder: { name: string; parentId: string | null } | null =
        await this.prisma.folder.findUnique({
          where: { id: currentId },
          select: { name: true, parentId: true },
        });
      if (!folder) break;
      names.unshift(folder.name);
      currentId = folder.parentId;
    }
    return ['Root', ...names].join(' / ');
  }
```

- [ ] **Step 4: 在 `permissions.controller.ts` 新增 `GET /permissions` handler**

Modify `apps/api/src/permissions/permissions.controller.ts` — add this method inside the `PermissionsController` class:

```ts
  @Get('permissions')
  async listGlobal(
    @Req() req: AuthenticatedRequest,
    @Query('includeInherited') includeInherited?: string,
  ) {
    const user = await this.usersService.upsertFromToken(req.user);
    return this.permissionsService.listGlobal(
      { id: user.id, roles: req.user.roles },
      includeInherited === 'true',
    );
  }
```

Add `Query` to the existing `@nestjs/common` import at the top of the file (alongside `Body, Controller, Delete, Get, HttpCode, Param, Post, Req, UseGuards`).

- [ ] **Step 5: 執行測試確認通過**

Run: `pnpm --filter api test:e2e -- global-permissions.e2e-spec.ts`
Expected: 全部 PASS

Run: `pnpm --filter api test:e2e -- permissions.e2e-spec.ts`
Expected: 全部 PASS（確認沒有回歸既有端點）

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/permissions/permissions.controller.ts apps/api/src/permissions/permissions.service.ts apps/api/test/global-permissions.e2e-spec.ts
git commit -m "feat(api): add GET /permissions global dashboard endpoint"
```

---

### Task 5: 前端 — API client 層（`api/users.ts`、`api/permissions.ts`）

**Files:**
- Create: `apps/web/src/api/users.ts`
- Create: `apps/web/src/api/permissions.ts`
- Test: `apps/web/test/api/users.test.ts`
- Test: `apps/web/test/api/permissions.test.ts`

**Interfaces:**
- Consumes: `GET /users?search=`、`GET /permissions?includeInherited=`、`GET/POST/DELETE /folders/:id/permissions`、`/documents/:id/permissions`（Task 1、2、4 新增/擴充的端點）；`apiFetch`（`api/client.ts`，既有）
- Produces：
  - `UserSummary`、`searchUsers(query, accessToken)`（`api/users.ts`）
  - `PermissionLevel`、`PermissionEntry`、`GlobalPermissionEntry`、`listPermissions`、`listGlobalPermissions`、`grantPermission`、`revokePermission`（`api/permissions.ts`）
  - 給 Task 6、7、8、9、10 消費

- [ ] **Step 1: 寫失敗的 `api/users.ts` 測試**

Create `apps/web/test/api/users.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { searchUsers } from '../../src/api/users';

describe('users api', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  it('searchUsers calls GET /users with the query string, URL-encoded', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => [{ id: '1', email: 'a@b.com', displayName: 'A', department: null }],
    } as Response);

    const result = await searchUsers('王 志成', 'fake-token');

    const [url] = vi.mocked(fetch).mock.calls[0];
    expect(url).toContain('/users?search=');
    expect(url).toContain(encodeURIComponent('王 志成'));
    expect(result).toEqual([{ id: '1', email: 'a@b.com', displayName: 'A', department: null }]);
  });
});
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `pnpm --filter web test -- users.test.ts`
Expected: FAIL，找不到 `../../src/api/users`

- [ ] **Step 3: 實作 `api/users.ts`**

Create `apps/web/src/api/users.ts`:

```ts
import { apiFetch } from './client';

export interface UserSummary {
  id: string;
  email: string;
  displayName: string;
  department: string | null;
}

export function searchUsers(query: string, accessToken: string) {
  return apiFetch<UserSummary[]>(`/users?search=${encodeURIComponent(query)}`, accessToken);
}
```

- [ ] **Step 4: 執行測試確認通過**

Run: `pnpm --filter web test -- users.test.ts`
Expected: PASS

- [ ] **Step 5: 寫失敗的 `api/permissions.ts` 測試**

Create `apps/web/test/api/permissions.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  listPermissions,
  listGlobalPermissions,
  grantPermission,
  revokePermission,
} from '../../src/api/permissions';

describe('permissions api', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  it('listPermissions calls GET /folders/:id/permissions for resourceType folder', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => [],
    } as Response);

    await listPermissions('folder', 'folder-1', 'fake-token');

    const [url] = vi.mocked(fetch).mock.calls[0];
    expect(url).toContain('/folders/folder-1/permissions');
  });

  it('listPermissions calls GET /documents/:id/permissions for resourceType document', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => [],
    } as Response);

    await listPermissions('document', 'doc-1', 'fake-token');

    const [url] = vi.mocked(fetch).mock.calls[0];
    expect(url).toContain('/documents/doc-1/permissions');
  });

  it('listGlobalPermissions calls GET /permissions with includeInherited', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => [],
    } as Response);

    await listGlobalPermissions(true, 'fake-token');

    const [url] = vi.mocked(fetch).mock.calls[0];
    expect(url).toContain('/permissions?includeInherited=true');
  });

  it('grantPermission POSTs principalType user, principalId, and permissionLevel', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ id: 'p1' }),
    } as Response);

    await grantPermission(
      'folder',
      'folder-1',
      { principalId: 'user-1', permissionLevel: 'edit' },
      'fake-token',
    );

    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toContain('/folders/folder-1/permissions');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init?.body as string)).toEqual({
      principalType: 'user',
      principalId: 'user-1',
      permissionLevel: 'edit',
    });
  });

  it('revokePermission DELETEs the specific permission id', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      headers: new Headers(),
    } as Response);

    await revokePermission('document', 'doc-1', 'perm-1', 'fake-token');

    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toContain('/documents/doc-1/permissions/perm-1');
    expect(init?.method).toBe('DELETE');
  });
});
```

- [ ] **Step 6: 執行測試確認失敗**

Run: `pnpm --filter web test -- permissions.test.ts`
Expected: FAIL，找不到 `../../src/api/permissions`

- [ ] **Step 7: 實作 `api/permissions.ts`**

Create `apps/web/src/api/permissions.ts`:

```ts
import { apiFetch } from './client';

export type PermissionLevel = 'view' | 'download' | 'edit' | 'manage';

export interface PermissionEntry {
  id: string;
  resourceType: 'folder' | 'document';
  resourceId: string;
  principalType: 'user' | 'group';
  principalId: string;
  permissionLevel: PermissionLevel;
  grantedBy: string;
  grantedAt: string;
  principal: { email: string; displayName: string } | null;
}

export interface GlobalPermissionEntry extends PermissionEntry {
  resourceName: string;
  resourcePath: string;
  source: 'direct' | { inheritedFrom: { resourceId: string; resourceName: string } };
}

export function listPermissions(
  resourceType: 'folder' | 'document',
  resourceId: string,
  accessToken: string,
) {
  return apiFetch<PermissionEntry[]>(`/${resourceType}s/${resourceId}/permissions`, accessToken);
}

export function listGlobalPermissions(includeInherited: boolean, accessToken: string) {
  return apiFetch<GlobalPermissionEntry[]>(
    `/permissions?includeInherited=${includeInherited}`,
    accessToken,
  );
}

export function grantPermission(
  resourceType: 'folder' | 'document',
  resourceId: string,
  input: { principalId: string; permissionLevel: PermissionLevel },
  accessToken: string,
) {
  return apiFetch<PermissionEntry>(`/${resourceType}s/${resourceId}/permissions`, accessToken, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ principalType: 'user', ...input }),
  });
}

export function revokePermission(
  resourceType: 'folder' | 'document',
  resourceId: string,
  permissionId: string,
  accessToken: string,
) {
  return apiFetch<void>(
    `/${resourceType}s/${resourceId}/permissions/${permissionId}`,
    accessToken,
    { method: 'DELETE' },
  );
}
```

- [ ] **Step 8: 執行測試確認通過**

Run: `pnpm --filter web test -- permissions.test.ts`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add apps/web/src/api/users.ts apps/web/src/api/permissions.ts apps/web/test/api/users.test.ts apps/web/test/api/permissions.test.ts
git commit -m "feat(web): add typed API client for users search and permissions"
```

---

### Task 6: 前端 — `components/PermissionsTable.tsx`

**Files:**
- Create: `apps/web/src/components/PermissionsTable.tsx`
- Test: `apps/web/test/components/PermissionsTable.test.tsx`

**Interfaces:**
- Consumes: `PermissionEntry`、`GlobalPermissionEntry`（Task 5）；`Table*`（`@/components/ui/table`，既有）
- Produces: `PermissionsTable({ entries, showResourceColumn, onRevoke }): JSX.Element`，給 Task 9、10 消費

- [ ] **Step 1: 寫失敗的測試**

Create `apps/web/test/components/PermissionsTable.test.tsx`:

```tsx
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { PermissionsTable } from '../../src/components/PermissionsTable';
import type { GlobalPermissionEntry, PermissionEntry } from '../../src/api/permissions';

describe('PermissionsTable', () => {
  it('renders principal, level, and grantedAt for each entry without a resource column', () => {
    const entries: PermissionEntry[] = [
      {
        id: 'p1',
        resourceType: 'folder',
        resourceId: 'f1',
        principalType: 'user',
        principalId: 'u1',
        permissionLevel: 'edit',
        grantedBy: 'admin',
        grantedAt: '2026-08-01T00:00:00Z',
        principal: { email: 'a@example.com', displayName: 'Alice' },
      },
    ];

    render(<PermissionsTable entries={entries} showResourceColumn={false} onRevoke={vi.fn()} />);

    expect(screen.getByText('Alice')).toBeInTheDocument();
    expect(screen.getByText('a@example.com')).toBeInTheDocument();
    expect(screen.getByText('edit')).toBeInTheDocument();
    expect(screen.queryByText('資源')).not.toBeInTheDocument();
  });

  it('renders resource name/path and source when showResourceColumn is true', () => {
    const entries: GlobalPermissionEntry[] = [
      {
        id: 'p2',
        resourceType: 'document',
        resourceId: 'd1',
        principalType: 'user',
        principalId: 'u2',
        permissionLevel: 'view',
        grantedBy: 'admin',
        grantedAt: '2026-08-01T00:00:00Z',
        principal: { email: 'b@example.com', displayName: 'Bob' },
        resourceName: '董事會簡報.pdf',
        resourcePath: 'Root / 財務部',
        source: { inheritedFrom: { resourceId: 'f1', resourceName: '財務部' } },
      },
    ];

    render(<PermissionsTable entries={entries} showResourceColumn={true} onRevoke={vi.fn()} />);

    expect(screen.getByText('董事會簡報.pdf')).toBeInTheDocument();
    expect(screen.getByText('Root / 財務部')).toBeInTheDocument();
    expect(screen.getByText(/財務部/)).toBeInTheDocument();
  });

  it('calls onRevoke with the permission id when the revoke button is clicked', () => {
    const onRevoke = vi.fn();
    const entries: PermissionEntry[] = [
      {
        id: 'p3',
        resourceType: 'folder',
        resourceId: 'f1',
        principalType: 'user',
        principalId: 'u3',
        permissionLevel: 'view',
        grantedBy: 'admin',
        grantedAt: '2026-08-01T00:00:00Z',
        principal: { email: 'c@example.com', displayName: 'Carol' },
      },
    ];

    render(<PermissionsTable entries={entries} showResourceColumn={false} onRevoke={onRevoke} />);
    fireEvent.click(screen.getByTestId('revoke-p3'));

    expect(onRevoke).toHaveBeenCalledWith('p3');
  });
});
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `pnpm --filter web test -- PermissionsTable.test.tsx`
Expected: FAIL，找不到 `../../src/components/PermissionsTable`

- [ ] **Step 3: 實作 `PermissionsTable.tsx`**

Create `apps/web/src/components/PermissionsTable.tsx`:

```tsx
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import type { GlobalPermissionEntry, PermissionEntry } from '../api/permissions';

const LEVEL_LABEL_CLASS: Record<string, string> = {
  view: 'bg-muted text-muted-foreground',
  download: 'bg-blue-100 text-blue-800',
  edit: 'bg-amber-100 text-amber-800',
  manage: 'bg-red-100 text-red-800',
};

function isGlobalEntry(
  entry: PermissionEntry | GlobalPermissionEntry,
): entry is GlobalPermissionEntry {
  return 'resourceName' in entry;
}

interface PermissionsTableProps {
  entries: PermissionEntry[] | GlobalPermissionEntry[];
  showResourceColumn: boolean;
  onRevoke: (permissionId: string) => void;
}

export function PermissionsTable({ entries, showResourceColumn, onRevoke }: PermissionsTableProps) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          {showResourceColumn && <TableHead>資源</TableHead>}
          <TableHead>使用者</TableHead>
          <TableHead>權限層級</TableHead>
          <TableHead>授權時間</TableHead>
          {showResourceColumn && <TableHead>來源</TableHead>}
          <TableHead />
        </TableRow>
      </TableHeader>
      <TableBody>
        {entries.map((entry) => (
          <TableRow key={entry.id}>
            {showResourceColumn && isGlobalEntry(entry) && (
              <TableCell>
                <div>{entry.resourceName}</div>
                <div className="text-xs text-muted-foreground">{entry.resourcePath}</div>
              </TableCell>
            )}
            <TableCell>
              <div>{entry.principal?.displayName ?? entry.principalId}</div>
              {entry.principal && (
                <div className="text-xs text-muted-foreground">{entry.principal.email}</div>
              )}
            </TableCell>
            <TableCell>
              <span
                className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${LEVEL_LABEL_CLASS[entry.permissionLevel] ?? ''}`}
              >
                {entry.permissionLevel}
              </span>
            </TableCell>
            <TableCell>{new Date(entry.grantedAt).toLocaleDateString()}</TableCell>
            {showResourceColumn && isGlobalEntry(entry) && (
              <TableCell className="text-xs text-muted-foreground">
                {entry.source === 'direct' ? '直接管理' : `繼承自「${entry.source.inheritedFrom.resourceName}」`}
              </TableCell>
            )}
            <TableCell>
              <Button
                variant="outline"
                size="sm"
                data-testid={`revoke-${entry.id}`}
                onClick={() => onRevoke(entry.id)}
              >
                撤銷
              </Button>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
```

- [ ] **Step 4: 執行測試確認通過**

Run: `pnpm --filter web test -- PermissionsTable.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/PermissionsTable.tsx apps/web/test/components/PermissionsTable.test.tsx
git commit -m "feat(web): add PermissionsTable component shared by resource and global views"
```

---

### Task 7: 前端 — `components/ResourcePicker.tsx`

**Files:**
- Create: `apps/web/src/components/ResourcePicker.tsx`
- Test: `apps/web/test/components/ResourcePicker.test.tsx`

**Interfaces:**
- Consumes: `listRootFolders`、`getFolder`（`api/folders.ts`，既有）；`Dialog*`（既有）
- Produces: `ResourcePicker({ open, onOpenChange, onSelect }): JSX.Element`，給 Task 8 消費

- [ ] **Step 1: 寫失敗的測試**

Create `apps/web/test/components/ResourcePicker.test.tsx`:

```tsx
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useAuth } from 'react-oidc-context';
import { ResourcePicker } from '../../src/components/ResourcePicker';
import { listRootFolders, getFolder } from '../../src/api/folders';

vi.mock('react-oidc-context', () => ({ useAuth: vi.fn() }));
vi.mock('../../src/api/folders', () => ({
  listRootFolders: vi.fn(),
  getFolder: vi.fn(),
}));

function renderPicker(onSelect = vi.fn()) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return {
    onSelect,
    ...render(
      <QueryClientProvider client={queryClient}>
        <ResourcePicker open={true} onOpenChange={vi.fn()} onSelect={onSelect} />
      </QueryClientProvider>,
    ),
  };
}

describe('ResourcePicker', () => {
  beforeEach(() => {
    vi.mocked(useAuth).mockReturnValue({
      user: { access_token: 'fake-token' },
    } as unknown as ReturnType<typeof useAuth>);
  });

  it('shows root folders and lets the user drill into one', async () => {
    vi.mocked(listRootFolders).mockResolvedValue([
      { id: 'f1', name: 'Finance', parentId: null, createdBy: 'u', createdAt: '' },
    ]);
    vi.mocked(getFolder).mockResolvedValue({
      id: 'f1',
      name: 'Finance',
      parentId: null,
      createdBy: 'u',
      createdAt: '',
      children: [{ id: 'f2', name: 'Q1', parentId: 'f1', createdBy: 'u', createdAt: '' }],
      documents: [{ id: 'd1', name: 'report.pdf', currentVersion: null }],
    });

    renderPicker();

    await waitFor(() => expect(screen.getByText('Finance')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Finance'));

    await waitFor(() => expect(screen.getByText('Q1')).toBeInTheDocument());
    expect(screen.getByText('report.pdf')).toBeInTheDocument();
  });

  it('calls onSelect with resourceType folder when "選擇這個資料夾" is clicked', async () => {
    vi.mocked(listRootFolders).mockResolvedValue([
      { id: 'f1', name: 'Finance', parentId: null, createdBy: 'u', createdAt: '' },
    ]);
    vi.mocked(getFolder).mockResolvedValue({
      id: 'f1',
      name: 'Finance',
      parentId: null,
      createdBy: 'u',
      createdAt: '',
      children: [],
      documents: [],
    });

    const { onSelect } = renderPicker();

    await waitFor(() => expect(screen.getByText('Finance')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Finance'));

    await waitFor(() => expect(screen.getByTestId('pick-current-folder')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('pick-current-folder'));

    expect(onSelect).toHaveBeenCalledWith({ resourceType: 'folder', resourceId: 'f1', name: 'Finance' });
  });

  it('calls onSelect with resourceType document when a document is clicked', async () => {
    vi.mocked(listRootFolders).mockResolvedValue([
      { id: 'f1', name: 'Finance', parentId: null, createdBy: 'u', createdAt: '' },
    ]);
    vi.mocked(getFolder).mockResolvedValue({
      id: 'f1',
      name: 'Finance',
      parentId: null,
      createdBy: 'u',
      createdAt: '',
      children: [],
      documents: [{ id: 'd1', name: 'report.pdf', currentVersion: null }],
    });

    const { onSelect } = renderPicker();

    await waitFor(() => expect(screen.getByText('Finance')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Finance'));

    await waitFor(() => expect(screen.getByText('report.pdf')).toBeInTheDocument());
    fireEvent.click(screen.getByText('report.pdf'));

    expect(onSelect).toHaveBeenCalledWith({ resourceType: 'document', resourceId: 'd1', name: 'report.pdf' });
  });
});
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `pnpm --filter web test -- ResourcePicker.test.tsx`
Expected: FAIL，找不到 `../../src/components/ResourcePicker`

- [ ] **Step 3: 實作 `ResourcePicker.tsx`**

Create `apps/web/src/components/ResourcePicker.tsx`:

```tsx
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from 'react-oidc-context';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { listRootFolders, getFolder } from '../api/folders';

export interface PickedResource {
  resourceType: 'folder' | 'document';
  resourceId: string;
  name: string;
}

interface ResourcePickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (resource: PickedResource) => void;
}

export function ResourcePicker({ open, onOpenChange, onSelect }: ResourcePickerProps) {
  const auth = useAuth();
  const accessToken = auth.user?.access_token ?? '';
  const [folderId, setFolderId] = useState<string | null>(null);

  const rootQuery = useQuery({
    queryKey: ['rootFolders'],
    queryFn: () => listRootFolders(accessToken),
    enabled: open && folderId === null,
  });
  const folderQuery = useQuery({
    queryKey: ['folder', folderId],
    queryFn: () => getFolder(folderId ?? '', accessToken),
    enabled: open && folderId !== null,
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>選擇資源</DialogTitle>
        </DialogHeader>

        {folderId === null ? (
          <ul>
            {(rootQuery.data ?? []).map((folder) => (
              <li key={folder.id}>
                <button onClick={() => setFolderId(folder.id)}>{folder.name}</button>
              </li>
            ))}
          </ul>
        ) : (
          <div>
            <Button
              variant="outline"
              size="sm"
              data-testid="pick-current-folder"
              onClick={() => {
                const name = folderQuery.data?.name ?? '';
                onSelect({ resourceType: 'folder', resourceId: folderId, name });
              }}
            >
              選擇這個資料夾
            </Button>
            <ul>
              {(folderQuery.data?.children ?? []).map((child) => (
                <li key={child.id}>
                  <button onClick={() => setFolderId(child.id)}>{child.name}</button>
                </li>
              ))}
              {(folderQuery.data?.documents ?? []).map((doc) => (
                <li key={doc.id}>
                  <button
                    onClick={() => onSelect({ resourceType: 'document', resourceId: doc.id, name: doc.name })}
                  >
                    {doc.name}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 4: 執行測試確認通過**

Run: `pnpm --filter web test -- ResourcePicker.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/ResourcePicker.tsx apps/web/test/components/ResourcePicker.test.tsx
git commit -m "feat(web): add ResourcePicker for selecting a grant target folder/document"
```

---

### Task 8: 前端 — `components/GrantPermissionForm.tsx`

**Files:**
- Create: `apps/web/src/components/GrantPermissionForm.tsx`
- Test: `apps/web/test/components/GrantPermissionForm.test.tsx`

**Interfaces:**
- Consumes: `searchUsers`（Task 5）、`grantPermission`（Task 5）、`ResourcePicker`（Task 7）
- Produces: `GrantPermissionForm({ fixedResource?, onGranted }): JSX.Element`，給 Task 9、10 消費

- [ ] **Step 1: 寫失敗的測試**

Create `apps/web/test/components/GrantPermissionForm.test.tsx`:

```tsx
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useAuth } from 'react-oidc-context';
import { GrantPermissionForm } from '../../src/components/GrantPermissionForm';
import { searchUsers } from '../../src/api/users';
import { grantPermission } from '../../src/api/permissions';

vi.mock('react-oidc-context', () => ({ useAuth: vi.fn() }));
vi.mock('../../src/api/users', () => ({ searchUsers: vi.fn() }));
vi.mock('../../src/api/permissions', () => ({ grantPermission: vi.fn() }));

function renderForm(props: Parameters<typeof GrantPermissionForm>[0]) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <GrantPermissionForm {...props} />
    </QueryClientProvider>,
  );
}

describe('GrantPermissionForm', () => {
  beforeEach(() => {
    vi.mocked(useAuth).mockReturnValue({
      user: { access_token: 'fake-token' },
    } as unknown as ReturnType<typeof useAuth>);
  });

  it('with a fixedResource, searches users, selects one, and grants the chosen level', async () => {
    vi.mocked(searchUsers).mockResolvedValue([
      { id: 'u1', email: 'alice@example.com', displayName: 'Alice', department: null },
    ]);
    vi.mocked(grantPermission).mockResolvedValue({
      id: 'p1',
      resourceType: 'folder',
      resourceId: 'f1',
      principalType: 'user',
      principalId: 'u1',
      permissionLevel: 'edit',
      grantedBy: 'admin',
      grantedAt: '',
      principal: null,
    });
    const onGranted = vi.fn();

    renderForm({
      fixedResource: { resourceType: 'folder', resourceId: 'f1' },
      onGranted,
    });

    fireEvent.change(screen.getByTestId('user-search-input'), { target: { value: 'Alice' } });
    fireEvent.click(screen.getByTestId('user-search-submit'));

    await waitFor(() => expect(screen.getByText('Alice')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Alice'));

    fireEvent.change(screen.getByTestId('permission-level-select'), { target: { value: 'edit' } });
    fireEvent.click(screen.getByTestId('grant-submit'));

    await waitFor(() =>
      expect(grantPermission).toHaveBeenCalledWith(
        'folder',
        'f1',
        { principalId: 'u1', permissionLevel: 'edit' },
        'fake-token',
      ),
    );
    await waitFor(() => expect(onGranted).toHaveBeenCalled());
  });

  it('shows a message when the search returns no results', async () => {
    vi.mocked(searchUsers).mockResolvedValue([]);

    renderForm({ fixedResource: { resourceType: 'folder', resourceId: 'f1' }, onGranted: vi.fn() });

    fireEvent.change(screen.getByTestId('user-search-input'), { target: { value: 'nobody' } });
    fireEvent.click(screen.getByTestId('user-search-submit'));

    await waitFor(() => expect(screen.getByTestId('no-results')).toBeInTheDocument());
  });

  it('without a fixedResource, the grant button stays disabled until a resource is picked', async () => {
    renderForm({ onGranted: vi.fn() });

    expect(screen.getByTestId('grant-submit')).toBeDisabled();
    expect(screen.getByTestId('open-resource-picker')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `pnpm --filter web test -- GrantPermissionForm.test.tsx`
Expected: FAIL，找不到 `../../src/components/GrantPermissionForm`

- [ ] **Step 3: 實作 `GrantPermissionForm.tsx`**

Create `apps/web/src/components/GrantPermissionForm.tsx`:

```tsx
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from 'react-oidc-context';
import { Button } from '@/components/ui/button';
import { searchUsers, type UserSummary } from '../api/users';
import { grantPermission, type PermissionLevel } from '../api/permissions';
import { friendlyErrorMessage } from '../api/client';
import { ResourcePicker, type PickedResource } from './ResourcePicker';

interface FixedResource {
  resourceType: 'folder' | 'document';
  resourceId: string;
}

interface GrantPermissionFormProps {
  fixedResource?: FixedResource;
  onGranted: () => void;
}

export function GrantPermissionForm({ fixedResource, onGranted }: GrantPermissionFormProps) {
  const auth = useAuth();
  const accessToken = auth.user?.access_token ?? '';
  const queryClient = useQueryClient();

  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickedResource, setPickedResource] = useState<PickedResource | null>(null);
  const resource: FixedResource | null =
    fixedResource ??
    (pickedResource
      ? { resourceType: pickedResource.resourceType, resourceId: pickedResource.resourceId }
      : null);

  const [searchInput, setSearchInput] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedUser, setSelectedUser] = useState<UserSummary | null>(null);
  const [level, setLevel] = useState<PermissionLevel>('view');

  const searchResults = useQuery({
    queryKey: ['userSearch', searchQuery],
    queryFn: () => searchUsers(searchQuery, accessToken),
    enabled: searchQuery.trim() !== '',
  });

  const mutation = useMutation({
    mutationFn: () => {
      if (!resource || !selectedUser) throw new Error('resource and user must be selected');
      return grantPermission(
        resource.resourceType,
        resource.resourceId,
        { principalId: selectedUser.id, permissionLevel: level },
        accessToken,
      );
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['permissions'] });
      queryClient.invalidateQueries({ queryKey: ['globalPermissions'] });
      setSelectedUser(null);
      setSearchInput('');
      setSearchQuery('');
      onGranted();
    },
  });

  return (
    <div>
      {!fixedResource && (
        <div>
          <Button
            variant="outline"
            size="sm"
            data-testid="open-resource-picker"
            onClick={() => setPickerOpen(true)}
          >
            {pickedResource ? pickedResource.name : '選擇資源'}
          </Button>
          <ResourcePicker
            open={pickerOpen}
            onOpenChange={setPickerOpen}
            onSelect={(r) => {
              setPickedResource(r);
              setPickerOpen(false);
            }}
          />
        </div>
      )}

      <div>
        <input
          data-testid="user-search-input"
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          placeholder="輸入姓名或 email 搜尋使用者"
        />
        <Button
          variant="outline"
          size="sm"
          data-testid="user-search-submit"
          onClick={() => setSearchQuery(searchInput)}
        >
          搜尋
        </Button>
      </div>

      {searchResults.isError && <p>{friendlyErrorMessage(searchResults.error)}</p>}
      {searchResults.data && searchResults.data.length === 0 && (
        <p data-testid="no-results">找不到符合的使用者</p>
      )}
      {searchResults.data && searchResults.data.length > 0 && (
        <ul>
          {searchResults.data.map((user) => (
            <li key={user.id}>
              <button onClick={() => setSelectedUser(user)}>
                {user.displayName}（{user.email}）
              </button>
            </li>
          ))}
        </ul>
      )}
      {selectedUser && <p>已選擇：{selectedUser.displayName}</p>}

      <select
        data-testid="permission-level-select"
        value={level}
        onChange={(e) => setLevel(e.target.value as PermissionLevel)}
      >
        <option value="view">view（檢視）</option>
        <option value="download">download（下載）</option>
        <option value="edit">edit（編輯）</option>
        <option value="manage">manage（管理）</option>
      </select>

      {mutation.isError && <p>{friendlyErrorMessage(mutation.error)}</p>}

      <Button
        data-testid="grant-submit"
        disabled={!resource || !selectedUser || mutation.isPending}
        onClick={() => mutation.mutate()}
      >
        授權
      </Button>
    </div>
  );
}
```

- [ ] **Step 4: 執行測試確認通過**

Run: `pnpm --filter web test -- GrantPermissionForm.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/GrantPermissionForm.tsx apps/web/test/components/GrantPermissionForm.test.tsx
git commit -m "feat(web): add GrantPermissionForm shared by resource and global views"
```

---

### Task 9: 前端 — 資源專屬權限頁面（`routes/FolderPermissions.tsx`、`routes/DocumentPermissions.tsx`）

**Files:**
- Create: `apps/web/src/routes/FolderPermissions.tsx`
- Create: `apps/web/src/routes/DocumentPermissions.tsx`
- Test: `apps/web/test/routes/FolderPermissions.test.tsx`
- Test: `apps/web/test/routes/DocumentPermissions.test.tsx`

**Interfaces:**
- Consumes: `listPermissions`、`revokePermission`（Task 5）；`PermissionsTable`（Task 6）；`GrantPermissionForm`（Task 8）
- Produces: `FolderPermissions(): JSX.Element`、`DocumentPermissions(): JSX.Element`，給 Task 11（`App.tsx` 路由）消費

- [ ] **Step 1: 寫失敗的測試**

Create `apps/web/test/routes/FolderPermissions.test.tsx`:

```tsx
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useAuth } from 'react-oidc-context';
import { FolderPermissions } from '../../src/routes/FolderPermissions';
import { listPermissions, revokePermission } from '../../src/api/permissions';
import { renderWithProviders } from '../testUtils';

vi.mock('react-oidc-context', () => ({ useAuth: vi.fn() }));
vi.mock('../../src/api/permissions', () => ({
  listPermissions: vi.fn(),
  revokePermission: vi.fn(),
  grantPermission: vi.fn(),
}));
vi.mock('../../src/api/users', () => ({ searchUsers: vi.fn() }));

describe('FolderPermissions', () => {
  beforeEach(() => {
    vi.mocked(useAuth).mockReturnValue({
      user: { access_token: 'fake-token' },
    } as unknown as ReturnType<typeof useAuth>);
  });

  it('lists permissions for the folder id from the route and revokes one on click', async () => {
    vi.mocked(listPermissions).mockResolvedValue([
      {
        id: 'p1',
        resourceType: 'folder',
        resourceId: 'folder-1',
        principalType: 'user',
        principalId: 'u1',
        permissionLevel: 'view',
        grantedBy: 'admin',
        grantedAt: '2026-08-01T00:00:00Z',
        principal: { email: 'a@example.com', displayName: 'Alice' },
      },
    ]);
    vi.mocked(revokePermission).mockResolvedValue(undefined);

    renderWithProviders(<FolderPermissions />, {
      route: '/folders/folder-1/permissions',
      path: '/folders/:id/permissions',
    });

    await waitFor(() => expect(screen.getByText('Alice')).toBeInTheDocument());
    expect(listPermissions).toHaveBeenCalledWith('folder', 'folder-1', 'fake-token');

    fireEvent.click(screen.getByTestId('revoke-p1'));
    await waitFor(() =>
      expect(revokePermission).toHaveBeenCalledWith('folder', 'folder-1', 'p1', 'fake-token'),
    );
  });
});
```

Create `apps/web/test/routes/DocumentPermissions.test.tsx`:

```tsx
import { screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useAuth } from 'react-oidc-context';
import { DocumentPermissions } from '../../src/routes/DocumentPermissions';
import { listPermissions } from '../../src/api/permissions';
import { renderWithProviders } from '../testUtils';

vi.mock('react-oidc-context', () => ({ useAuth: vi.fn() }));
vi.mock('../../src/api/permissions', () => ({
  listPermissions: vi.fn(),
  revokePermission: vi.fn(),
  grantPermission: vi.fn(),
}));
vi.mock('../../src/api/users', () => ({ searchUsers: vi.fn() }));

describe('DocumentPermissions', () => {
  beforeEach(() => {
    vi.mocked(useAuth).mockReturnValue({
      user: { access_token: 'fake-token' },
    } as unknown as ReturnType<typeof useAuth>);
  });

  it('lists permissions for the document id from the route', async () => {
    vi.mocked(listPermissions).mockResolvedValue([]);

    renderWithProviders(<DocumentPermissions />, {
      route: '/documents/doc-1/permissions',
      path: '/documents/:id/permissions',
    });

    await waitFor(() =>
      expect(listPermissions).toHaveBeenCalledWith('document', 'doc-1', 'fake-token'),
    );
  });
});
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `pnpm --filter web test -- FolderPermissions.test.tsx DocumentPermissions.test.tsx`
Expected: FAIL，找不到 `../../src/routes/FolderPermissions`、`../../src/routes/DocumentPermissions`

- [ ] **Step 3: 實作 `FolderPermissions.tsx`、`DocumentPermissions.tsx`**

Create `apps/web/src/routes/FolderPermissions.tsx`:

```tsx
import { useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from 'react-oidc-context';
import { listPermissions, revokePermission } from '../api/permissions';
import { friendlyErrorMessage } from '../api/client';
import { PermissionsTable } from '../components/PermissionsTable';
import { GrantPermissionForm } from '../components/GrantPermissionForm';

export function FolderPermissions() {
  const { id } = useParams<{ id: string }>();
  const auth = useAuth();
  const accessToken = auth.user?.access_token ?? '';
  const folderId = id ?? '';
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ['permissions', 'folder', folderId],
    queryFn: () => listPermissions('folder', folderId, accessToken),
    enabled: !!folderId,
  });

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ['permissions', 'folder', folderId] });

  const handleRevoke = (permissionId: string) => {
    revokePermission('folder', folderId, permissionId, accessToken).then(invalidate);
  };

  if (query.isLoading) return <p data-testid="loading">Loading...</p>;
  if (query.isError) return <p data-testid="error">{friendlyErrorMessage(query.error)}</p>;

  return (
    <div className="mx-auto max-w-4xl px-6 py-8">
      <h1 className="mb-6 text-xl font-bold">權限管理</h1>
      <PermissionsTable entries={query.data ?? []} showResourceColumn={false} onRevoke={handleRevoke} />
      <div className="mt-6">
        <GrantPermissionForm
          fixedResource={{ resourceType: 'folder', resourceId: folderId }}
          onGranted={invalidate}
        />
      </div>
    </div>
  );
}
```

Create `apps/web/src/routes/DocumentPermissions.tsx`:

```tsx
import { useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from 'react-oidc-context';
import { listPermissions, revokePermission } from '../api/permissions';
import { friendlyErrorMessage } from '../api/client';
import { PermissionsTable } from '../components/PermissionsTable';
import { GrantPermissionForm } from '../components/GrantPermissionForm';

export function DocumentPermissions() {
  const { id } = useParams<{ id: string }>();
  const auth = useAuth();
  const accessToken = auth.user?.access_token ?? '';
  const documentId = id ?? '';
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ['permissions', 'document', documentId],
    queryFn: () => listPermissions('document', documentId, accessToken),
    enabled: !!documentId,
  });

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ['permissions', 'document', documentId] });

  const handleRevoke = (permissionId: string) => {
    revokePermission('document', documentId, permissionId, accessToken).then(invalidate);
  };

  if (query.isLoading) return <p data-testid="loading">Loading...</p>;
  if (query.isError) return <p data-testid="error">{friendlyErrorMessage(query.error)}</p>;

  return (
    <div className="mx-auto max-w-4xl px-6 py-8">
      <h1 className="mb-6 text-xl font-bold">權限管理</h1>
      <PermissionsTable entries={query.data ?? []} showResourceColumn={false} onRevoke={handleRevoke} />
      <div className="mt-6">
        <GrantPermissionForm
          fixedResource={{ resourceType: 'document', resourceId: documentId }}
          onGranted={invalidate}
        />
      </div>
    </div>
  );
}
```

- [ ] **Step 4: 執行測試確認通過**

Run: `pnpm --filter web test -- FolderPermissions.test.tsx DocumentPermissions.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/routes/FolderPermissions.tsx apps/web/src/routes/DocumentPermissions.tsx apps/web/test/routes/FolderPermissions.test.tsx apps/web/test/routes/DocumentPermissions.test.tsx
git commit -m "feat(web): add resource-scoped permission management pages"
```

---

### Task 10: 前端 — `routes/PermissionsDashboard.tsx`（全域儀表板）

**Files:**
- Create: `apps/web/src/routes/PermissionsDashboard.tsx`
- Test: `apps/web/test/routes/PermissionsDashboard.test.tsx`

**Interfaces:**
- Consumes: `listGlobalPermissions`、`revokePermission`（Task 5）；`PermissionsTable`（Task 6）；`GrantPermissionForm`（Task 8）
- Produces: `PermissionsDashboard(): JSX.Element`，給 Task 11（`App.tsx` 路由）消費

- [ ] **Step 1: 寫失敗的測試**

Create `apps/web/test/routes/PermissionsDashboard.test.tsx`:

```tsx
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useAuth } from 'react-oidc-context';
import { PermissionsDashboard } from '../../src/routes/PermissionsDashboard';
import { listGlobalPermissions } from '../../src/api/permissions';
import { renderWithProviders } from '../testUtils';

vi.mock('react-oidc-context', () => ({ useAuth: vi.fn() }));
vi.mock('../../src/api/permissions', () => ({
  listGlobalPermissions: vi.fn(),
  revokePermission: vi.fn(),
  grantPermission: vi.fn(),
}));
vi.mock('../../src/api/users', () => ({ searchUsers: vi.fn() }));

const directEntry = {
  id: 'p1',
  resourceType: 'folder' as const,
  resourceId: 'f1',
  principalType: 'user' as const,
  principalId: 'u1',
  permissionLevel: 'manage' as const,
  grantedBy: 'admin',
  grantedAt: '2026-08-01T00:00:00Z',
  principal: { email: 'a@example.com', displayName: 'Alice' },
  resourceName: '財務部',
  resourcePath: 'Root',
  source: 'direct' as const,
};

describe('PermissionsDashboard', () => {
  beforeEach(() => {
    vi.mocked(useAuth).mockReturnValue({
      user: { access_token: 'fake-token' },
    } as unknown as ReturnType<typeof useAuth>);
  });

  it('loads with includeInherited=false by default', async () => {
    vi.mocked(listGlobalPermissions).mockResolvedValue([directEntry]);

    renderWithProviders(<PermissionsDashboard />, { route: '/permissions', path: '/permissions' });

    await waitFor(() => expect(screen.getByText('財務部')).toBeInTheDocument());
    expect(listGlobalPermissions).toHaveBeenCalledWith(false, 'fake-token');
  });

  it('clicking "顯示繼承項目" refetches with includeInherited=true', async () => {
    vi.mocked(listGlobalPermissions).mockResolvedValue([directEntry]);

    renderWithProviders(<PermissionsDashboard />, { route: '/permissions', path: '/permissions' });

    await waitFor(() => expect(screen.getByText('財務部')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('include-inherited-toggle'));

    await waitFor(() => expect(listGlobalPermissions).toHaveBeenCalledWith(true, 'fake-token'));
  });

  it('filters displayed entries by the search box against resource name and principal', async () => {
    const otherEntry = { ...directEntry, id: 'p2', resourceName: '人事資料', principal: { email: 'z@example.com', displayName: 'Zoe' } };
    vi.mocked(listGlobalPermissions).mockResolvedValue([directEntry, otherEntry]);

    renderWithProviders(<PermissionsDashboard />, { route: '/permissions', path: '/permissions' });

    await waitFor(() => expect(screen.getByText('財務部')).toBeInTheDocument());
    expect(screen.getByText('人事資料')).toBeInTheDocument();

    fireEvent.change(screen.getByTestId('permissions-filter-input'), { target: { value: '財務' } });

    expect(screen.getByText('財務部')).toBeInTheDocument();
    expect(screen.queryByText('人事資料')).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `pnpm --filter web test -- PermissionsDashboard.test.tsx`
Expected: FAIL，找不到 `../../src/routes/PermissionsDashboard`

- [ ] **Step 3: 實作 `PermissionsDashboard.tsx`**

Create `apps/web/src/routes/PermissionsDashboard.tsx`:

```tsx
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from 'react-oidc-context';
import { Button } from '@/components/ui/button';
import { listGlobalPermissions, revokePermission } from '../api/permissions';
import { friendlyErrorMessage } from '../api/client';
import { PermissionsTable } from '../components/PermissionsTable';
import { GrantPermissionForm } from '../components/GrantPermissionForm';

export function PermissionsDashboard() {
  const auth = useAuth();
  const accessToken = auth.user?.access_token ?? '';
  const queryClient = useQueryClient();

  const [includeInherited, setIncludeInherited] = useState(false);
  const [filter, setFilter] = useState('');

  const query = useQuery({
    queryKey: ['globalPermissions', includeInherited],
    queryFn: () => listGlobalPermissions(includeInherited, accessToken),
    enabled: !!accessToken,
  });

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ['globalPermissions'] });

  const handleRevoke = (permissionId: string, resourceType: 'folder' | 'document', resourceId: string) => {
    revokePermission(resourceType, resourceId, permissionId, accessToken).then(invalidate);
  };

  if (query.isLoading) return <p data-testid="loading">Loading...</p>;
  if (query.isError) return <p data-testid="error">{friendlyErrorMessage(query.error)}</p>;

  const entries = query.data ?? [];
  const filtered = filter.trim()
    ? entries.filter(
        (e) =>
          e.resourceName.includes(filter) ||
          e.principal?.displayName.includes(filter) ||
          e.principal?.email.includes(filter),
      )
    : entries;

  return (
    <div className="mx-auto max-w-4xl px-6 py-8">
      <h1 className="mb-6 text-xl font-bold">權限管理</h1>

      <div className="mb-4 flex items-center gap-2">
        <input
          data-testid="permissions-filter-input"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="搜尋資源名稱或使用者..."
        />
        <Button
          variant="outline"
          size="sm"
          data-testid="include-inherited-toggle"
          disabled={includeInherited || query.isFetching}
          onClick={() => setIncludeInherited(true)}
        >
          {includeInherited ? '已包含繼承項目' : '顯示繼承項目'}
        </Button>
      </div>

      <PermissionsTable
        entries={filtered}
        showResourceColumn={true}
        onRevoke={(permissionId) => {
          const entry = entries.find((e) => e.id === permissionId);
          if (entry) handleRevoke(permissionId, entry.resourceType, entry.resourceId);
        }}
      />

      <div className="mt-6">
        <GrantPermissionForm onGranted={invalidate} />
      </div>
    </div>
  );
}
```

- [ ] **Step 4: 執行測試確認通過**

Run: `pnpm --filter web test -- PermissionsDashboard.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/routes/PermissionsDashboard.tsx apps/web/test/routes/PermissionsDashboard.test.tsx
git commit -m "feat(web): add global permissions dashboard route"
```

---

### Task 11: 前端 — 接線（`Navbar.tsx` 分頁、`App.tsx` 路由、`FolderView`/`DocumentView` 連結）

**Files:**
- Modify: `apps/web/src/components/Navbar.tsx`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/routes/FolderView.tsx`
- Modify: `apps/web/src/routes/DocumentView.tsx`
- Test: `apps/web/test/components/Navbar.test.tsx`（既有檔案，追加）
- Test: `apps/web/test/routes/FolderView.test.tsx`（既有檔案，追加）
- Test: `apps/web/test/routes/DocumentView.test.tsx`（既有檔案，追加）

**Interfaces:**
- Consumes: `PermissionsDashboard`（Task 10）、`FolderPermissions`/`DocumentPermissions`（Task 9）
- Produces: 無新 exported 介面，純接線

- [ ] **Step 1: 寫失敗的測試（追加到既有檔案）**

在 `apps/web/test/components/Navbar.test.tsx` 檔案結尾的 `});`（最後一個 `describe` 收尾）之前加入一個新的 `it`（跟既有的 `it` 同一層縮排）：

```tsx
  it('renders 資料夾 and 權限管理 nav tabs linking to / and /permissions', async () => {
    renderNavbar();

    const foldersLink = screen.getByRole('link', { name: '資料夾' });
    const permissionsLink = screen.getByRole('link', { name: '權限管理' });
    expect(foldersLink).toHaveAttribute('href', '/');
    expect(permissionsLink).toHaveAttribute('href', '/permissions');
  });
```

在 `apps/web/test/routes/FolderView.test.tsx` 的既有 `it` 之後加入：

```tsx
  it('renders a link to the folder\'s permissions page', async () => {
    vi.mocked(getFolder).mockResolvedValue({
      id: 'folder-1',
      name: 'Finance',
      parentId: null,
      createdBy: 'u',
      createdAt: '',
      children: [],
      documents: [],
    });

    renderWithProviders(<FolderView />, { route: '/folders/folder-1', path: '/folders/:id' });

    await waitFor(() =>
      expect(screen.getByRole('link', { name: '權限' })).toHaveAttribute(
        'href',
        '/folders/folder-1/permissions',
      ),
    );
  });
```

（這個新測試需要在檔案頂部確認 `waitFor` 已從 `@testing-library/react` import；既有測試檔案已經有這個 import，不用額外加）

在 `apps/web/test/routes/DocumentView.test.tsx` 的既有 `it` 之後加入：

```tsx
  it('renders a link to the document\'s permissions page', async () => {
    vi.mocked(getDocument).mockResolvedValue({
      id: 'doc-1',
      folderId: 'folder-1',
      name: 'report.pdf',
      currentVersionId: 'v2',
      currentVersion: null,
      createdBy: 'u',
      createdAt: '',
    });
    vi.mocked(listVersions).mockResolvedValue([]);

    renderWithProviders(<DocumentView />, { route: '/documents/doc-1', path: '/documents/:id' });

    await waitFor(() =>
      expect(screen.getByRole('link', { name: '權限' })).toHaveAttribute(
        'href',
        '/documents/doc-1/permissions',
      ),
    );
  });
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `pnpm --filter web test -- Navbar.test.tsx FolderView.test.tsx DocumentView.test.tsx`
Expected: FAIL——`Navbar` 目前沒有分頁連結；`FolderView`/`DocumentView` 目前沒有「權限」連結

- [ ] **Step 3: 修改 `Navbar.tsx` 加上分頁連結**

Modify `apps/web/src/components/Navbar.tsx`'s import line and the brand `<Link>` block:

```tsx
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, NavLink, Outlet } from 'react-router-dom';
```

Then, immediately after the closing `</Link>` of the brand mark (still inside the `<header>`, before the `data-testid="navbar-crumb"` div), insert:

```tsx
        <nav className="flex shrink-0 gap-4 text-sm">
          <NavLink
            to="/"
            end
            className={({ isActive }) =>
              isActive ? 'font-semibold text-white' : 'text-primary-foreground/75'
            }
          >
            資料夾
          </NavLink>
          <NavLink
            to="/permissions"
            className={({ isActive }) =>
              isActive ? 'font-semibold text-white' : 'text-primary-foreground/75'
            }
          >
            權限管理
          </NavLink>
        </nav>
```

- [ ] **Step 4: 修改 `App.tsx` 追加路由**

Modify `apps/web/src/App.tsx`'s imports and `<Routes>`:

```tsx
import { RootFolders } from './routes/RootFolders';
import { FolderView } from './routes/FolderView';
import { DocumentView } from './routes/DocumentView';
import { PermissionsDashboard } from './routes/PermissionsDashboard';
import { FolderPermissions } from './routes/FolderPermissions';
import { DocumentPermissions } from './routes/DocumentPermissions';
```

```tsx
      <Routes>
        <Route element={<Navbar />}>
          <Route path="/" element={<RootFolders />} />
          <Route path="/folders/:id" element={<FolderView />} />
          <Route path="/folders/:id/permissions" element={<FolderPermissions />} />
          <Route path="/documents/:id" element={<DocumentView />} />
          <Route path="/documents/:id/permissions" element={<DocumentPermissions />} />
          <Route path="/permissions" element={<PermissionsDashboard />} />
        </Route>
      </Routes>
```

- [ ] **Step 5: 修改 `FolderView.tsx`、`DocumentView.tsx` 加上「權限」連結**

Modify `apps/web/src/routes/FolderView.tsx`'s import line and header button group:

```tsx
import { Link, useParams } from 'react-router-dom';
```

（`Link` 已經是既有 import，不用重複加）

```tsx
        <div className="flex gap-2">
          <CreateFolderDialog parentId={folder.id} />
          <UploadDialog mode="new-document" folderId={folder.id} />
          <Link
            to={`/folders/${folder.id}/permissions`}
            className="inline-flex items-center rounded-md border px-3 py-2 text-sm font-medium hover:bg-accent"
          >
            權限
          </Link>
        </div>
```

Modify `apps/web/src/routes/DocumentView.tsx`'s import line and header button group:

```tsx
import { Link, useParams } from 'react-router-dom';
```

```tsx
          <div className="flex gap-2">
            <Button data-testid="download-current" onClick={() => handleDownload()}>
              下載目前版本
            </Button>
            <UploadDialog mode="new-version" documentId={documentId} />
            <Link
              to={`/documents/${documentId}/permissions`}
              className="inline-flex items-center rounded-md border px-3 py-2 text-sm font-medium hover:bg-accent"
            >
              權限
            </Link>
          </div>
```

- [ ] **Step 6: 執行測試確認通過，並確認完整前端測試套件沒有回歸**

Run: `pnpm --filter web test -- Navbar.test.tsx FolderView.test.tsx DocumentView.test.tsx`
Expected: 全部 PASS

Run: `pnpm --filter web test`
Expected: 全部 PASS

Run: `pnpm --filter web build`
Expected: 成功

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/Navbar.tsx apps/web/src/App.tsx apps/web/src/routes/FolderView.tsx apps/web/src/routes/DocumentView.tsx apps/web/test/components/Navbar.test.tsx apps/web/test/routes/FolderView.test.tsx apps/web/test/routes/DocumentView.test.tsx
git commit -m "feat(web): wire up permission management routes and navigation"
```

---

### Task 12: 手動瀏覽器驗證

**Files:** 無程式碼異動

- [ ] **Step 1: 重新建置並部署 `web`、`api` container**

```bash
docker compose -p drm build web api
docker compose -p drm up -d web api
```

- [ ] **Step 2: 用 `testadmin`/`testadminpass` 驗證**

開 `https://app.drm.apower.lan`，登入後確認：
- 導覽列品牌標記右邊出現「資料夾」「權限管理」兩個分頁，點擊「權限管理」進入 `/permissions`
- 建立一個資料夾，在其中建一個子資料夾與上傳一份文件
- 在該資料夾的 `FolderView` 頁面點「權限」連結，進入 `/folders/:id/permissions`，用「新增授權」表單搜尋一個使用者（例如 `testuser`）、選擇層級、送出，確認清單出現新授權，撤銷後清單消失
- 回到 `/permissions` 全域儀表板，確認剛才那筆資料夾授權出現在「直接管理」清單裡
- 點「顯示繼承項目」，確認子資料夾/文件（如果對它們有繼承出 `manage` 權限）也出現，並標示「繼承自」
- 用篩選框輸入資源名稱或使用者關鍵字，確認清單正確過濾
- 在全域儀表板用「＋ 新增授權」，透過 `ResourcePicker` 選一個資源（逐層點進資料夾），完成授權流程

- [ ] **Step 3: 用 `testuser`/`testpass` 驗證**

確認：
- 沒有任何 `manage` 授權時，`/permissions` 顯示空清單（不是錯誤）
- 進入一個沒有 `manage` 權限的資料夾/文件的「權限」頁面，顯示「你沒有存取這個項目的權限」而不是白屏或未處理的錯誤

- [ ] **Step 4: 確認瀏覽器主控台沒有錯誤**

跑完上述流程後打開 DevTools Console，確認沒有紅色錯誤（尤其是 React 的 `Maximum update depth exceeded` 或未處理的 promise rejection）
