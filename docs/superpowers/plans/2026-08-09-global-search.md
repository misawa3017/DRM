# Global Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user search for any folder or document by name, anywhere in the system they have view access to, from a search box in the navbar.

**Architecture:** A new backend `SearchModule` matches the query against `Folder.name`/`Document.name` directly (no tree recursion needed — both tables are queried flat), filters each match through the existing `AclService.can(..., 'view')`, and resolves each surviving match's ancestor path using a small self-contained copy of `PermissionsService.resolveFolderPath`'s logic. The frontend adds a search box to `Navbar.tsx` that navigates to a new `/search?q=...` route, which calls the new endpoint and renders results as a clickable list.

**Tech Stack:** NestJS + Prisma + PostgreSQL (backend), React + TanStack Query + React Router (frontend), Jest (`apps/api`), Vitest + Testing Library (`apps/web`).

## Global Constraints

- Search matches only `name` (folders and documents) — no content/full-text search.
- Case-insensitive substring match (`contains`, `mode: 'insensitive'`), excluding soft-deleted rows (`deletedAt: null`).
- Every match is filtered through `AclService.can(user, resourceType, resourceId, 'view')` — a result never appears unless the caller can view it. Admins see everything (already handled inside `AclService.can`).
- Results: folders first, then documents; each group sorted alphabetically by name. No relevance ranking.
- Result cap: 50, applied in the application layer after ACL filtering (not a DB-level `LIMIT`) — matches the existing "fetch broad, filter with ACL" pattern already used by `listRootFolders`/`getWithContents`.
- An empty or whitespace-only query returns `[]` without touching the database.
- Each result carries an ancestor path string in the exact format already used by the permissions feature: `'Root'` for a root-level item, `'Root / A / B'` for a nested one — excludes the resource's own name.
- No pagination, no relevance ranking, no full-text search — out of scope, matches the rest of this app's current list pages.

---

## File Structure

**Backend (`apps/api/src`):**
- `search/search.service.ts` — new. `SearchService.search(user, query): Promise<SearchResultItem[]>`, plus a private `resolveFolderPath` copied from (not shared with) `PermissionsService`'s.
- `search/search.controller.ts` — new. `GET /search?q=`.
- `search/search.module.ts` — new. Wires `AclModule` + `UsersModule`.
- `app.module.ts` — modify: register `SearchModule`.

**Frontend (`apps/web/src`):**
- `api/search.ts` — new. `SearchResultItem` type + `searchResources(query, accessToken)`.
- `components/Navbar.tsx` — modify: add the search box.
- `routes/Search.tsx` — new. The `/search` results page.
- `App.tsx` — modify: register the `/search` route.

---

### Task 1: Backend — `GET /search` endpoint

**Files:**
- Create: `apps/api/src/search/search.service.ts`
- Create: `apps/api/src/search/search.controller.ts`
- Create: `apps/api/src/search/search.module.ts`
- Modify: `apps/api/src/app.module.ts`
- Test: `apps/api/test/search.e2e-spec.ts`

**Interfaces:**
- Consumes: `AclService.can(user, resourceType, resourceId, level)` (existing), `UsersService.upsertFromToken(tokenPayload)` (existing).
- Produces: `SearchResultItem { resourceType: 'folder' | 'document'; resourceId: string; name: string; path: string }`, exported from `search.service.ts`. `GET /search?q=<query>` (authenticated) returning `SearchResultItem[]`. Task 3's frontend `api/search.ts` mirrors this exact shape.

- [ ] **Step 1: Write the failing e2e tests**

Create `apps/api/test/search.e2e-spec.ts`:

