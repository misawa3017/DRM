# 檔案管理前端視覺改版（導覽列 + 內容區）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 幫 `apps/web` 加上常駐導覽列（品牌識別、麵包屑、使用者資訊/登出）、藍色品牌色，並優化資料夾/文件列表的視覺呈現（卡片、圖示、間距），取代目前完全無樣式的登出按鈕與純文字表格。

**Architecture:** 新增一個 React Context（`navbarBreadcrumb.tsx`）讓子路由把麵包屑內容送進常駐的 `Navbar`，`Navbar` 以 React Router v6 layout route（`<Route element={<Navbar />}>` + `<Outlet />`）包住三個既有路由，只掛載一次、不隨路由重新打 `/whoami`。內容區（`RootFolders`/`FolderView`/`DocumentView`）加上卡片外框、lucide-react 圖示、更寬鬆的表格間距，全部透過調整既有的 Tailwind class 與 `--primary`/`--ring` CSS 變數達成，不改資料層。

**Tech Stack:** React 18、react-router-dom 6（layout route + `Outlet`）、lucide-react（已是既有依賴）、Tailwind CSS（既有 shadcn 風格 `Table`/`Button` 元件）。

## Global Constraints

- Node >= 20、pnpm 9.7.0 workspace（`pnpm --filter web ...`）
- TypeScript `strict: true`（`apps/web/tsconfig.json`，不放寬）
- Prettier：`semi: true`、`singleQuote: true`、`trailingComma: "all"`、`printWidth: 100`、`tabWidth: 2`
- **這次改版不遵循逐 Task TDD**：Task 1-6 先完成實作，每個 Task 結束跑 `pnpm --filter web build` 確認沒有 TypeScript/build 錯誤；有改到既有邏輯的 Task 額外跑 `pnpm --filter web test` 確認既有測試沒有回歸。新測試全部集中在最後的 Task 7 一次寫齊——這是使用者對本輪工作明確要求的順序，跟第一階段的逐 Task TDD 規範不同
- `lucide-react`（`^0.446.0`）已經是既有依賴，不需要新增安裝
- 品牌色 token：`--primary: 217 58% 27%`、`--ring: 217 58% 27%`（對應深藍 `#1B3A6B`），其餘 CSS 變數不變
- 前端測試延續 Vitest + React Testing Library，斷言用 `data-testid`，互動一律用 `fireEvent`（不用 `@testing-library/user-event`）

---

### Task 1: `NavbarBreadcrumbContext` — 麵包屑 context 與 hooks

**Files:**
- Create: `apps/web/src/lib/navbarBreadcrumb.tsx`

**Interfaces:**
- Produces: `NavbarBreadcrumbContext`（React Context，預設值 `{ crumb: null, setCrumb: no-op }`，沒有 Provider 包裹時安全）、`useSetNavbarCrumb(node: ReactNode): void`，給 Task 2（`Navbar`，直接讀 `NavbarBreadcrumbContext` 本身管理的 state，不需要額外的讀取 hook）與 Task 4（`FolderView`，透過 `useSetNavbarCrumb` 寫入）消費

- [ ] **Step 1: 建立 `navbarBreadcrumb.tsx`**

Create `apps/web/src/lib/navbarBreadcrumb.tsx`:

```tsx
import { createContext, useContext, useEffect, type Dispatch, type ReactNode, type SetStateAction } from 'react';

interface NavbarBreadcrumbContextValue {
  crumb: ReactNode;
  setCrumb: Dispatch<SetStateAction<ReactNode>>;
}

export const NavbarBreadcrumbContext = createContext<NavbarBreadcrumbContextValue>({
  crumb: null,
  setCrumb: () => {},
});

export function useSetNavbarCrumb(node: ReactNode): void {
  const { setCrumb } = useContext(NavbarBreadcrumbContext);
  useEffect(() => {
    setCrumb(node);
    return () => setCrumb(null);
  }, [node, setCrumb]);
}
```

- [ ] **Step 2: 執行 build 確認沒有型別錯誤**

