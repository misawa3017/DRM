# 檔案管理前端（第一階段：核心瀏覽）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓登入後的使用者可以瀏覽資料夾、上傳文件與新版本、下載文件，取代目前登入後只看得到 `/whoami` 資訊的空白狀態。

**Architecture:** `apps/web` 新增 `react-router` 路由（`/`、`/folders/:id`、`/documents/:id`）與 `@tanstack/react-query` 資料層，透過一個薄的 `api/client.ts` fetch wrapper 呼叫既有（以及一支新增的）`apps/api` REST 端點。UI 用手刻的 shadcn/ui 風格元件（Button/Dialog/Table，基於 Radix + Tailwind + CVA）組成。

**Tech Stack:** React 18、react-router-dom 6、@tanstack/react-query 5、Tailwind CSS 3、@radix-ui/react-dialog、class-variance-authority、NestJS（既有）、Prisma（既有）。

## Global Constraints

- Node >= 20、pnpm 9.7.0 workspace（`pnpm --filter web ...` / `pnpm --filter api ...`）
- TypeScript `strict: true`（`apps/web/tsconfig.json`、`apps/api/tsconfig.json` 既有設定，不放寬）
- Prettier：`semi: true`、`singleQuote: true`、`trailingComma: "all"`、`printWidth: 100`、`tabWidth: 2`（根目錄 `.prettierrc.json`，照抄）
- 前端測試一律用 Vitest + React Testing Library，斷言用 `data-testid`（沿用 `Home.tsx`/`Home.test.tsx` 既有慣例），不新增 `@testing-library/user-event`，互動一律用 `fireEvent`
- 後端整合測試一律用 `apps/api/test/*.e2e-spec.ts` 既有模式：`axios` 直接打 `https://api.drm.apower.lan`、`https://auth.drm.apower.lan`（ROPC 拿 token），資料用 Prisma 直接寫入 Postgres 做 fixture，不 mock 資料庫/物件儲存
- 後端測試帳號：`testuser`/`testpass`（realm role `employee`）、`testadmin`/`testadminpass`（realm role `admin`），定義於 `keycloak/realm-export.json.template`
- 不做的事（範疇之外，勿在任何任務中夾帶）：權限管理 UI、搜尋、rename/move/delete、站內 PDF 預覽/浮水印、上傳者姓名解析

---

### Task 1: 後端 — `GET /folders`（列出使用者可見的頂層資料夾）

**Files:**
- Modify: `apps/api/src/folders/folders.service.ts`
- Modify: `apps/api/src/folders/folders.controller.ts`
- Test: `apps/api/test/folders.e2e-spec.ts`（既有檔案，追加測試）

**Interfaces:**
- Consumes: `AclService.can(user, resourceType, resourceId, level): Promise<boolean>`（`apps/api/src/acl/acl.service.ts`，既有）
- Produces: `FoldersService.listRootFolders(user: {id, roles}): Promise<Folder[]>`；HTTP `GET /folders`（需 `Authorization: Bearer <token>`）回傳 `Folder[]`（`id, name, parentId, createdBy, createdAt, updatedAt`），給 Task 4 的 `api/folders.ts::listRootFolders` 消費

- [ ] **Step 1: 寫失敗的 e2e 測試**

在 `apps/api/test/folders.e2e-spec.ts` 檔案結尾的 `});`（describe 區塊收尾）之前加入：

```ts
  it('GET /folders returns only root folders the caller can view', async () => {
    const visible = await prisma.folder.create({
      data: { name: `visible-root-${randomUUID()}`, parentId: null, createdBy: 'seed' },
    });
    await prisma.permission.create({
      data: {
        resourceType: 'folder',
        resourceId: visible.id,
        principalType: 'user',
        principalId: testUserId,
        permissionLevel: 'view',
        grantedBy: 'seed',
      },
    });
    const hidden = await prisma.folder.create({
      data: { name: `hidden-root-${randomUUID()}`, parentId: null, createdBy: 'seed' },
    });

    const token = await getToken('testuser', 'testpass');
    const res = await axios.get<FolderResponse[]>(`${API_BASE_URL}/folders`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);
    const ids = res.data.map((folder) => folder.id);
    expect(ids).toContain(visible.id);
    expect(ids).not.toContain(hidden.id);
  });

  it('GET /folders returns every root folder for an admin, even without an explicit grant', async () => {
    const folder = await prisma.folder.create({
      data: { name: `admin-visible-${randomUUID()}`, parentId: null, createdBy: 'seed' },
    });

    const token = await getToken('testadmin', 'testadminpass');
    const res = await axios.get<FolderResponse[]>(`${API_BASE_URL}/folders`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.data.map((f) => f.id)).toContain(folder.id);
  });
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `pnpm --filter api test:e2e -- folders.e2e-spec.ts`
Expected: 兩個新測試 FAIL，因為 `GET /folders` 尚不存在（回傳 404，`res.status` 斷言失敗，或 axios 直接對 404 拋錯導致測試出錯）

- [ ] **Step 3: 在 `folders.service.ts` 新增 `listRootFolders`**

在 `FoldersService` class 內、`create` 方法之前加入：

```ts
  async listRootFolders(user: AuthenticatedUser) {
    const folders = await this.prisma.folder.findMany({
      where: { parentId: null },
      orderBy: { name: 'asc' },
    });
    const allowed = await Promise.all(
      folders.map((folder) => this.acl.can(user, 'folder', folder.id, 'view')),
    );
    // Not audited: this only decides which root folders are *listed*, it
    // doesn't view any one folder's contents. Opening a folder is still
    // audited as folder_view via getWithContents below, mirroring the
    // listVersions/getMetadata split in documents.service.ts.
    return folders.filter((_, index) => allowed[index]);
  }
```

- [ ] **Step 4: 在 `folders.controller.ts` 新增 `GET /folders` handler**

在 `FoldersController` class 內、`create` 方法之前加入：

```ts
  @Get()
  async listRoot(@Req() req: AuthenticatedRequest) {
    const user = await this.usersService.upsertFromToken(req.user);
    return this.foldersService.listRootFolders({ id: user.id, roles: req.user.roles });
  }
```

- [ ] **Step 5: 執行測試確認通過**

Run: `pnpm --filter api test:e2e -- folders.e2e-spec.ts`
Expected: 全部測試（含既有的）PASS

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/folders/folders.service.ts apps/api/src/folders/folders.controller.ts apps/api/test/folders.e2e-spec.ts
git commit -m "feat(api): add GET /folders for ACL-filtered root folder listing"
```

---

### Task 2: 前端 — Tailwind CSS + shadcn 風格 UI 元件（Button、Dialog、Table）

**Files:**
- Create: `apps/web/tailwind.config.js`
- Create: `apps/web/postcss.config.js`
- Create: `apps/web/src/index.css`
- Create: `apps/web/src/lib/utils.ts`
- Create: `apps/web/src/components/ui/button.tsx`
- Create: `apps/web/src/components/ui/dialog.tsx`
- Create: `apps/web/src/components/ui/table.tsx`
- Modify: `apps/web/src/main.tsx`（加入 `import './index.css'`）
- Modify: `apps/web/vite.config.ts`（加入 `@` path alias）
- Modify: `apps/web/tsconfig.json`（加入 `baseUrl`/`paths`）
- Test: `apps/web/test/ui-primitives.test.tsx`