```ts
import axios from 'axios';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';

const KEYCLOAK_TOKEN_URL = 'https://auth.drm.apower.lan/realms/drm/protocol/openid-connect/token';
const API_BASE_URL = 'https://api.drm.apower.lan';

interface TokenResponse {
  access_token: string;
}

interface SearchResultItem {
  resourceType: 'folder' | 'document';
  resourceId: string;
  name: string;
  path: string;
}

async function getToken(username: string, password: string): Promise<string> {
  const response = await axios.post<TokenResponse>(
    KEYCLOAK_TOKEN_URL,
    new URLSearchParams({ grant_type: 'password', client_id: 'drm-web', username, password }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
  );
  return response.data.access_token;
}

describe('Search (e2e)', () => {
  const prisma = new PrismaClient({
    datasources: { db: { url: 'postgresql://drm:drm_dev_password@localhost:5433/drm' } },
  });

  let testUserId: string;

  beforeAll(async () => {
    const token = await getToken('testuser', 'testpass');
    const res = await axios.get<{ id: string }>(`${API_BASE_URL}/whoami`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    testUserId = res.data.id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('finds a folder the caller has view access to, case-insensitively', async () => {
    const folder = await prisma.folder.create({
      data: { name: `SearchTarget-${randomUUID()}`, parentId: null, createdBy: 'seed' },
    });
    await prisma.permission.create({
      data: {
        resourceType: 'folder',
        resourceId: folder.id,
        principalType: 'user',
        principalId: testUserId,
        permissionLevel: 'view',
        grantedBy: 'seed',
      },
    });

    const token = await getToken('testuser', 'testpass');
    const res = await axios.get<SearchResultItem[]>(
      `${API_BASE_URL}/search?q=${encodeURIComponent('searchtarget')}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );

    expect(
      res.data.some((r) => r.resourceId === folder.id && r.resourceType === 'folder'),
    ).toBe(true);
  });

  it('does not return a folder the caller has no grant on', async () => {
    const folder = await prisma.folder.create({
      data: { name: `NoAccess-${randomUUID()}`, parentId: null, createdBy: 'seed' },
    });

    const token = await getToken('testuser', 'testpass');
    const res = await axios.get<SearchResultItem[]>(
      `${API_BASE_URL}/search?q=${encodeURIComponent('NoAccess')}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );

    expect(res.data.some((r) => r.resourceId === folder.id)).toBe(false);
  });

  it('excludes a soft-deleted folder even if the caller has manage access to it', async () => {
    const folder = await prisma.folder.create({
      data: {
        name: `DeletedTarget-${randomUUID()}`,
        parentId: null,
        createdBy: 'seed',
        deletedAt: new Date(),
      },
    });
    await prisma.permission.create({
      data: {
        resourceType: 'folder',
        resourceId: folder.id,
        principalType: 'user',
        principalId: testUserId,
        permissionLevel: 'manage',
        grantedBy: 'seed',
      },
    });

    const token = await getToken('testuser', 'testpass');
    const res = await axios.get<SearchResultItem[]>(
      `${API_BASE_URL}/search?q=${encodeURIComponent('DeletedTarget')}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );

    expect(res.data.some((r) => r.resourceId === folder.id)).toBe(false);
  });

  it('excludes a soft-deleted document', async () => {
    const folder = await prisma.folder.create({
      data: { name: `DocDeleteParent-${randomUUID()}`, parentId: null, createdBy: 'seed' },
    });
    const document = await prisma.document.create({
      data: {
        name: `DeletedDoc-${randomUUID()}`,
        folderId: folder.id,
        createdBy: 'seed',
        deletedAt: new Date(),
      },
    });
    await prisma.permission.create({
      data: {
        resourceType: 'document',
        resourceId: document.id,
        principalType: 'user',
        principalId: testUserId,
        permissionLevel: 'manage',
        grantedBy: 'seed',
      },
    });

    const token = await getToken('testuser', 'testpass');
    const res = await axios.get<SearchResultItem[]>(
      `${API_BASE_URL}/search?q=${encodeURIComponent('DeletedDoc')}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );

    expect(res.data.some((r) => r.resourceId === document.id)).toBe(false);
  });

  it('resolves the correct ancestor path for a nested folder match', async () => {
    const root = await prisma.folder.create({
      data: { name: `PathRoot-${randomUUID()}`, parentId: null, createdBy: 'seed' },
    });
    const child = await prisma.folder.create({
      data: { name: `PathChild-${randomUUID()}`, parentId: root.id, createdBy: 'seed' },
    });
    await prisma.permission.create({
      data: {
        resourceType: 'folder',
        resourceId: child.id,
        principalType: 'user',
        principalId: testUserId,
        permissionLevel: 'view',
        grantedBy: 'seed',
      },
    });

    const token = await getToken('testuser', 'testpass');
    const res = await axios.get<SearchResultItem[]>(
      `${API_BASE_URL}/search?q=${encodeURIComponent('PathChild')}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );

    const match = res.data.find((r) => r.resourceId === child.id);
    expect(match?.path).toBe(`Root / ${root.name}`);
  });

  it('returns an empty array for an empty or whitespace-only query', async () => {
    const token = await getToken('testuser', 'testpass');
    const res = await axios.get<SearchResultItem[]>(
      `${API_BASE_URL}/search?q=${encodeURIComponent('   ')}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );

    expect(res.data).toEqual([]);
  });

  it('lets an admin find any resource without an explicit grant', async () => {
    const folder = await prisma.folder.create({
      data: { name: `AdminFindable-${randomUUID()}`, parentId: null, createdBy: 'seed' },
    });

    const token = await getToken('testadmin', 'testadminpass');
    const res = await axios.get<SearchResultItem[]>(
      `${API_BASE_URL}/search?q=${encodeURIComponent('AdminFindable')}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );

    expect(res.data.some((r) => r.resourceId === folder.id)).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
pnpm --filter api exec jest --config ./test/jest-e2e.json test/search.e2e-spec.ts
```

Expected: FAIL — `GET /search` doesn't exist yet (404s / connection errors).

- [ ] **Step 3: Implement the service**

Create `apps/api/src/search/search.service.ts`:

```ts
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AclService } from '../acl/acl.service';

interface AuthenticatedUser {
  id: string;
  roles: string[];
}

export interface SearchResultItem {
  resourceType: 'folder' | 'document';
  resourceId: string;
  name: string;
  path: string;
}

const SEARCH_RESULT_LIMIT = 50;

@Injectable()
export class SearchService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly acl: AclService,
  ) {}

  async search(user: AuthenticatedUser, query: string): Promise<SearchResultItem[]> {
    const trimmed = query.trim();
    if (!trimmed) {
      return [];
    }

    const [folders, documents] = await Promise.all([
      this.prisma.folder.findMany({
        where: { name: { contains: trimmed, mode: 'insensitive' }, deletedAt: null },
        orderBy: { name: 'asc' },
      }),
      this.prisma.document.findMany({
        where: { name: { contains: trimmed, mode: 'insensitive' }, deletedAt: null },
        orderBy: { name: 'asc' },
      }),
    ]);

    const [folderAllowed, documentAllowed] = await Promise.all([
      Promise.all(folders.map((f) => this.acl.can(user, 'folder', f.id, 'view'))),
      Promise.all(documents.map((d) => this.acl.can(user, 'document', d.id, 'view'))),
    ]);

    const visibleFolders = folders.filter((_, i) => folderAllowed[i]);
    const visibleDocuments = documents.filter((_, i) => documentAllowed[i]);

    const [folderPaths, documentPaths] = await Promise.all([
      Promise.all(visibleFolders.map((f) => this.resolveFolderPath(f.parentId))),
      Promise.all(visibleDocuments.map((d) => this.resolveFolderPath(d.folderId))),
    ]);

    const results: SearchResultItem[] = [
      ...visibleFolders.map((f, i) => ({
        resourceType: 'folder' as const,
        resourceId: f.id,
        name: f.name,
        path: folderPaths[i],
      })),
      ...visibleDocuments.map((d, i) => ({
        resourceType: 'document' as const,
        resourceId: d.id,
        name: d.name,
        path: documentPaths[i],
      })),
    ];

    return results.slice(0, SEARCH_RESULT_LIMIT);
  }

  // Mirrors PermissionsService.resolveFolderPath exactly (ancestor path, "Root" prefix,
  // excludes the resource's own name) — kept as its own small copy here rather than a
  // shared helper, matching this codebase's convention of small per-module logic over
  // cross-module extraction for something this size.
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
}
```

- [ ] **Step 4: Implement the controller**

Create `apps/api/src/search/search.controller.ts`:

```ts
import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Request } from 'express';
import { SearchService } from './search.service';
import { UsersService } from '../users/users.service';