Run: `pnpm --filter web build`
Expected: 成功（這個檔案目前還沒有任何地方引用，純新增檔案不會影響既有 build）

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/lib/navbarBreadcrumb.tsx
git commit -m "feat(web): add NavbarBreadcrumbContext for cross-route breadcrumb slot"
```

---

### Task 2: `Navbar` 元件 + 品牌色 token

**Files:**
- Create: `apps/web/src/components/Navbar.tsx`
- Modify: `apps/web/src/index.css`

**Interfaces:**
- Consumes: `NavbarBreadcrumbContext`（Task 1）、`useAuth()`（`react-oidc-context`，既有）
- Produces: `Navbar(): JSX.Element`（內部渲染 `<Outlet />`，需要在 react-router 的 layout route 底下使用），給 Task 3（`App.tsx`）消費

- [ ] **Step 1: 更新品牌色 CSS 變數**

Modify `apps/web/src/index.css`, change the `--ring` and `--primary` lines inside `:root`:

```css
    --ring: 217 58% 27%;
    --primary: 217 58% 27%;
```

(原本分別是 `222.2 84% 4.9%` 和 `222.2 47.4% 11.2%`，其餘變數不動)

- [ ] **Step 2: 建立 `Navbar.tsx`**

Create `apps/web/src/components/Navbar.tsx`:

```tsx
import { useEffect, useState, type ReactNode } from 'react';
import { Link, Outlet } from 'react-router-dom';
import { useAuth } from 'react-oidc-context';
import { Folder } from 'lucide-react';
import { NavbarBreadcrumbContext } from '../lib/navbarBreadcrumb';

interface WhoAmI {
  id: string;
  email: string;
  displayName: string;
  roles: string[];
}