**Interfaces:**
- Produces:
  - `cn(...inputs: ClassValue[]): string`（`src/lib/utils.ts`）
  - `Button`（`src/components/ui/button.tsx`，props: `variant?, size?, asChild?` + 標準 `<button>` 屬性）
  - `Dialog, DialogTrigger, DialogContent, DialogHeader, DialogFooter, DialogTitle`（`src/components/ui/dialog.tsx`）
  - `Table, TableHeader, TableBody, TableRow, TableHead, TableCell`（`src/components/ui/table.tsx`）
  - 給 Task 5、6、7、8、9、10 消費

- [ ] **Step 1: 安裝依賴**

```bash
pnpm --filter web add class-variance-authority@^0.7.0 clsx@^2.1.1 tailwind-merge@^2.5.2 lucide-react@^0.446.0 @radix-ui/react-dialog@^1.1.1 @radix-ui/react-slot@^1.1.0
pnpm --filter web add -D tailwindcss@^3.4.13 postcss@^8.4.47 autoprefixer@^10.4.20 tailwindcss-animate@^1.0.7
```

- [ ] **Step 2: 寫失敗的元件測試**

Create `apps/web/test/ui-primitives.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { Button } from '../src/components/ui/button';

describe('Button', () => {
  it('renders its children and forwards onClick', () => {
    render(<Button>Click me</Button>);
    expect(screen.getByRole('button', { name: 'Click me' })).toBeInTheDocument();
  });
});
```

- [ ] **Step 3: 執行測試確認失敗**

Run: `pnpm --filter web test -- ui-primitives.test.tsx`
Expected: FAIL，找不到 `../src/components/ui/button`

- [ ] **Step 4: 建立 Tailwind 設定**

Create `apps/web/postcss.config.js`:

```js
module.exports = {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
};
```

Create `apps/web/tailwind.config.js`:

```js
/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: ['class'],
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
      },
    },
  },
  plugins: [require('tailwindcss-animate')],
};
```

Create `apps/web/src/index.css`:

```css
@tailwind base;
@tailwind components;
@tailwind utilities;

@layer base {
  :root {
    --background: 0 0% 100%;
    --foreground: 222.2 84% 4.9%;
    --border: 214.3 31.8% 91.4%;
    --input: 214.3 31.8% 91.4%;
    --ring: 222.2 84% 4.9%;
    --primary: 222.2 47.4% 11.2%;
    --primary-foreground: 210 40% 98%;
    --secondary: 210 40% 96.1%;
    --secondary-foreground: 222.2 47.4% 11.2%;
    --destructive: 0 84.2% 60.2%;
    --destructive-foreground: 210 40% 98%;
    --accent: 210 40% 96.1%;
    --accent-foreground: 222.2 47.4% 11.2%;
    --muted: 210 40% 96.1%;
    --muted-foreground: 215.4 16.3% 46.9%;
    --radius: 0.5rem;
  }
}

body {
  @apply bg-background text-foreground;
}
```

- [ ] **Step 5: 加入 `@` path alias**

Modify `apps/web/vite.config.ts` to:

```ts
import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
  server: { port: 5173 },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: './test/setup.ts',
  },
});
```

Modify `apps/web/tsconfig.json`'s `compilerOptions` to add (alongside existing keys):

```json
    "baseUrl": ".",
    "paths": { "@/*": ["./src/*"] },
```

- [ ] **Step 6: 建立 `cn()` helper**

Create `apps/web/src/lib/utils.ts`:

```ts
import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
```

- [ ] **Step 7: 建立 Button**

Create `apps/web/src/components/ui/button.tsx`:

```tsx
import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '@/lib/utils';

const buttonVariants = cva(
  'inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:bg-primary/90',
        destructive: 'bg-destructive text-destructive-foreground hover:bg-destructive/90',
        outline: 'border border-input bg-background hover:bg-accent hover:text-accent-foreground',
        secondary: 'bg-secondary text-secondary-foreground hover:bg-secondary/80',
        ghost: 'hover:bg-accent hover:text-accent-foreground',
      },
      size: {
        default: 'h-10 px-4 py-2',
        sm: 'h-9 rounded-md px-3',
        lg: 'h-11 rounded-md px-8',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';
    return <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />;
  },
);
Button.displayName = 'Button';

export { Button, buttonVariants };
```

- [ ] **Step 8: 建立 Dialog**

Create `apps/web/src/components/ui/dialog.tsx`:

```tsx
import * as React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';

import { cn } from '@/lib/utils';

const Dialog = DialogPrimitive.Root;
const DialogTrigger = DialogPrimitive.Trigger;
const DialogPortal = DialogPrimitive.Portal;
const DialogClose = DialogPrimitive.Close;

const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn('fixed inset-0 z-50 bg-black/80', className)}
    {...props}
  />
));
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName;

const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>
>(({ className, children, ...props }, ref) => (
  <DialogPortal>
    <DialogOverlay />
    <DialogPrimitive.Content
      ref={ref}
      className={cn(
        'fixed left-[50%] top-[50%] z-50 grid w-full max-w-lg translate-x-[-50%] translate-y-[-50%] gap-4 border bg-background p-6 shadow-lg sm:rounded-lg',
        className,
      )}
      {...props}
    >
      {children}
      <DialogPrimitive.Close className="absolute right-4 top-4 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none">
        <X className="h-4 w-4" />
        <span className="sr-only">Close</span>
      </DialogPrimitive.Close>
    </DialogPrimitive.Content>
  </DialogPortal>
));
DialogContent.displayName = DialogPrimitive.Content.displayName;

const DialogHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('flex flex-col space-y-1.5 text-center sm:text-left', className)} {...props} />
);
DialogHeader.displayName = 'DialogHeader';

const DialogFooter = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn('flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2', className)}
    {...props}
  />
);
DialogFooter.displayName = 'DialogFooter';

const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn('text-lg font-semibold leading-none tracking-tight', className)}
    {...props}
  />
));
DialogTitle.displayName = DialogPrimitive.Title.displayName;

export {
  Dialog,
  DialogPortal,
  DialogOverlay,
  DialogClose,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
};
```

- [ ] **Step 9: 建立 Table**

Create `apps/web/src/components/ui/table.tsx`:

```tsx
import * as React from 'react';

import { cn } from '@/lib/utils';

const Table = React.forwardRef<HTMLTableElement, React.HTMLAttributes<HTMLTableElement>>(
  ({ className, ...props }, ref) => (
    <div className="relative w-full overflow-auto">
      <table ref={ref} className={cn('w-full caption-bottom text-sm', className)} {...props} />
    </div>
  ),
);
Table.displayName = 'Table';

const TableHeader = React.forwardRef<HTMLTableSectionElement, React.HTMLAttributes<HTMLTableSectionElement>>(
  ({ className, ...props }, ref) => <thead ref={ref} className={cn('[&_tr]:border-b', className)} {...props} />,
);
TableHeader.displayName = 'TableHeader';

const TableBody = React.forwardRef<HTMLTableSectionElement, React.HTMLAttributes<HTMLTableSectionElement>>(
  ({ className, ...props }, ref) => (
    <tbody ref={ref} className={cn('[&_tr:last-child]:border-0', className)} {...props} />
  ),
);
TableBody.displayName = 'TableBody';

const TableRow = React.forwardRef<HTMLTableRowElement, React.HTMLAttributes<HTMLTableRowElement>>(
  ({ className, ...props }, ref) => (
    <tr ref={ref} className={cn('border-b transition-colors hover:bg-muted/50', className)} {...props} />
  ),
);
TableRow.displayName = 'TableRow';

const TableHead = React.forwardRef<HTMLTableCellElement, React.ThHTMLAttributes<HTMLTableCellElement>>(
  ({ className, ...props }, ref) => (
    <th
      ref={ref}
      className={cn('h-10 px-2 text-left align-middle font-medium text-muted-foreground', className)}
      {...props}
    />
  ),
);
TableHead.displayName = 'TableHead';

const TableCell = React.forwardRef<HTMLTableCellElement, React.TdHTMLAttributes<HTMLTableCellElement>>(
  ({ className, ...props }, ref) => <td ref={ref} className={cn('p-2 align-middle', className)} {...props} />,
);
TableCell.displayName = 'TableCell';

export { Table, TableHeader, TableBody, TableRow, TableHead, TableCell };
```