interface AuthenticatedRequest extends Request {
  user: { sub: string; email: string; name: string; roles: string[] };
}

@UseGuards(AuthGuard('jwt'))
@Controller()
export class SearchController {
  constructor(
    private readonly searchService: SearchService,
    private readonly usersService: UsersService,
  ) {}

  @Get('search')
  async search(@Req() req: AuthenticatedRequest, @Query('q') q?: string) {
    const user = await this.usersService.upsertFromToken(req.user);
    return this.searchService.search({ id: user.id, roles: req.user.roles }, q ?? '');
  }
}
```

- [ ] **Step 5: Implement the module**

Create `apps/api/src/search/search.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { SearchController } from './search.controller';
import { SearchService } from './search.service';
import { AclModule } from '../acl/acl.module';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [AclModule, UsersModule],
  controllers: [SearchController],
  providers: [SearchService],
})
export class SearchModule {}
```

- [ ] **Step 6: Register the module**

In `apps/api/src/app.module.ts`, add the import and register it:

```ts
import { SearchModule } from './search/search.module';
```

Add `SearchModule` to the `imports` array (anywhere alongside the other feature modules, e.g. right after `PermissionsModule`).

- [ ] **Step 7: Run to verify tests pass**

```bash
pnpm --filter api exec jest --config ./test/jest-e2e.json test/search.e2e-spec.ts
```

Expected: PASS, all 7 tests.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/search apps/api/src/app.module.ts apps/api/test/search.e2e-spec.ts
git commit -m "feat(api): add GET /search for folders and documents by name"
```