export function Navbar() {
  const auth = useAuth();
  const accessToken = auth.user?.access_token ?? '';
  const [whoami, setWhoami] = useState<WhoAmI | null>(null);
  const [crumb, setCrumb] = useState<ReactNode>(null);

  useEffect(() => {
    if (!accessToken) return;
    fetch(`${import.meta.env.VITE_API_BASE_URL}/whoami`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
      .then((res) => {
        if (!res.ok) throw new Error(`Request failed: ${res.status}`);
        return res.json();
      })
      .then(setWhoami)
      .catch(() => setWhoami(null));
  }, [accessToken]);

  return (
    <NavbarBreadcrumbContext.Provider value={{ crumb, setCrumb }}>
      <header className="flex items-center justify-between gap-4 bg-primary px-6 py-3 text-primary-foreground">
        <Link
          to="/"
          className="flex shrink-0 items-center gap-2 text-base font-semibold"
          data-testid="navbar-brand"
        >
          <span className="flex h-7 w-7 items-center justify-center rounded-md bg-primary-foreground text-primary">
            <Folder className="h-4 w-4" />
          </span>
          DRM
        </Link>

        <div
          className="flex min-w-0 flex-1 items-center justify-center gap-1 text-sm"
          data-testid="navbar-crumb"
        >
          {crumb}
        </div>

        <div className="flex shrink-0 items-center gap-3 text-sm">
          {whoami && (
            <>
              <span
                className="rounded-full bg-primary-foreground/15 px-2.5 py-0.5 text-xs"
                data-testid="navbar-roles"
              >
                {whoami.roles.join(', ')}
              </span>
              <span data-testid="navbar-username">{whoami.displayName}</span>
            </>
          )}
          <button
            onClick={() => auth.signoutRedirect()}
            className="rounded-md bg-primary-foreground px-3 py-1.5 text-xs font-semibold text-primary"
            data-testid="navbar-logout"
          >
            登出
          </button>
        </div>
      </header>
      <Outlet />
    </NavbarBreadcrumbContext.Provider>
  );
}
```

- [ ] **Step 3: 執行 build 確認沒有型別錯誤**

Run: `pnpm --filter web build`
Expected: 成功（`Navbar` 目前還沒被 `App.tsx` 引用，但檔案本身必須能獨立編譯過）

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/Navbar.tsx apps/web/src/index.css
git commit -m "feat(web): add Navbar component and blue brand color tokens"
```

---

### Task 3: 改造 `App.tsx` 為 layout route，移除 `Home.tsx`

**Files:**
- Modify: `apps/web/src/App.tsx`
- Delete: `apps/web/src/Home.tsx`
- Delete: `apps/web/test/Home.test.tsx`

**Interfaces:**
- Consumes: `Navbar`（Task 2）
- Produces: `App.tsx` 的已登入分支改為 `<Route element={<Navbar />}>` 包住三個既有路由；`Home`/`whoami` 顯示邏輯已併入 `Navbar`，`Home.tsx` 不再存在

- [ ] **Step 1: 改寫 `App.tsx`**

Replace the full contents of `apps/web/src/App.tsx`:

```tsx
import { useAuth } from 'react-oidc-context';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { MaintenanceNotice } from './MaintenanceNotice';
import { Navbar } from './components/Navbar';
import { RootFolders } from './routes/RootFolders';
import { FolderView } from './routes/FolderView';
import { DocumentView } from './routes/DocumentView';

export default function App() {
  const auth = useAuth();

  if (auth.isLoading) {
    return (
      <>
        <MaintenanceNotice />
        <p>Loading...</p>
      </>
    );
  }
  if (auth.error) {
    return (
      <>
        <MaintenanceNotice />
        <p>Auth error: {auth.error.message}</p>
      </>
    );
  }

  if (!auth.isAuthenticated) {
    return (
      <>
        <MaintenanceNotice />
        <button onClick={() => auth.signinRedirect()}>Log in</button>
      </>
    );
  }

  return (
    <BrowserRouter>
      <MaintenanceNotice />
      <Routes>
        <Route element={<Navbar />}>
          <Route path="/" element={<RootFolders />} />
          <Route path="/folders/:id" element={<FolderView />} />
          <Route path="/documents/:id" element={<DocumentView />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
```

- [ ] **Step 2: 刪除 `Home.tsx` 與其測試**

```bash
git rm apps/web/src/Home.tsx apps/web/test/Home.test.tsx
```

- [ ] **Step 3: 執行 build 與既有測試，確認沒有回歸**

Run: `pnpm --filter web build`
Expected: 成功，沒有找不到 `./Home` 之類的殘留引用錯誤

Run: `pnpm --filter web test`
Expected: 全部 PASS（`App.test.tsx` 只測登出狀態不受影響；`Home.test.tsx` 已刪除不會再跑；其他既有測試檔案不引用 `Home`，不受影響）

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/App.tsx
git commit -m "feat(web): wire Navbar as a layout route, remove raw logout button and Home whoami dump"
```

---

### Task 4: `Breadcrumb` 深色底樣式 + `FolderView` 改用 `useSetNavbarCrumb`

**Files:**
- Modify: `apps/web/src/components/Breadcrumb.tsx`
- Modify: `apps/web/src/routes/FolderView.tsx`

**Interfaces:**
- Consumes: `useSetNavbarCrumb`（Task 1）
- Produces: `FolderView` 不再自己 render `<Breadcrumb />`，改為把它送進 `Navbar` 的麵包屑 slot

- [ ] **Step 1: 調整 `Breadcrumb.tsx` 樣式（改為深色底可讀）**

Replace the full contents of `apps/web/src/components/Breadcrumb.tsx`:

```tsx
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from 'react-oidc-context';
import { getFolder } from '../api/folders';

interface Crumb {
  id: string;
  name: string;
}

function useAncestors(parentId: string | null, accessToken: string) {
  const queryClient = useQueryClient();
  return useQuery({
    queryKey: ['ancestors', parentId],
    queryFn: async () => {
      const chain: Crumb[] = [];
      let currentParentId = parentId;
      while (currentParentId) {
        const id = currentParentId;
        const folder = await queryClient.fetchQuery({
          queryKey: ['folder', id],
          queryFn: () => getFolder(id, accessToken),
        });
        chain.unshift({ id: folder.id, name: folder.name });
        currentParentId = folder.parentId;
      }
      return chain;
    },
  });
}

interface BreadcrumbProps {
  currentId: string;
  currentName: string;
  parentId: string | null;
}

export function Breadcrumb({ currentId, currentName, parentId }: BreadcrumbProps) {
  const auth = useAuth();
  const accessToken = auth.user?.access_token ?? '';
  const ancestors = useAncestors(parentId, accessToken);

  return (
    <nav aria-label="breadcrumb" className="flex items-center gap-1 text-primary-foreground/80">
      <Link to="/" className="hover:text-primary-foreground hover:underline">
        Root
      </Link>
      {ancestors.data?.map((crumb) => (
        <span key={crumb.id} className="flex items-center gap-1">
          <span className="opacity-60">/</span>
          <Link
            to={`/folders/${crumb.id}`}
            className="hover:text-primary-foreground hover:underline"
          >
            {crumb.name}
          </Link>
        </span>
      ))}
      <span className="opacity-60">/</span>
      <span key={currentId} className="font-medium text-primary-foreground">
        {currentName}
      </span>
    </nav>
  );
}
```

- [ ] **Step 2: `FolderView.tsx` 改用 `useSetNavbarCrumb`**

Replace the full contents of `apps/web/src/routes/FolderView.tsx`:

```tsx
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from 'react-oidc-context';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { getFolder } from '../api/folders';
import { friendlyErrorMessage } from '../api/client';
import { Breadcrumb } from '../components/Breadcrumb';
import { CreateFolderDialog } from '../components/CreateFolderDialog';
import { UploadDialog } from '../components/UploadDialog';
import { useSetNavbarCrumb } from '../lib/navbarBreadcrumb';

export function FolderView() {
  const { id } = useParams<{ id: string }>();
  const auth = useAuth();
  const accessToken = auth.user?.access_token ?? '';
  const folderId = id ?? '';

  const query = useQuery({
    queryKey: ['folder', folderId],
    queryFn: () => getFolder(folderId, accessToken),
    enabled: !!folderId,
  });

  const folder = query.data;
  useSetNavbarCrumb(
    folder ? (
      <Breadcrumb currentId={folder.id} currentName={folder.name} parentId={folder.parentId} />
    ) : null,
  );

  if (query.isLoading) return <p data-testid="loading">Loading...</p>;
  if (query.isError) return <p data-testid="error">{friendlyErrorMessage(query.error)}</p>;
  if (!folder) return null;

  return (
    <div>
      <h1>{folder.name}</h1>
      <CreateFolderDialog parentId={folder.id} />
      <UploadDialog mode="new-document" folderId={folder.id} />

      <h2>子資料夾</h2>
      <Table>
        <TableBody>
          {folder.children.map((child) => (
            <TableRow key={child.id}>
              <TableCell>
                <Link to={`/folders/${child.id}`}>{child.name}</Link>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      <h2>文件</h2>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>名稱</TableHead>
            <TableHead>目前版本</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {folder.documents.map((document) => (
            <TableRow key={document.id}>
              <TableCell>
                <Link to={`/documents/${document.id}`}>{document.name}</Link>
              </TableCell>
              <TableCell>
                {document.currentVersion ? `v${document.currentVersion.versionNumber}` : '—'}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
```

(這一步只搬動麵包屑的掛載方式，表格/卡片視覺留到 Task 5 一起做，避免這步的 diff 混雜兩種改動)

- [ ] **Step 3: 執行 build 與既有測試，確認沒有回歸**

Run: `pnpm --filter web build`
Expected: 成功

Run: `pnpm --filter web test -- FolderView.test.tsx Breadcrumb.test.tsx`
Expected: 全部 PASS（`FolderView.test.tsx` 沒有 Provider 包裹時，`useSetNavbarCrumb` 用 context 預設值安全 no-op，既有斷言只看子資料夾/文件連結，不受影響；`Breadcrumb.test.tsx` 只斷言連結文字與順序，不受 className 調整影響）

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/Breadcrumb.tsx apps/web/src/routes/FolderView.tsx
git commit -m "feat(web): move Breadcrumb into the Navbar's breadcrumb slot"
```

---

### Task 5: 內容區視覺優化（卡片、圖示、間距）

**Files:**
- Modify: `apps/web/src/components/ui/table.tsx`
- Modify: `apps/web/src/routes/RootFolders.tsx`
- Modify: `apps/web/src/routes/FolderView.tsx`
- Modify: `apps/web/src/routes/DocumentView.tsx`

**Interfaces:**
- 不新增/修改任何 exported 型別或函式簽章，純視覺調整

- [ ] **Step 1: `table.tsx` 間距加大**

In `apps/web/src/components/ui/table.tsx`, replace the `TableHead` and `TableCell` definitions:

```tsx
const TableHead = React.forwardRef<
  HTMLTableCellElement,
  React.ThHTMLAttributes<HTMLTableCellElement>
>(({ className, ...props }, ref) => (
  <th
    ref={ref}
    className={cn('px-5 py-3 text-left align-middle font-medium text-muted-foreground', className)}
    {...props}
  />
));
TableHead.displayName = 'TableHead';

const TableCell = React.forwardRef<
  HTMLTableCellElement,
  React.TdHTMLAttributes<HTMLTableCellElement>
>(({ className, ...props }, ref) => (
  <td ref={ref} className={cn('px-5 py-3.5 align-middle', className)} {...props} />
));
TableCell.displayName = 'TableCell';
```

(原本分別是 `h-10 px-2 text-left align-middle font-medium text-muted-foreground` 和 `p-2 align-middle`)

- [ ] **Step 2: `RootFolders.tsx` 加卡片、圖示、置中版面**

Replace the full contents of `apps/web/src/routes/RootFolders.tsx`:

```tsx
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from 'react-oidc-context';
import { Folder } from 'lucide-react';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { listRootFolders } from '../api/folders';
import { friendlyErrorMessage } from '../api/client';
import { CreateFolderDialog } from '../components/CreateFolderDialog';
import { getRolesFromToken } from '../lib/jwt';

export function RootFolders() {
  const auth = useAuth();
  const accessToken = auth.user?.access_token ?? '';
  const isAdmin = getRolesFromToken(accessToken).includes('admin');

  const query = useQuery({
    queryKey: ['rootFolders'],
    queryFn: () => listRootFolders(accessToken),
    enabled: !!accessToken,
  });

  if (query.isLoading) return <p data-testid="loading">Loading...</p>;
  if (query.isError) return <p data-testid="error">{friendlyErrorMessage(query.error)}</p>;

  const folders = query.data ?? [];

  return (
    <div className="mx-auto max-w-4xl px-6 py-8">
      <div className="mb-6 flex items-center justify-between gap-3">
        <h1 className="text-xl font-bold">資料夾</h1>
        {isAdmin && <CreateFolderDialog parentId={null} />}
      </div>
      {folders.length === 0 ? (
        <div
          className="rounded-lg border bg-background p-12 text-center text-muted-foreground"
          data-testid="empty"
        >
          <Folder className="mx-auto mb-3 h-8 w-8 text-muted-foreground/40" />
          <p>目前沒有你可以存取的資料夾，請聯絡管理員</p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border bg-background">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>名稱</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {folders.map((folder) => (
                <TableRow key={folder.id}>
                  <TableCell>
                    <Link to={`/folders/${folder.id}`} className="flex items-center gap-2">
                      <Folder className="h-4 w-4 text-muted-foreground" />
                      {folder.name}
                    </Link>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: `FolderView.tsx` 加卡片、圖示、置中版面**

Replace the full contents of `apps/web/src/routes/FolderView.tsx`:

```tsx
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from 'react-oidc-context';
import { Folder, FileText } from 'lucide-react';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { getFolder } from '../api/folders';
import { friendlyErrorMessage } from '../api/client';
import { Breadcrumb } from '../components/Breadcrumb';
import { CreateFolderDialog } from '../components/CreateFolderDialog';
import { UploadDialog } from '../components/UploadDialog';
import { useSetNavbarCrumb } from '../lib/navbarBreadcrumb';

export function FolderView() {
  const { id } = useParams<{ id: string }>();
  const auth = useAuth();
  const accessToken = auth.user?.access_token ?? '';
  const folderId = id ?? '';

  const query = useQuery({
    queryKey: ['folder', folderId],
    queryFn: () => getFolder(folderId, accessToken),
    enabled: !!folderId,
  });

  const folder = query.data;
  useSetNavbarCrumb(
    folder ? (
      <Breadcrumb currentId={folder.id} currentName={folder.name} parentId={folder.parentId} />
    ) : null,
  );

  if (query.isLoading) return <p data-testid="loading">Loading...</p>;
  if (query.isError) return <p data-testid="error">{friendlyErrorMessage(query.error)}</p>;
  if (!folder) return null;

  return (
    <div className="mx-auto max-w-4xl px-6 py-8">
      <div className="mb-6 flex items-center justify-between gap-3">
        <h1 className="text-xl font-bold">{folder.name}</h1>
        <div className="flex gap-2">
          <CreateFolderDialog parentId={folder.id} />
          <UploadDialog mode="new-document" folderId={folder.id} />
        </div>
      </div>

      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        子資料夾
      </h2>
      <div className="mb-8 overflow-hidden rounded-lg border bg-background">
        <Table>
          <TableBody>
            {folder.children.map((child) => (
              <TableRow key={child.id}>
                <TableCell>
                  <Link to={`/folders/${child.id}`} className="flex items-center gap-2">
                    <Folder className="h-4 w-4 text-muted-foreground" />
                    {child.name}
                  </Link>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        文件
      </h2>
      <div className="overflow-hidden rounded-lg border bg-background">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>名稱</TableHead>
              <TableHead>目前版本</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {folder.documents.map((document) => (
              <TableRow key={document.id}>
                <TableCell>
                  <Link to={`/documents/${document.id}`} className="flex items-center gap-2">
                    <FileText className="h-4 w-4 text-muted-foreground" />
                    {document.name}
                  </Link>
                </TableCell>
                <TableCell>
                  {document.currentVersion ? `v${document.currentVersion.versionNumber}` : '—'}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: `DocumentView.tsx` 加卡片、圖示、置中版面**

Replace the full contents of `apps/web/src/routes/DocumentView.tsx`:

```tsx
import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from 'react-oidc-context';
import { FileText } from 'lucide-react';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { getDocument, listVersions, downloadDocument } from '../api/documents';
import { friendlyErrorMessage } from '../api/client';
import { UploadDialog } from '../components/UploadDialog';

export function DocumentView() {
  const { id } = useParams<{ id: string }>();
  const auth = useAuth();
  const accessToken = auth.user?.access_token ?? '';
  const documentId = id ?? '';

  const documentQuery = useQuery({
    queryKey: ['document', documentId],
    queryFn: () => getDocument(documentId, accessToken),
    enabled: !!documentId,
  });
  const versionsQuery = useQuery({
    queryKey: ['documentVersions', documentId],
    queryFn: () => listVersions(documentId, accessToken),
    enabled: !!documentId,
  });

  const handleDownload = async (versionId?: string) => {
    const { blob, fileName } = await downloadDocument(documentId, versionId, accessToken);
    const url = URL.createObjectURL(blob);
    const link = window.document.createElement('a');
    link.href = url;
    link.download = fileName;
    link.click();
    URL.revokeObjectURL(url);
  };

  if (documentQuery.isLoading) return <p data-testid="loading">Loading...</p>;
  if (documentQuery.isError) {
    return <p data-testid="error">{friendlyErrorMessage(documentQuery.error)}</p>;
  }

  const doc = documentQuery.data!;

  return (
    <div className="mx-auto max-w-4xl px-6 py-8">
      <div className="mb-6 overflow-hidden rounded-lg border bg-background">
        <div className="flex items-center justify-between gap-3 border-b px-5 py-4">
          <h1 className="flex items-center gap-2 text-lg font-semibold">
            <FileText className="h-5 w-5 text-muted-foreground" />
            {doc.name}
          </h1>
          <div className="flex gap-2">
            <Button data-testid="download-current" onClick={() => handleDownload()}>
              下載目前版本
            </Button>
            <UploadDialog mode="new-version" documentId={documentId} />
          </div>
        </div>
      </div>

      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        版本歷史
      </h2>
      {versionsQuery.isLoading && <p data-testid="versions-loading">Loading versions...</p>}
      {versionsQuery.isError && (
        <p data-testid="versions-error">{friendlyErrorMessage(versionsQuery.error)}</p>
      )}
      {versionsQuery.data && (
        <div className="overflow-hidden rounded-lg border bg-background">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>版本</TableHead>
                <TableHead>大小（bytes）</TableHead>
                <TableHead>上傳者</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {versionsQuery.data.map((version) => (
                <TableRow key={version.id}>
                  <TableCell>v{version.versionNumber}</TableCell>
                  <TableCell>{version.sizeBytes}</TableCell>
                  <TableCell>{version.uploadedBy}</TableCell>
                  <TableCell>
                    <Button
                      data-testid={`download-version-${version.id}`}
                      onClick={() => handleDownload(version.id)}
                    >
                      下載此版本
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 5: 執行 build 與既有測試，確認沒有回歸**

Run: `pnpm --filter web build`
Expected: 成功

Run: `pnpm --filter web test`
Expected: 全部既有測試 PASS（RootFolders/FolderView/DocumentView 的既有斷言都只看連結文字、`data-testid`，不看 class name，卡片外框與圖示不影響這些斷言）

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/ui/table.tsx apps/web/src/routes/RootFolders.tsx apps/web/src/routes/FolderView.tsx apps/web/src/routes/DocumentView.tsx
git commit -m "feat(web): add card wrapper, type icons, and spacing to folder/document lists"
```

---

### Task 6: 手動瀏覽器驗證

**Files:** 無程式碼異動

- [ ] **Step 1: 重新建置並部署 `web` container**

```bash
docker compose -p drm build web
docker compose -p drm up -d web
```

- [ ] **Step 2: 用 `testadmin`/`testadminpass` 登入驗證**

開 `https://app.drm.apower.lan`，登入後確認：
- 導覽列是深藍底，最左邊有白底方塊 + 資料夾圖示 + "DRM" 文字，點擊會導回 `/`
- 導覽列最右邊依序是角色標籤（`admin`）、`Test Admin`、登出按鈕
- 首頁（`/`）導覽列中間沒有麵包屑；進入一個資料夾後，導覽列中間出現 `Root / <資料夾名稱>` 麵包屑，點擊 `Root` 能回首頁
- 資料夾/文件清單包在有邊框的卡片裡，每個項目名稱前面有對應的資料夾/文件圖示，滑鼠移過去整列有淺色高亮
- 沒有任何資料夾時，顯示置中的圖示 + 「目前沒有你可以存取的資料夾，請聯絡管理員」，不是孤零零一行字
- 建立資料夾、上傳文件、上傳新版本、下載（目前版本與舊版本）全部照舊可以正常操作（這次沒有動任何資料邏輯）

- [ ] **Step 3: 用 `testuser`/`testpass` 登入驗證**

確認：
- 首頁導覽列一樣正常顯示（角色標籤顯示 `employee`），但因為沒有任何授權，看不到「新增資料夾」按鈕，內容區顯示空狀態卡片
- 登出按鈕正常運作，回到登入前畫面

---

### Task 6.1: 登入前畫面套用品牌風格（使用者驗收 Task 6 時追加的範疇）

**Files:**
- Modify: `apps/web/src/App.tsx`

**Interfaces:**
- 不新增/修改任何 exported 型別或函式簽章，純視覺調整；沿用既有 `Button`（`@/components/ui/button`，Task 2 起已是藍色品牌色）

**背景：** Task 3 改造 `App.tsx` 時，只處理了已登入分支，未登入/載入中/錯誤三個分支維持原本裸 `<button>`/純文字，使用者在驗收 Task 6 時指出這幾個畫面看起來還是沒套上這次的品牌風格。這個 Task 補上。

- [ ] **Step 1: 改寫 `App.tsx`，未登入三分支套用置中版面 + 品牌標記 + `Button`**

Replace the full contents of `apps/web/src/App.tsx`:

```tsx
import type { ReactNode } from 'react';
import { useAuth } from 'react-oidc-context';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { Folder } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { MaintenanceNotice } from './MaintenanceNotice';
import { Navbar } from './components/Navbar';
import { RootFolders } from './routes/RootFolders';
import { FolderView } from './routes/FolderView';
import { DocumentView } from './routes/DocumentView';

function AuthScreen({ children }: { children: ReactNode }) {
  return (
    <>
      <MaintenanceNotice />
      <div className="flex min-h-[80vh] flex-col items-center justify-center gap-4 px-6 text-center">
        <span className="flex h-12 w-12 items-center justify-center rounded-lg bg-primary text-primary-foreground">
          <Folder className="h-6 w-6" />
        </span>
        <span className="text-lg font-semibold">DRM</span>
        {children}
      </div>
    </>
  );
}

export default function App() {
  const auth = useAuth();

  if (auth.isLoading) {
    return (
      <AuthScreen>
        <p className="text-sm text-muted-foreground">Loading...</p>
      </AuthScreen>
    );
  }
  if (auth.error) {
    return (
      <AuthScreen>
        <p className="text-sm text-destructive">Auth error: {auth.error.message}</p>
      </AuthScreen>
    );
  }

  if (!auth.isAuthenticated) {
    return (
      <AuthScreen>
        <Button onClick={() => auth.signinRedirect()}>Log in</Button>
      </AuthScreen>
    );
  }

  return (
    <BrowserRouter>
      <MaintenanceNotice />
      <Routes>
        <Route element={<Navbar />}>
          <Route path="/" element={<RootFolders />} />
          <Route path="/folders/:id" element={<FolderView />} />
          <Route path="/documents/:id" element={<DocumentView />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
```

注意：`Button` 渲染的仍然是原生 `<button>`，accessible name 仍然是 `"Log in"`，`test/App.test.tsx` 既有斷言（`getByRole('button', { name: 'Log in' })`、`getByText(/03:00/)`、`getByText(/例行維護/)`）不受影響，不需要修改測試。

- [ ] **Step 2: 執行 build 與既有測試，確認沒有回歸**

Run: `pnpm --filter web build`
Expected: 成功

Run: `pnpm --filter web test -- App.test.tsx`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/App.tsx
git commit -m "feat(web): apply brand styling to the pre-login/loading/error screens"
```

---

### Task 7: 補齊測試

**Files:**
- Create: `apps/web/test/components/Navbar.test.tsx`
- Modify: `apps/web/test/App.test.tsx`

**Interfaces:**
- 不新增新的 exported 介面，純測試覆蓋

- [ ] **Step 1: 寫 `Navbar.test.tsx`**

Create `apps/web/test/components/Navbar.test.tsx`:

```tsx
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { useAuth } from 'react-oidc-context';
import { Navbar } from '../../src/components/Navbar';

vi.mock('react-oidc-context', () => ({ useAuth: vi.fn() }));

function renderNavbar() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route element={<Navbar />}>
          <Route path="/" element={<div>page content</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe('Navbar', () => {
  const signoutRedirect = vi.fn();

  beforeEach(() => {
    signoutRedirect.mockClear();
    vi.mocked(useAuth).mockReturnValue({
      user: { access_token: 'fake-token' },
      signoutRedirect,
    } as unknown as ReturnType<typeof useAuth>);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          id: '1',
          email: 'admin@example.com',
          displayName: 'Test Admin',
          roles: ['admin'],
        }),
      } as Response),
    );
  });

  it('renders the brand mark, user info from /whoami, and routed page content', async () => {
    renderNavbar();

    expect(screen.getByTestId('navbar-brand')).toHaveTextContent('DRM');
    expect(screen.getByText('page content')).toBeInTheDocument();

    await waitFor(() => expect(screen.getByTestId('navbar-username')).toHaveTextContent('Test Admin'));
    expect(screen.getByTestId('navbar-roles')).toHaveTextContent('admin');
  });

  it('calls signoutRedirect when the logout button is clicked', async () => {
    renderNavbar();

    fireEvent.click(screen.getByTestId('navbar-logout'));

    expect(signoutRedirect).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: 執行測試確認通過**

Run: `pnpm --filter web test -- Navbar.test.tsx`
Expected: PASS

- [ ] **Step 3: 補 `App.test.tsx` 的登入後案例**

Modify `apps/web/test/App.test.tsx`, add a new test after the existing one (keep the existing logged-out test unchanged):

```tsx
  it('renders the Navbar and RootFolders route once authenticated', () => {
    vi.mocked(useAuth).mockReturnValue({
      isLoading: false,
      error: undefined,
      isAuthenticated: true,
      user: { access_token: 'fake-token' },
      signinRedirect: vi.fn(),
      signoutRedirect: vi.fn(),
    } as unknown as ReturnType<typeof useAuth>);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401 } as Response));

    render(<App />);

    expect(screen.getByTestId('navbar-brand')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '資料夾' })).toBeInTheDocument();
  });
```

(`fetch` 被 mock 成 401 是因為這個測試沒有要驗證資料內容，只確認 layout route 有把 `Navbar` 跟 `RootFolders` 都掛上去；`RootFolders` 自己的 `listRootFolders` 呼叫失敗會顯示 `data-testid="error"`，不影響這裡要驗證的 `navbar-brand` 和標題)

- [ ] **Step 4: 執行測試確認通過**

Run: `pnpm --filter web test -- App.test.tsx`
Expected: PASS（含原本的登出前案例）

- [ ] **Step 5: 執行完整前端測試套件與 build，確認全部通過**

Run: `pnpm --filter web test`
Expected: 全部 PASS

Run: `pnpm --filter web build`
Expected: 成功

- [ ] **Step 6: Commit**

```bash
git add apps/web/test/components/Navbar.test.tsx apps/web/test/App.test.tsx
git commit -m "test(web): add Navbar coverage and an authenticated App.tsx case"
```