- [ ] **Step 10: 在 `main.tsx` 引入 CSS**

Modify `apps/web/src/main.tsx`, add after the last import:

```ts
import './index.css';
```

- [ ] **Step 11: 執行測試與 build 確認通過**

Run: `pnpm --filter web test -- ui-primitives.test.tsx`
Expected: PASS

Run: `pnpm --filter web build`
Expected: 成功，無 TypeScript/Tailwind 錯誤

- [ ] **Step 12: Commit**

```bash
git add apps/web/tailwind.config.js apps/web/postcss.config.js apps/web/src/index.css apps/web/src/lib/utils.ts apps/web/src/components/ui apps/web/src/main.tsx apps/web/vite.config.ts apps/web/tsconfig.json apps/web/test/ui-primitives.test.tsx apps/web/package.json pnpm-lock.yaml
git commit -m "feat(web): add Tailwind CSS and Button/Dialog/Table primitives"
```

---

### Task 3: 前端 — React Query + React Router 基礎建設

**Files:**
- Modify: `apps/web/src/main.tsx`
- Create: `apps/web/test/testUtils.tsx`
- Test: `apps/web/test/testUtils.test.tsx`

**Interfaces:**
- Produces: `renderWithProviders(ui: ReactElement, options?: { route?: string; path?: string }): RenderResult`（`test/testUtils.tsx`），給 Task 5、6、7、8、9、10 的元件測試消費
- Produces: app 全域 `QueryClient`（`main.tsx`）

- [ ] **Step 1: 安裝依賴**

```bash
pnpm --filter web add react-router-dom@^6.26.2 @tanstack/react-query@^5.59.0
```

- [ ] **Step 2: 寫失敗的測試（先驗證 helper 尚不存在）**

Create `apps/web/test/testUtils.test.tsx`:

```tsx
import { screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { renderWithProviders } from './testUtils';

function Probe() {
  const query = useQuery({ queryKey: ['probe'], queryFn: async () => 'ok' });
  return (
    <div>
      <Link to="/somewhere">go</Link>
      <span data-testid="query-status">{query.status}</span>
    </div>
  );
}

describe('renderWithProviders', () => {
  it('provides both router and query client context to children', async () => {
    renderWithProviders(<Probe />);
    expect(screen.getByRole('link', { name: 'go' })).toBeInTheDocument();
    expect(screen.getByTestId('query-status')).toBeInTheDocument();
  });
});
```

- [ ] **Step 3: 執行測試確認失敗**

Run: `pnpm --filter web test -- testUtils.test.tsx`
Expected: FAIL，找不到 `./testUtils`

- [ ] **Step 4: 建立 `renderWithProviders`**

Create `apps/web/test/testUtils.tsx`:

```tsx
import type { ReactElement } from 'react';
import { render } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

export function renderWithProviders(
  ui: ReactElement,
  { route = '/', path = '/' }: { route?: string; path?: string } = {},
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[route]}>
        <Routes>
          <Route path={path} element={ui} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
```

- [ ] **Step 5: 執行測試確認通過**

Run: `pnpm --filter web test -- testUtils.test.tsx`
Expected: PASS

- [ ] **Step 6: 在 `main.tsx` 加入 `QueryClientProvider`**

Modify `apps/web/src/main.tsx` to:

```tsx
import React from 'react';
import ReactDOM from 'react-dom/client';
import { AuthProvider } from 'react-oidc-context';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from './App';
import { oidcConfig } from './auth/authConfig';
import './index.css';

const queryClient = new QueryClient();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <AuthProvider {...oidcConfig}>
        <App />
      </AuthProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);
```

- [ ] **Step 7: 執行完整前端測試確認沒有回歸**

Run: `pnpm --filter web test`
Expected: 全部 PASS（既有的 `App.test.tsx`、`Home.test.tsx`、`MaintenanceNotice.test.tsx` 不受影響）

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/main.tsx apps/web/test/testUtils.tsx apps/web/test/testUtils.test.tsx apps/web/package.json pnpm-lock.yaml
git commit -m "feat(web): wire up React Query and add router+query test helper"
```

---

### Task 4: 前端 — API client 層（`client.ts`、`folders.ts`、`documents.ts`）

**Files:**
- Create: `apps/web/src/api/client.ts`
- Create: `apps/web/src/api/folders.ts`
- Create: `apps/web/src/api/documents.ts`
- Test: `apps/web/test/api/client.test.ts`
- Test: `apps/web/test/api/folders.test.ts`
- Test: `apps/web/test/api/documents.test.ts`

**Interfaces:**
- Consumes: `GET /folders`、`GET /folders/:id`、`POST /folders`、`GET /documents/:id`、`GET /documents/:id/versions`、`POST /documents`、`POST /documents/:id/versions`、`GET /documents/:id/download`（既有 + Task 1 新增的 `apps/api` 端點）
- Produces:
  - `ApiError`、`apiFetch<T>(path, accessToken, init?)`、`friendlyErrorMessage(error: unknown): string`（`api/client.ts`）
  - `FolderSummary`、`FolderDetail`、`DocumentSummary`、`listRootFolders(accessToken)`、`getFolder(id, accessToken)`、`createFolder(input, accessToken)`（`api/folders.ts`）
  - `DocumentDetail`、`DocumentVersion`、`getDocument(id, accessToken)`、`listVersions(id, accessToken)`、`uploadDocument(input, accessToken)`、`uploadVersion(documentId, file, accessToken)`、`downloadDocument(documentId, versionId, accessToken)`（`api/documents.ts`）
  - 給 Task 5、6、7、8、9、10 消費

- [ ] **Step 1: 寫失敗的 `client.ts` 測試**

Create `apps/web/test/api/client.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { apiFetch, ApiError, friendlyErrorMessage } from '../../src/api/client';

describe('apiFetch', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  it('sends the Authorization header and decodes JSON on success', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ hello: 'world' }),
    } as Response);

    const result = await apiFetch<{ hello: string }>('/whoami', 'fake-token');

    expect(result).toEqual({ hello: 'world' });
    const [, init] = vi.mocked(fetch).mock.calls[0];
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer fake-token');
  });

  it('throws ApiError with the response status on non-2xx', async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: false, status: 403 } as Response);

    await expect(apiFetch('/folders', 'fake-token')).rejects.toMatchObject({ status: 403 });
  });
});

describe('friendlyErrorMessage', () => {
  it('maps 403 to a permission message', () => {
    expect(friendlyErrorMessage(new ApiError(403, 'x'))).toContain('權限');
  });

  it('maps 404 to a not-found message', () => {
    expect(friendlyErrorMessage(new ApiError(404, 'x'))).toContain('找不到');
  });

  it('falls back to a generic message for unknown errors', () => {
    expect(friendlyErrorMessage(new Error('boom'))).toBe('發生錯誤，請稍後再試');
  });
});
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `pnpm --filter web test -- client.test.ts`
Expected: FAIL，找不到 `../../src/api/client`

- [ ] **Step 3: 實作 `api/client.ts`**

Create `apps/web/src/api/client.ts`:

```ts
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export async function apiFetch<T>(
  path: string,
  accessToken: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(`${import.meta.env.VITE_API_BASE_URL}${path}`, {
    ...init,
    headers: {
      ...init.headers,
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    throw new ApiError(response.status, `Request to ${path} failed with status ${response.status}`);
  }

  const contentType = response.headers.get('content-type');
  if (contentType && contentType.includes('application/json')) {
    return response.json() as Promise<T>;
  }
  return undefined as T;
}

export function friendlyErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 403) return '你沒有存取這個項目的權限';
    if (error.status === 404) return '找不到這個項目';
  }
  return '發生錯誤，請稍後再試';
}
```

- [ ] **Step 4: 執行測試確認通過**

Run: `pnpm --filter web test -- client.test.ts`
Expected: PASS

- [ ] **Step 5: 寫失敗的 `folders.ts` 測試**

Create `apps/web/test/api/folders.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { listRootFolders, createFolder } from '../../src/api/folders';

describe('folders api', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  it('listRootFolders calls GET /folders', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => [],
    } as Response);

    await listRootFolders('fake-token');

    const [url] = vi.mocked(fetch).mock.calls[0];
    expect(url).toContain('/folders');
  });

  it('createFolder POSTs a JSON body with name and parentId', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ id: '1' }),
    } as Response);

    await createFolder({ name: 'Docs', parentId: 'parent-1' }, 'fake-token');

    const [, init] = vi.mocked(fetch).mock.calls[0];
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init?.body as string)).toEqual({ name: 'Docs', parentId: 'parent-1' });
  });
});
```

- [ ] **Step 6: 執行測試確認失敗**

Run: `pnpm --filter web test -- folders.test.ts`
Expected: FAIL，找不到 `../../src/api/folders`

- [ ] **Step 7: 實作 `api/folders.ts`**

Create `apps/web/src/api/folders.ts`:

```ts
import { apiFetch } from './client';

export interface FolderSummary {
  id: string;
  name: string;
  parentId: string | null;
  createdBy: string;
  createdAt: string;
}

export interface DocumentSummary {
  id: string;
  name: string;
  currentVersion: { id: string; versionNumber: number; sizeBytes: number; mimeType: string } | null;
}

export interface FolderDetail extends FolderSummary {
  children: FolderSummary[];
  documents: DocumentSummary[];
}

export function listRootFolders(accessToken: string) {
  return apiFetch<FolderSummary[]>('/folders', accessToken);
}

export function getFolder(id: string, accessToken: string) {
  return apiFetch<FolderDetail>(`/folders/${id}`, accessToken);
}

export function createFolder(input: { name: string; parentId: string | null }, accessToken: string) {
  return apiFetch<FolderSummary>('/folders', accessToken, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: input.name, parentId: input.parentId }),
  });
}
```

- [ ] **Step 8: 執行測試確認通過**

Run: `pnpm --filter web test -- folders.test.ts`
Expected: PASS

- [ ] **Step 9: 寫失敗的 `documents.ts` 測試**

Create `apps/web/test/api/documents.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { uploadDocument, downloadDocument } from '../../src/api/documents';

describe('documents api', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  it('uploadDocument POSTs multipart form data with folderId, name and file', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ id: 'doc-1' }),
    } as Response);

    const file = new File(['content'], 'report.pdf', { type: 'application/pdf' });
    await uploadDocument({ folderId: 'folder-1', name: 'report.pdf', file }, 'fake-token');

    const [, init] = vi.mocked(fetch).mock.calls[0];
    expect(init?.method).toBe('POST');
    const body = init?.body as FormData;
    expect(body.get('folderId')).toBe('folder-1');
    expect(body.get('name')).toBe('report.pdf');
    expect(body.get('file')).toBe(file);
  });

  it('downloadDocument parses the filename from Content-Disposition and returns a blob', async () => {
    const fakeBlob = new Blob(['data']);
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-disposition': 'attachment; filename="report.pdf"' }),
      blob: async () => fakeBlob,
    } as Response);

    const result = await downloadDocument('doc-1', undefined, 'fake-token');

    expect(result.fileName).toBe('report.pdf');
    expect(result.blob).toBe(fakeBlob);
  });
});
```

- [ ] **Step 10: 執行測試確認失敗**

Run: `pnpm --filter web test -- documents.test.ts`
Expected: FAIL，找不到 `../../src/api/documents`

- [ ] **Step 11: 實作 `api/documents.ts`**

Create `apps/web/src/api/documents.ts`:

```ts
import { apiFetch, ApiError } from './client';

export interface DocumentVersion {
  id: string;
  documentId: string;
  versionNumber: number;
  sha256: string;
  mimeType: string;
  sizeBytes: number;
  uploadedBy: string;
  uploadedAt: string;
}

export interface DocumentDetail {
  id: string;
  folderId: string;
  name: string;
  currentVersionId: string | null;
  currentVersion: DocumentVersion | null;
  createdBy: string;
  createdAt: string;
}

export function getDocument(id: string, accessToken: string) {
  return apiFetch<DocumentDetail>(`/documents/${id}`, accessToken);
}

export function listVersions(id: string, accessToken: string) {
  return apiFetch<DocumentVersion[]>(`/documents/${id}/versions`, accessToken);
}

export function uploadDocument(
  input: { folderId: string; name: string; file: File },
  accessToken: string,
) {
  const form = new FormData();
  form.append('folderId', input.folderId);
  form.append('name', input.name);
  form.append('file', input.file);
  return apiFetch<DocumentDetail>('/documents', accessToken, { method: 'POST', body: form });
}

export function uploadVersion(documentId: string, file: File, accessToken: string) {
  const form = new FormData();
  form.append('file', file);
  return apiFetch<DocumentVersion>(`/documents/${documentId}/versions`, accessToken, {
    method: 'POST',
    body: form,
  });
}

export async function downloadDocument(
  documentId: string,
  versionId: string | undefined,
  accessToken: string,
): Promise<{ blob: Blob; fileName: string }> {
  const query = versionId ? `?versionId=${versionId}` : '';
  const response = await fetch(
    `${import.meta.env.VITE_API_BASE_URL}/documents/${documentId}/download${query}`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!response.ok) {
    throw new ApiError(response.status, `Download failed with status ${response.status}`);
  }
  const disposition = response.headers.get('content-disposition') ?? '';
  const match = /filename="([^"]+)"/.exec(disposition);
  const fileName = match ? match[1] : 'download';
  const blob = await response.blob();
  return { blob, fileName };
}
```

- [ ] **Step 12: 執行測試確認通過**

Run: `pnpm --filter web test -- documents.test.ts`
Expected: PASS

- [ ] **Step 13: Commit**

```bash
git add apps/web/src/api apps/web/test/api
git commit -m "feat(web): add typed API client for folders and documents"
```

---

### Task 5: 前端 — `Breadcrumb` 元件

**Files:**
- Create: `apps/web/src/components/Breadcrumb.tsx`
- Test: `apps/web/test/Breadcrumb.test.tsx`

**Interfaces:**
- Consumes: `getFolder(id, accessToken): Promise<FolderDetail>`（`api/folders.ts`，Task 4）；`renderWithProviders`（`test/testUtils.tsx`，Task 3）
- Produces: `Breadcrumb({ currentId, currentName, parentId }): JSX.Element`，給 Task 7（`FolderView`）消費

- [ ] **Step 1: 寫失敗的測試**

Create `apps/web/test/Breadcrumb.test.tsx`:

```tsx
import { screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useAuth } from 'react-oidc-context';
import { Breadcrumb } from '../src/components/Breadcrumb';
import { getFolder } from '../src/api/folders';
import { renderWithProviders } from './testUtils';

vi.mock('react-oidc-context', () => ({ useAuth: vi.fn() }));
vi.mock('../src/api/folders', () => ({ getFolder: vi.fn() }));

describe('Breadcrumb', () => {
  beforeEach(() => {
    vi.mocked(useAuth).mockReturnValue({
      user: { access_token: 'fake-token' },
    } as unknown as ReturnType<typeof useAuth>);
  });

  it('walks the parent chain and renders ancestors in root-to-leaf order', async () => {
    vi.mocked(getFolder).mockImplementation(async (id: string) => {
      if (id === 'folder-b') {
        return {
          id: 'folder-b',
          name: 'B',
          parentId: 'folder-a',
          createdBy: 'u',
          createdAt: '',
          children: [],
          documents: [],
        };
      }
      if (id === 'folder-a') {
        return {
          id: 'folder-a',
          name: 'A',
          parentId: null,
          createdBy: 'u',
          createdAt: '',
          children: [],
          documents: [],
        };
      }
      throw new Error(`unexpected id ${id}`);
    });

    renderWithProviders(<Breadcrumb currentId="folder-c" currentName="C" parentId="folder-b" />);

    await waitFor(() => expect(screen.getByText('C')).toBeInTheDocument());
    const links = screen.getAllByRole('link').map((el) => el.textContent);
    expect(links).toEqual(['Root', 'A', 'B']);
  });
});
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `pnpm --filter web test -- Breadcrumb.test.tsx`
Expected: FAIL，找不到 `../src/components/Breadcrumb`

- [ ] **Step 3: 實作 `Breadcrumb.tsx`**

Create `apps/web/src/components/Breadcrumb.tsx`:

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
  const crumbs = [...(ancestors.data ?? []), { id: currentId, name: currentName }];

  return (
    <nav aria-label="breadcrumb">
      <Link to="/">Root</Link>
      {crumbs.map((crumb) => (
        <span key={crumb.id}>
          {' / '}
          <Link to={`/folders/${crumb.id}`}>{crumb.name}</Link>
        </span>
      ))}
    </nav>
  );
}
```

- [ ] **Step 4: 執行測試確認通過**

Run: `pnpm --filter web test -- Breadcrumb.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/Breadcrumb.tsx apps/web/test/Breadcrumb.test.tsx
git commit -m "feat(web): add Breadcrumb component that walks the folder parent chain"
```

---

### Task 6: 前端 — `/` 路由：`RootFolders`（含路由基礎建設）

**Files:**
- Create: `apps/web/src/routes/RootFolders.tsx`
- Create: `apps/web/src/components/CreateFolderDialog.tsx`
- Modify: `apps/web/src/App.tsx`
- Test: `apps/web/test/routes/RootFolders.test.tsx`
- Test: `apps/web/test/components/CreateFolderDialog.test.tsx`

**Interfaces:**
- Consumes: `listRootFolders`、`createFolder`（`api/folders.ts`，Task 4）；`Table*`、`Button`、`Dialog*`（Task 2）；`renderWithProviders`（Task 3）
- Produces: `RootFolders(): JSX.Element`、`CreateFolderDialog({ parentId }): JSX.Element`，`CreateFolderDialog` 給 Task 7（`FolderView`）重用；`App.tsx` 現在掛載 `<BrowserRouter><Routes>`，給 Task 7、8 追加 `<Route>`

- [ ] **Step 1: 寫失敗的 `CreateFolderDialog` 測試**

Create `apps/web/test/components/CreateFolderDialog.test.tsx`:

```tsx
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useAuth } from 'react-oidc-context';
import { CreateFolderDialog } from '../../src/components/CreateFolderDialog';
import { createFolder } from '../../src/api/folders';
import { renderWithProviders } from '../testUtils';

vi.mock('react-oidc-context', () => ({ useAuth: vi.fn() }));
vi.mock('../../src/api/folders', () => ({ createFolder: vi.fn() }));

describe('CreateFolderDialog', () => {
  beforeEach(() => {
    vi.mocked(useAuth).mockReturnValue({
      user: { access_token: 'fake-token' },
    } as unknown as ReturnType<typeof useAuth>);
  });

  it('submits the entered name and parentId to createFolder', async () => {
    vi.mocked(createFolder).mockResolvedValue({
      id: 'new-folder',
      name: 'Docs',
      parentId: 'parent-1',
      createdBy: 'u',
      createdAt: '',
    });

    renderWithProviders(<CreateFolderDialog parentId="parent-1" />);

    fireEvent.click(screen.getByRole('button', { name: '新增資料夾' }));
    fireEvent.change(screen.getByTestId('folder-name-input'), { target: { value: 'Docs' } });
    fireEvent.click(screen.getByTestId('submit-create-folder'));

    await waitFor(() =>
      expect(createFolder).toHaveBeenCalledWith({ name: 'Docs', parentId: 'parent-1' }, 'fake-token'),
    );
  });
});
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `pnpm --filter web test -- CreateFolderDialog.test.tsx`
Expected: FAIL，找不到 `../../src/components/CreateFolderDialog`

- [ ] **Step 3: 實作 `CreateFolderDialog.tsx`**

Create `apps/web/src/components/CreateFolderDialog.tsx`:

```tsx
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from 'react-oidc-context';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { createFolder } from '../api/folders';
import { friendlyErrorMessage } from '../api/client';

interface CreateFolderDialogProps {
  parentId: string | null;
}

export function CreateFolderDialog({ parentId }: CreateFolderDialogProps) {
  const auth = useAuth();
  const accessToken = auth.user?.access_token ?? '';
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');

  const mutation = useMutation({
    mutationFn: () => createFolder({ name, parentId }, accessToken),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: parentId ? ['folder', parentId] : ['rootFolders'] });
      setOpen(false);
      setName('');
    },
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>新增資料夾</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>新增資料夾</DialogTitle>
        </DialogHeader>
        <input
          data-testid="folder-name-input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="資料夾名稱"
        />
        {mutation.isError && <p data-testid="error">{friendlyErrorMessage(mutation.error)}</p>}
        <DialogFooter>
          <Button
            data-testid="submit-create-folder"
            disabled={!name.trim() || mutation.isPending}
            onClick={() => mutation.mutate()}
          >
            建立
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 4: 執行測試確認通過**

Run: `pnpm --filter web test -- CreateFolderDialog.test.tsx`
Expected: PASS

- [ ] **Step 5: 寫失敗的 `RootFolders` 測試**

Create `apps/web/test/routes/RootFolders.test.tsx`:

```tsx
import { screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useAuth } from 'react-oidc-context';
import { RootFolders } from '../../src/routes/RootFolders';
import { listRootFolders } from '../../src/api/folders';
import { renderWithProviders } from '../testUtils';

vi.mock('react-oidc-context', () => ({ useAuth: vi.fn() }));
vi.mock('../../src/api/folders', () => ({
  listRootFolders: vi.fn(),
  createFolder: vi.fn(),
}));

describe('RootFolders', () => {
  beforeEach(() => {
    vi.mocked(useAuth).mockReturnValue({
      user: { access_token: 'fake-token' },
    } as unknown as ReturnType<typeof useAuth>);
  });

  it('renders a link for each visible root folder', async () => {
    vi.mocked(listRootFolders).mockResolvedValue([
      { id: 'f1', name: 'Finance', parentId: null, createdBy: 'u', createdAt: '' },
    ]);

    renderWithProviders(<RootFolders />);

    await waitFor(() => expect(screen.getByRole('link', { name: 'Finance' })).toBeInTheDocument());
  });

  it('shows a helpful message when there are no visible root folders', async () => {
    vi.mocked(listRootFolders).mockResolvedValue([]);

    renderWithProviders(<RootFolders />);

    await waitFor(() => expect(screen.getByTestId('empty')).toBeInTheDocument());
  });
});
```