---

### Task 2: Frontend — `api/search.ts` client function

**Files:**
- Create: `apps/web/src/api/search.ts`
- Test: `apps/web/test/api/search.test.ts`

**Interfaces:**
- Produces: `SearchResultItem { resourceType: 'folder' | 'document'; resourceId: string; name: string; path: string }` (matches Task 1's backend shape exactly), `searchResources(query: string, accessToken: string): Promise<SearchResultItem[]>`. Tasks 3-4 both import from here.

- [ ] **Step 1: Write the failing test**

Create `apps/web/test/api/search.test.ts` (matches the `vi.stubGlobal('fetch', vi.fn())` mocking style already used throughout `apps/web/test/api/*.test.ts` — see `apps/web/test/api/folders.test.ts` for the exact pattern):

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { searchResources } from '../../src/api/search';

describe('search api', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  it('searchResources GETs /search with the URL-encoded query', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => [
        { resourceType: 'folder', resourceId: 'f1', name: 'Finance', path: 'Root' },
      ],
    } as Response);

    const result = await searchResources('finance report', 'fake-token');

    const [url] = vi.mocked(fetch).mock.calls[0];
    expect(url).toContain('/search?q=finance%20report');
    expect(result).toEqual([
      { resourceType: 'folder', resourceId: 'f1', name: 'Finance', path: 'Root' },
    ]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
pnpm --filter web exec vitest run test/api/search.test.ts
```

Expected: FAIL — the module doesn't exist yet.

- [ ] **Step 3: Implement**

Create `apps/web/src/api/search.ts`:

```ts
import { apiFetch } from './client';

export interface SearchResultItem {
  resourceType: 'folder' | 'document';
  resourceId: string;
  name: string;
  path: string;
}

export function searchResources(query: string, accessToken: string) {
  return apiFetch<SearchResultItem[]>(`/search?q=${encodeURIComponent(query)}`, accessToken);
}
```

- [ ] **Step 4: Run to verify tests pass**

```bash
pnpm --filter web exec vitest run test/api/search.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/api/search.ts apps/web/test/api/search.test.ts
git commit -m "feat(web): add searchResources API client function"
```

---

### Task 3: Frontend — Navbar search box

**Files:**
- Modify: `apps/web/src/components/Navbar.tsx`
- Test: `apps/web/test/components/Navbar.test.tsx`

**Interfaces:**
- Consumes: nothing new from earlier tasks (this task only navigates to `/search?q=...`; it doesn't call the search API itself — Task 4's `Search.tsx` does).
- Produces: nothing new consumed elsewhere — self-contained UI addition.

- [ ] **Step 1: Write the failing tests**

`apps/web/test/components/Navbar.test.tsx` already has its own `renderNavbar(child)` helper (not `renderWithProviders` — `Navbar` is a layout route rendering `<Outlet />`, so its test sets up `MemoryRouter` + `Routes` with `Navbar` as the layout and a nested child route at `/`). Extend that helper to also register a `/search` route, and add a small probe component so the test can assert both that navigation happened AND that the `q` param round-tripped correctly:

Add this import to the top of the file:
```tsx
import { MemoryRouter, Routes, Route, useSearchParams } from 'react-router-dom';
```
(`useSearchParams` is new; `MemoryRouter, Routes, Route` are already imported.)

Add this component near the existing `CrumbSettingChild`:
```tsx
function SearchProbe() {
  const [params] = useSearchParams();
  return <div>search results page: {params.get('q')}</div>;
}
```

Change the existing `renderNavbar` helper to also register the probe route:
```tsx
function renderNavbar(child: ReactNode = <div>page content</div>) {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route element={<Navbar />}>
          <Route path="/" element={child} />
          <Route path="/search" element={<SearchProbe />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}
```

Add these two tests to the existing `describe` block:

```tsx
  it('navigates to /search?q=... when a search term is submitted via Enter', async () => {
    renderNavbar();

    const input = screen.getByTestId('navbar-search-input');
    fireEvent.change(input, { target: { value: 'finance report' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() =>
      expect(screen.getByText('search results page: finance report')).toBeInTheDocument(),
    );
  });

  it('does not navigate when the search input is blank', async () => {
    renderNavbar();

    const input = screen.getByTestId('navbar-search-input');
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(screen.getByText('page content')).toBeInTheDocument();
    expect(screen.queryByText(/search results page/)).not.toBeInTheDocument();
  });
```

- [ ] **Step 2: Run to verify failure**

```bash
pnpm --filter web exec vitest run test/components/Navbar.test.tsx
```

Expected: FAIL — `navbar-search-input` doesn't exist yet.

- [ ] **Step 3: Implement**

In `apps/web/src/components/Navbar.tsx`, `Navbar.tsx` currently imports `{ Link, NavLink, Outlet }` from `'react-router-dom'` and `{ Folder }` from `'lucide-react'` — extend those same two import lines (don't add new, separate `import` statements for the same modules):

```tsx
import { Link, NavLink, Outlet, useNavigate } from 'react-router-dom';
```
```tsx
import { Folder, Search } from 'lucide-react';
```

Inside the `Navbar` component, add state and a submit handler:

```tsx
const navigate = useNavigate();
const [searchInput, setSearchInput] = useState('');

const submitSearch = () => {
  const trimmed = searchInput.trim();
  if (!trimmed) return;
  navigate(`/search?q=${encodeURIComponent(trimmed)}`);
};
```

In the JSX, add a search box between the existing `<nav>` (資料夾/權限管理 links) and the breadcrumb `<div data-testid="navbar-crumb">`, keeping the breadcrumb exactly as-is:

```tsx
<div className="flex w-56 shrink-0 items-center gap-1.5 rounded-md bg-primary-foreground/10 px-2.5 py-1.5">
  <button
    type="button"
    aria-label="搜尋"
    onClick={submitSearch}
    className="text-primary-foreground/70 hover:text-primary-foreground"
  >
    <Search className="h-4 w-4" />
  </button>
  <input
    data-testid="navbar-search-input"
    value={searchInput}
    onChange={(e) => setSearchInput(e.target.value)}
    onKeyDown={(e) => {
      if (e.key === 'Enter') submitSearch();
    }}
    placeholder="搜尋資料夾或文件..."
    className="w-full border-none bg-transparent text-sm text-primary-foreground placeholder:text-primary-foreground/50 focus:outline-none"
  />
</div>
```

- [ ] **Step 4: Run to verify tests pass**

```bash
pnpm --filter web exec vitest run test/components/Navbar.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/Navbar.tsx apps/web/test/components/Navbar.test.tsx
git commit -m "feat(web): add search box to Navbar"
```

---

### Task 4: Frontend — `/search` results page

**Files:**
- Create: `apps/web/src/routes/Search.tsx`
- Modify: `apps/web/src/App.tsx`
- Test: `apps/web/test/routes/Search.test.tsx`

**Interfaces:**
- Consumes: `searchResources` and `SearchResultItem` from `apps/web/src/api/search.ts` (Task 2).
- Produces: the `/search` route, registered in `App.tsx`. Nothing further consumes this route's internals.

- [ ] **Step 1: Write the failing tests**

Create `apps/web/test/routes/Search.test.tsx` (match the mocking/render style of `apps/web/test/routes/FolderView.test.tsx`: `vi.mock('react-oidc-context', ...)`, `renderWithProviders` from `../testUtils`):

```tsx
import { screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useAuth } from 'react-oidc-context';
import { Search } from '../../src/routes/Search';
import { searchResources } from '../../src/api/search';
import { renderWithProviders } from '../testUtils';

vi.mock('react-oidc-context', () => ({ useAuth: vi.fn() }));
vi.mock('../../src/api/search', () => ({ searchResources: vi.fn() }));

describe('Search', () => {
  beforeEach(() => {
    vi.mocked(useAuth).mockReturnValue({
      user: { access_token: 'fake-token' },
    } as unknown as ReturnType<typeof useAuth>);
  });

  it('shows a prompt and does not call the API when there is no query', async () => {
    renderWithProviders(<Search />, { route: '/search', path: '/search' });

    expect(screen.getByText('請輸入關鍵字搜尋')).toBeInTheDocument();
    expect(searchResources).not.toHaveBeenCalled();
  });

  it('calls searchResources with the URL query and shows results', async () => {
    vi.mocked(searchResources).mockResolvedValue([
      { resourceType: 'folder', resourceId: 'f1', name: 'Finance', path: 'Root' },
      {
        resourceType: 'document',
        resourceId: 'd1',
        name: 'report.pdf',
        path: 'Root / Finance',
      },
    ]);

    renderWithProviders(<Search />, { route: '/search?q=finance', path: '/search' });

    await waitFor(() => expect(screen.getByText('Finance')).toBeInTheDocument());
    expect(screen.getByText('Root')).toBeInTheDocument();
    expect(screen.getByText('report.pdf')).toBeInTheDocument();
    expect(screen.getByText('Root / Finance')).toBeInTheDocument();
    expect(searchResources).toHaveBeenCalledWith('finance', 'fake-token');
  });

  it('shows a not-found message when the query returns no results', async () => {
    vi.mocked(searchResources).mockResolvedValue([]);

    renderWithProviders(<Search />, { route: '/search?q=nothing', path: '/search' });

    await waitFor(() => expect(screen.getByText('找不到符合的項目')).toBeInTheDocument());
  });

  it('links a folder result to /folders/:id and a document result to /documents/:id', async () => {
    vi.mocked(searchResources).mockResolvedValue([
      { resourceType: 'folder', resourceId: 'f1', name: 'Finance', path: 'Root' },
      {
        resourceType: 'document',
        resourceId: 'd1',
        name: 'report.pdf',
        path: 'Root / Finance',
      },
    ]);

    renderWithProviders(<Search />, { route: '/search?q=finance', path: '/search' });

    await waitFor(() => expect(screen.getByText('Finance')).toBeInTheDocument());
    expect(screen.getByRole('link', { name: /Finance/ })).toHaveAttribute(
      'href',
      '/folders/f1',
    );
    expect(screen.getByRole('link', { name: /report\.pdf/ })).toHaveAttribute(
      'href',
      '/documents/d1',
    );
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
pnpm --filter web exec vitest run test/routes/Search.test.tsx
```

Expected: FAIL — the module doesn't exist yet.

- [ ] **Step 3: Implement**

Create `apps/web/src/routes/Search.tsx`:

```tsx
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from 'react-oidc-context';
import { Folder, FileText } from 'lucide-react';
import { searchResources } from '../api/search';
import { friendlyErrorMessage } from '../api/client';

export function Search() {
  const [searchParams] = useSearchParams();
  const query = searchParams.get('q') ?? '';
  const auth = useAuth();
  const accessToken = auth.user?.access_token ?? '';

  const searchQuery = useQuery({
    queryKey: ['search', query],
    queryFn: () => searchResources(query, accessToken),
    enabled: !!query.trim() && !!accessToken,
  });

  return (
    <div className="mx-auto max-w-4xl px-6 py-8">
      <h1 className="mb-6 text-xl font-bold">搜尋{query ? `：${query}` : ''}</h1>

      {!query.trim() && <p className="text-muted-foreground">請輸入關鍵字搜尋</p>}

      {query.trim() && searchQuery.isLoading && (
        <p data-testid="loading">Loading...</p>
      )}
      {query.trim() && searchQuery.isError && (
        <p data-testid="error">{friendlyErrorMessage(searchQuery.error)}</p>
      )}
      {query.trim() && searchQuery.data && searchQuery.data.length === 0 && (
        <p className="text-muted-foreground">找不到符合的項目</p>
      )}
      {query.trim() && searchQuery.data && searchQuery.data.length > 0 && (
        <ul className="overflow-hidden rounded-lg border bg-background">
          {searchQuery.data.map((item) => (
            <li key={`${item.resourceType}-${item.resourceId}`} className="border-b last:border-0">
              <Link
                to={
                  item.resourceType === 'folder'
                    ? `/folders/${item.resourceId}`
                    : `/documents/${item.resourceId}`
                }
                className="flex items-center gap-2.5 px-4 py-3 hover:bg-muted/50"
              >
                {item.resourceType === 'folder' ? (
                  <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
                ) : (
                  <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                )}
                <span>
                  <span className="block text-sm font-medium">{item.name}</span>
                  <span className="block text-xs text-muted-foreground">{item.path}</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Wire the route**

In `apps/web/src/App.tsx`, add the import:

```tsx
import { Search } from './routes/Search';
```

Add the route inside the existing `<Route element={<Navbar />}>` block, alongside the others:

```tsx
<Route path="/search" element={<Search />} />
```

- [ ] **Step 5: Run to verify tests pass**

```bash
pnpm --filter web exec vitest run test/routes/Search.test.tsx
```

Expected: PASS.

- [ ] **Step 6: Typecheck and run the full frontend suite**

```bash
pnpm --filter web exec tsc --noEmit
pnpm --filter web exec vitest run
```

Expected: no type errors, all suites pass.

- [ ] **Step 7: Run the full backend suite once more as a final cross-check**

```bash
pnpm --filter api exec jest
pnpm --filter api exec jest --config ./test/jest-e2e.json
```

Expected: all pass (the audit hash-chain suites are known to intermittently flake when run alongside many other e2e files under heavy load — if only those fail, re-run them alone to confirm before treating it as a regression).

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/routes/Search.tsx apps/web/src/App.tsx apps/web/test/routes/Search.test.tsx
git commit -m "feat(web): add /search results page"
```