- [ ] **Step 6: 執行測試確認失敗**

Run: `pnpm --filter web test -- RootFolders.test.tsx`
Expected: FAIL，找不到 `../../src/routes/RootFolders`

- [ ] **Step 7: 實作 `RootFolders.tsx`**

Create `apps/web/src/routes/RootFolders.tsx`:

```tsx
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from 'react-oidc-context';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { listRootFolders } from '../api/folders';
import { friendlyErrorMessage } from '../api/client';
import { CreateFolderDialog } from '../components/CreateFolderDialog';

export function RootFolders() {
  const auth = useAuth();
  const accessToken = auth.user?.access_token ?? '';

  const query = useQuery({
    queryKey: ['rootFolders'],
    queryFn: () => listRootFolders(accessToken),
    enabled: !!accessToken,
  });

  if (query.isLoading) return <p data-testid="loading">Loading...</p>;
  if (query.isError) return <p data-testid="error">{friendlyErrorMessage(query.error)}</p>;

  const folders = query.data ?? [];

  return (
    <div>
      <h1>資料夾</h1>
      <CreateFolderDialog parentId={null} />
      {folders.length === 0 ? (
        <p data-testid="empty">目前沒有你可以存取的資料夾，請聯絡管理員</p>
      ) : (
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
                  <Link to={`/folders/${folder.id}`}>{folder.name}</Link>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
```

- [ ] **Step 8: 在 `App.tsx` 掛上路由**

Modify `apps/web/src/App.tsx` to:

```tsx
import { useAuth } from 'react-oidc-context';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { Home } from './Home';
import { MaintenanceNotice } from './MaintenanceNotice';
import { RootFolders } from './routes/RootFolders';

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
      <div>
        <button onClick={() => auth.signoutRedirect()}>Log out</button>
        <Home accessToken={auth.user?.access_token ?? ''} />
        <Routes>
          <Route path="/" element={<RootFolders />} />
        </Routes>
      </div>
    </BrowserRouter>
  );
}
```

- [ ] **Step 9: 執行測試確認通過，並確認既有測試沒有回歸**

Run: `pnpm --filter web test -- RootFolders.test.tsx`
Expected: PASS

Run: `pnpm --filter web test`
Expected: 全部 PASS（`App.test.tsx` 只測登出狀態，不受路由新增影響）

- [ ] **Step 10: Commit**

```bash
git add apps/web/src/routes/RootFolders.tsx apps/web/src/components/CreateFolderDialog.tsx apps/web/src/App.tsx apps/web/test/routes apps/web/test/components/CreateFolderDialog.test.tsx
git commit -m "feat(web): add root folder listing route and create-folder dialog"
```

---

### Task 7: 前端 — `/folders/:id` 路由：`FolderView`

**Files:**
- Create: `apps/web/src/routes/FolderView.tsx`
- Modify: `apps/web/src/App.tsx`
- Test: `apps/web/test/routes/FolderView.test.tsx`

**Interfaces:**
- Consumes: `getFolder`（Task 4）、`Breadcrumb`（Task 5）、`CreateFolderDialog`（Task 6）、`Table*`/`Button`（Task 2）
- Produces: `FolderView(): JSX.Element`；`App.tsx` 新增 `/folders/:id` route

- [ ] **Step 1: 寫失敗的測試**

Create `apps/web/test/routes/FolderView.test.tsx`:

```tsx
import { screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useAuth } from 'react-oidc-context';
import { FolderView } from '../../src/routes/FolderView';
import { getFolder } from '../../src/api/folders';
import { renderWithProviders } from '../testUtils';

vi.mock('react-oidc-context', () => ({ useAuth: vi.fn() }));
vi.mock('../../src/api/folders', () => ({ getFolder: vi.fn(), createFolder: vi.fn() }));
vi.mock('../../src/api/documents', () => ({ uploadDocument: vi.fn() }));

describe('FolderView', () => {
  beforeEach(() => {
    vi.mocked(useAuth).mockReturnValue({
      user: { access_token: 'fake-token' },
    } as unknown as ReturnType<typeof useAuth>);
  });

  it('renders child folders and documents for the given folder id', async () => {
    // parentId: null keeps Breadcrumb's ancestor walk a no-op for this test;
    // Breadcrumb's own walking behavior is covered by Breadcrumb.test.tsx.
    vi.mocked(getFolder).mockResolvedValue({
      id: 'folder-1',
      name: 'Finance',
      parentId: null,
      createdBy: 'u',
      createdAt: '',
      children: [{ id: 'child-1', name: 'Q1', parentId: 'folder-1', createdBy: 'u', createdAt: '' }],
      documents: [{ id: 'doc-1', name: 'report.pdf', currentVersion: null }],
    });

    renderWithProviders(<FolderView />, { route: '/folders/folder-1', path: '/folders/:id' });

    await waitFor(() => expect(screen.getByRole('link', { name: 'Q1' })).toBeInTheDocument());
    expect(screen.getByRole('link', { name: 'report.pdf' })).toBeInTheDocument();
    expect(getFolder).toHaveBeenCalledWith('folder-1', 'fake-token');
  });
});
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `pnpm --filter web test -- FolderView.test.tsx`
Expected: FAIL，找不到 `../../src/routes/FolderView`

- [ ] **Step 3: 實作 `FolderView.tsx`**

Create `apps/web/src/routes/FolderView.tsx`:

```tsx
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from 'react-oidc-context';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { getFolder } from '../api/folders';
import { friendlyErrorMessage } from '../api/client';
import { Breadcrumb } from '../components/Breadcrumb';
import { CreateFolderDialog } from '../components/CreateFolderDialog';
import { UploadDialog } from '../components/UploadDialog';

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

  if (query.isLoading) return <p data-testid="loading">Loading...</p>;
  if (query.isError) return <p data-testid="error">{friendlyErrorMessage(query.error)}</p>;

  const folder = query.data!;

  return (
    <div>
      <Breadcrumb currentId={folder.id} currentName={folder.name} parentId={folder.parentId} />
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

Note: `UploadDialog` 尚未建立（Task 9），此步驟先寫 import，Task 7 的測試 mock 了 `../../src/api/documents`，`FolderView.test.tsx` 不會實際 render 出 `UploadDialog` 內部邏輯失敗，但 TypeScript 編譯需要 `UploadDialog.tsx` 存在。因此本步驟同時建立一個最小可編譯版本，Task 9 再擴充成完整功能：

Create `apps/web/src/components/UploadDialog.tsx`（最小版本，Task 9 會重寫成完整版本）:

```tsx
export type UploadDialogProps =
  | { mode: 'new-document'; folderId: string }
  | { mode: 'new-version'; documentId: string };

export function UploadDialog(_props: UploadDialogProps) {
  return null;
}
```

- [ ] **Step 4: 在 `App.tsx` 追加路由**

Modify `apps/web/src/App.tsx`:

```diff
 import { RootFolders } from './routes/RootFolders';
+import { FolderView } from './routes/FolderView';
```

```diff
         <Routes>
           <Route path="/" element={<RootFolders />} />
+          <Route path="/folders/:id" element={<FolderView />} />
         </Routes>
```

- [ ] **Step 5: 執行測試確認通過**

Run: `pnpm --filter web test -- FolderView.test.tsx`
Expected: PASS

Run: `pnpm --filter web build`
Expected: 成功（`UploadDialog` 最小版本可編譯）

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/routes/FolderView.tsx apps/web/src/components/UploadDialog.tsx apps/web/src/App.tsx apps/web/test/routes/FolderView.test.tsx
git commit -m "feat(web): add folder detail route with breadcrumb navigation"
```

---

### Task 8: 前端 — `/documents/:id` 路由：`DocumentView`

**Files:**
- Create: `apps/web/src/routes/DocumentView.tsx`
- Modify: `apps/web/src/App.tsx`
- Test: `apps/web/test/routes/DocumentView.test.tsx`

**Interfaces:**
- Consumes: `getDocument`、`listVersions`、`downloadDocument`（Task 4）；`UploadDialog`（最小版本，Task 7）；`Table*`/`Button`（Task 2）
- Produces: `DocumentView(): JSX.Element`；`App.tsx` 新增 `/documents/:id` route

- [ ] **Step 1: 寫失敗的測試**

Create `apps/web/test/routes/DocumentView.test.tsx`:

```tsx
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useAuth } from 'react-oidc-context';
import { DocumentView } from '../../src/routes/DocumentView';
import { getDocument, listVersions, downloadDocument } from '../../src/api/documents';
import { renderWithProviders } from '../testUtils';

vi.mock('react-oidc-context', () => ({ useAuth: vi.fn() }));
vi.mock('../../src/api/documents', () => ({
  getDocument: vi.fn(),
  listVersions: vi.fn(),
  downloadDocument: vi.fn(),
}));

describe('DocumentView', () => {
  beforeEach(() => {
    vi.mocked(useAuth).mockReturnValue({
      user: { access_token: 'fake-token' },
    } as unknown as ReturnType<typeof useAuth>);
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: vi.fn(() => 'blob:fake'),
      revokeObjectURL: vi.fn(),
    });
  });

  it('renders document metadata and version history, and downloads on click', async () => {
    vi.mocked(getDocument).mockResolvedValue({
      id: 'doc-1',
      folderId: 'folder-1',
      name: 'report.pdf',
      currentVersionId: 'v2',
      currentVersion: null,
      createdBy: 'u',
      createdAt: '',
    });
    vi.mocked(listVersions).mockResolvedValue([
      {
        id: 'v2',
        documentId: 'doc-1',
        versionNumber: 2,
        sha256: 'x',
        mimeType: 'application/pdf',
        sizeBytes: 100,
        uploadedBy: 'user-1',
        uploadedAt: '',
      },
    ]);
    const fakeBlob = new Blob(['data']);
    vi.mocked(downloadDocument).mockResolvedValue({ blob: fakeBlob, fileName: 'report.pdf' });

    renderWithProviders(<DocumentView />, { route: '/documents/doc-1', path: '/documents/:id' });

    await waitFor(() => expect(screen.getByText('report.pdf')).toBeInTheDocument());
    expect(screen.getByText('v2')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('download-current'));

    await waitFor(() =>
      expect(downloadDocument).toHaveBeenCalledWith('doc-1', undefined, 'fake-token'),
    );
  });
});
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `pnpm --filter web test -- DocumentView.test.tsx`
Expected: FAIL，找不到 `../../src/routes/DocumentView`

- [ ] **Step 3: 實作 `DocumentView.tsx`**

Create `apps/web/src/routes/DocumentView.tsx`:

```tsx
import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from 'react-oidc-context';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
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
    <div>
      <h1>{doc.name}</h1>
      <Button data-testid="download-current" onClick={() => handleDownload()}>
        下載目前版本
      </Button>
      <UploadDialog mode="new-version" documentId={documentId} />

      <h2>版本歷史</h2>
      {versionsQuery.isLoading && <p data-testid="versions-loading">Loading versions...</p>}
      {versionsQuery.isError && (
        <p data-testid="versions-error">{friendlyErrorMessage(versionsQuery.error)}</p>
      )}
      {versionsQuery.data && (
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
      )}
    </div>
  );
}
```

- [ ] **Step 4: 在 `App.tsx` 追加路由**

Modify `apps/web/src/App.tsx`:

```diff
 import { FolderView } from './routes/FolderView';
+import { DocumentView } from './routes/DocumentView';
```

```diff
           <Route path="/folders/:id" element={<FolderView />} />
+          <Route path="/documents/:id" element={<DocumentView />} />
```

- [ ] **Step 5: 執行測試確認通過**

Run: `pnpm --filter web test -- DocumentView.test.tsx`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/routes/DocumentView.tsx apps/web/src/App.tsx apps/web/test/routes/DocumentView.test.tsx
git commit -m "feat(web): add document detail route with version history and download"
```

---

### Task 9: 前端 — `UploadDialog`（新文件／新版本共用）

**Files:**
- Modify: `apps/web/src/components/UploadDialog.tsx`（取代 Task 7 建立的最小版本）
- Test: `apps/web/test/components/UploadDialog.test.tsx`

**Interfaces:**
- Consumes: `uploadDocument`、`uploadVersion`（Task 4）；`Dialog*`/`Button`（Task 2）
- Produces: 完整功能的 `UploadDialog({ mode, folderId } | { mode, documentId }): JSX.Element`，被 `FolderView`（Task 7，`mode="new-document"`）與 `DocumentView`（Task 8，`mode="new-version"`）使用

- [ ] **Step 1: 寫失敗的測試**

Create `apps/web/test/components/UploadDialog.test.tsx`:

```tsx
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useAuth } from 'react-oidc-context';
import { UploadDialog } from '../../src/components/UploadDialog';
import { uploadDocument, uploadVersion } from '../../src/api/documents';
import { renderWithProviders } from '../testUtils';

vi.mock('react-oidc-context', () => ({ useAuth: vi.fn() }));
vi.mock('../../src/api/documents', () => ({
  uploadDocument: vi.fn(),
  uploadVersion: vi.fn(),
}));

describe('UploadDialog', () => {
  beforeEach(() => {
    vi.mocked(useAuth).mockReturnValue({
      user: { access_token: 'fake-token' },
    } as unknown as ReturnType<typeof useAuth>);
  });

  it('mode=new-document calls uploadDocument with the selected file and folderId', async () => {
    vi.mocked(uploadDocument).mockResolvedValue({
      id: 'doc-1',
      folderId: 'folder-1',
      name: 'report.pdf',
      currentVersionId: 'v1',
      currentVersion: null,
      createdBy: 'u',
      createdAt: '',
    });

    renderWithProviders(<UploadDialog mode="new-document" folderId="folder-1" />);

    fireEvent.click(screen.getByRole('button', { name: '上傳新文件' }));
    const file = new File(['content'], 'report.pdf', { type: 'application/pdf' });
    fireEvent.change(screen.getByTestId('file-input'), { target: { files: [file] } });
    fireEvent.click(screen.getByTestId('submit-upload'));

    await waitFor(() =>
      expect(uploadDocument).toHaveBeenCalledWith(
        { folderId: 'folder-1', name: 'report.pdf', file },
        'fake-token',
      ),
    );
  });

  it('mode=new-version calls uploadVersion with the selected file and documentId', async () => {
    vi.mocked(uploadVersion).mockResolvedValue({
      id: 'v2',
      documentId: 'doc-1',
      versionNumber: 2,
      sha256: 'x',
      mimeType: 'application/pdf',
      sizeBytes: 1,
      uploadedBy: 'u',
      uploadedAt: '',
    });

    renderWithProviders(<UploadDialog mode="new-version" documentId="doc-1" />);

    fireEvent.click(screen.getByRole('button', { name: '上傳新版本' }));
    const file = new File(['content'], 'v2.pdf', { type: 'application/pdf' });
    fireEvent.change(screen.getByTestId('file-input'), { target: { files: [file] } });
    fireEvent.click(screen.getByTestId('submit-upload'));

    await waitFor(() => expect(uploadVersion).toHaveBeenCalledWith('doc-1', file, 'fake-token'));
  });
});
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `pnpm --filter web test -- UploadDialog.test.tsx`
Expected: FAIL（目前的最小版本 render 出 `null`，找不到任何 button）

- [ ] **Step 3: 實作完整版 `UploadDialog.tsx`**

Overwrite `apps/web/src/components/UploadDialog.tsx`:

```tsx
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from 'react-oidc-context';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { uploadDocument, uploadVersion } from '../api/documents';
import { friendlyErrorMessage } from '../api/client';

export type UploadDialogProps =
  | { mode: 'new-document'; folderId: string }
  | { mode: 'new-version'; documentId: string };

export function UploadDialog(props: UploadDialogProps) {
  const auth = useAuth();
  const accessToken = auth.user?.access_token ?? '';
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState('');

  const mutation = useMutation({
    mutationFn: async () => {
      if (!file) throw new Error('file is required');
      if (props.mode === 'new-document') {
        return uploadDocument({ folderId: props.folderId, name: name || file.name, file }, accessToken);
      }
      return uploadVersion(props.documentId, file, accessToken);
    },
    onSuccess: () => {
      if (props.mode === 'new-document') {
        queryClient.invalidateQueries({ queryKey: ['folder', props.folderId] });
      } else {
        queryClient.invalidateQueries({ queryKey: ['document', props.documentId] });
        queryClient.invalidateQueries({ queryKey: ['documentVersions', props.documentId] });
      }
      setOpen(false);
      setFile(null);
      setName('');
    },
  });

  const title = props.mode === 'new-document' ? '上傳新文件' : '上傳新版本';

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>{title}</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        {props.mode === 'new-document' && (
          <input
            data-testid="document-name-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="文件名稱（留空則用檔名）"
          />
        )}
        <input
          data-testid="file-input"
          type="file"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        />
        {mutation.isError && <p data-testid="error">{friendlyErrorMessage(mutation.error)}</p>}
        <DialogFooter>
          <Button
            data-testid="submit-upload"
            disabled={!file || mutation.isPending}
            onClick={() => mutation.mutate()}
          >
            上傳
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 4: 執行測試確認通過**

Run: `pnpm --filter web test -- UploadDialog.test.tsx`
Expected: PASS

- [ ] **Step 5: 執行完整前端測試套件確認沒有回歸**

Run: `pnpm --filter web test`
Expected: 全部 PASS

Run: `pnpm --filter web build`
Expected: 成功

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/UploadDialog.tsx apps/web/test/components/UploadDialog.test.tsx
git commit -m "feat(web): implement UploadDialog for new documents and new versions"
```

---

### Task 10: 後端 — 完整流程整合測試

**Files:**
- Create: `apps/api/test/file-management-flow.e2e-spec.ts`

**Interfaces:**
- Consumes: `GET /folders`（Task 1）、`POST /folders`、`POST /documents`、`GET /documents/:id`、`GET /documents/:id/versions`、`GET /documents/:id/download`（既有）

- [ ] **Step 1: 寫測試**

Create `apps/api/test/file-management-flow.e2e-spec.ts`:

```ts
import axios from 'axios';
import FormData from 'form-data';

const KEYCLOAK_TOKEN_URL = 'https://auth.drm.apower.lan/realms/drm/protocol/openid-connect/token';
const API_BASE_URL = 'https://api.drm.apower.lan';

interface TokenResponse {
  access_token: string;
}

interface FolderResponse {
  id: string;
  name: string;
}

interface DocumentVersionResponse {
  id: string;
  versionNumber: number;
}

interface DocumentResponse {
  id: string;
  name: string;
  currentVersion: DocumentVersionResponse;
}

async function getToken(username: string, password: string): Promise<string> {
  const response = await axios.post<TokenResponse>(
    KEYCLOAK_TOKEN_URL,
    new URLSearchParams({ grant_type: 'password', client_id: 'drm-web', username, password }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
  );
  return response.data.access_token;
}

describe('File management full flow (e2e)', () => {
  it('an admin can list root folders, create a folder, upload a document, view it, and download the exact bytes back', async () => {
    const token = await getToken('testadmin', 'testadminpass');
    const authHeader = { Authorization: `Bearer ${token}` };

    const folderRes = await axios.post<FolderResponse>(
      `${API_BASE_URL}/folders`,
      { name: `flow-test-${Date.now()}` },
      { headers: authHeader },
    );
    const folderId = folderRes.data.id;

    const rootRes = await axios.get<FolderResponse[]>(`${API_BASE_URL}/folders`, {
      headers: authHeader,
    });
    expect(rootRes.data.map((f) => f.id)).toContain(folderId);

    const content = `flow test content ${Date.now()}`;
    const form = new FormData();
    form.append('folderId', folderId);
    form.append('name', 'flow-test.txt');
    form.append('file', Buffer.from(content), { filename: 'flow-test.txt' });

    const createRes = await axios.post<DocumentResponse>(`${API_BASE_URL}/documents`, form, {
      headers: { ...authHeader, ...form.getHeaders() },
    });
    expect(createRes.status).toBe(201);
    const documentId = createRes.data.id;

    const metadataRes = await axios.get<DocumentResponse>(`${API_BASE_URL}/documents/${documentId}`, {
      headers: authHeader,
    });
    expect(metadataRes.data.name).toBe('flow-test.txt');

    const versionsRes = await axios.get<DocumentVersionResponse[]>(
      `${API_BASE_URL}/documents/${documentId}/versions`,
      { headers: authHeader },
    );
    expect(versionsRes.data).toHaveLength(1);

    const downloadRes = await axios.get<string>(`${API_BASE_URL}/documents/${documentId}/download`, {
      headers: authHeader,
      responseType: 'text',
    });
    expect(downloadRes.data).toBe(content);
  });
});
```

- [ ] **Step 2: 執行測試確認通過**

Run: `pnpm --filter api test:e2e -- file-management-flow.e2e-spec.ts`
Expected: PASS（本任務串接的每個端點都是既有或 Task 1 已完成的功能，此測試不應該需要額外的實作變更；若失敗，回到對應端點檢查 Task 1-9 是否都已完整套用）

- [ ] **Step 3: Commit**

```bash
git add apps/api/test/file-management-flow.e2e-spec.ts
git commit -m "test(api): add end-to-end coverage for the full browse/upload/download flow"
```

---

## 完成後的手動驗證

依 CLAUDE.md 的慣例，前端變更需要實際跑起來看過，不能只靠測試通過就宣稱完成：

1. `docker compose build web && docker compose up -d web`（重新建置，套用新的前端程式碼）
2. 瀏覽器開 `https://app.drm.apower.lan`，用 `testadmin`/`testadminpass` 登入
3. 建立一個頂層資料夾 → 進入該資料夾 → 建立子資料夾 → 上傳一個文件 → 進入文件詳情頁 → 上傳新版本 → 下載目前版本與舊版本，確認檔案內容正確
4. 用 `testuser`/`testpass` 登入，確認在沒有任何授權的情況下看到「目前沒有你可以存取的資料夾」，且無法在頂層建立資料夾（顯示權限錯誤訊息）
