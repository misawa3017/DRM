# 權限管理 UI 設計文件

- 日期：2026-08-07
- 狀態：已核准，待轉入實作計畫
- 前置文件：[[2026-08-05-file-management-frontend-design.md]]（核心瀏覽功能，本文件依賴其路由/元件慣例）、[[2026-08-06-file-management-frontend-navbar-redesign-design.md]]（導覽列元件，本文件會擴充它）、[[2026-08-06-frontend-backlog.md]]（本項目來源）

## 背景

檔案管理前端目前沒有任何權限管理介面。後端 `apps/api/src/permissions` 已經有完整的 grant/revoke/list ACL 端點（`POST`/`GET`/`DELETE /folders/:id/permissions`、`/documents/:id/permissions`），也有完整的 `AclService`（層級式權限 `view < download < edit < manage`、資料夾鏈繼承解析：`resolveLevel` 沿父層鏈往上找「最近的一筆明確授權」，不合併多層授權），但沒有任何前端介面可以呼叫。有 `manage` 權限的使用者目前只能透過直接呼叫 API 來管理誰可以存取一份資料夾或文件。

調查後端時發現一個關鍵缺口：**後端沒有任何使用者搜尋/列表 API**（`GET /whoami` 只能查自己）。要授權給某個人，前端需要知道對方的 `User.id`（uuid），但目前無從查起。這次一併補上一支後端使用者搜尋端點。

設計過程中比較了兩種入口方式：（1）從每個資料夾/文件頁面點進去管理該資源自己的權限、（2）導覽列一個獨立的「權限管理」全域儀表板，跨資源列出使用者管理得到的所有授權。選了後者——一次看到全貌，比逐一點進每個資料夾更符合實際使用情境。

## 範疇

**這次做的：**
- 後端：新增 `GET /users?search=<query>`（任何登入使用者可呼叫，模糊比對 email/displayName）
- 後端：新增 `GET /permissions?includeInherited=<bool>`——全域授權查詢，回傳目前使用者「管理得到」的所有資源的授權紀錄（細節見下方「後端設計」）
- 後端：擴充既有 `GET /folders/:id/permissions`、`GET /documents/:id/permissions` 回應，每筆加上 `principal: { email, displayName }`（給資源自己的權限頁維持可用，也給全域端點共用同一個 enrichment 邏輯）
- 前端：`Navbar` 新增分頁式導覽連結（「資料夾」／「權限管理」），品牌標記右邊
- 前端：新路由 `/permissions`——全域權限儀表板：預設顯示直接管理的資源授權（快查詢），有一個「顯示繼承項目」按鈕觸發較慢的遞迴查詢、把透過資料夾繼承管得到的子項也併入，每筆標示來源（直接管理／繼承自某資料夾）
- 前端：篩選（資源名稱/使用者關鍵字、資源類型、權限層級）
- 前端：新增授權表單同時要選「資源」與「使用者」——資源用一個重用既有資料夾瀏覽邏輯的選擇器（逐層點進資料夾，可選資料夾本身或裡面的文件），使用者用搜尋（同上）
- 前端：資料夾/文件各自的權限管理仍然存在（`/folders/:id/permissions`、`/documents/:id/permissions`，`FolderView`/`DocumentView` 各有「權限」連結），跟全域儀表板共用同一套 `PermissionsPanel`/授權/撤銷邏輯，只是資料來源從全域端點換成資源專屬端點

**這次不做（維持原狀）：**
- 不支援 `principalType: 'group'`（後端目前會回 400 拒絕）
- 不新增「我能不能管理這個資源」的快速查詢端點——資源專屬權限頁面直接呼叫 `GET .../permissions`，用既有的錯誤處理模式接住 403
- 不做全域端點的分頁（先回傳全部符合的紀錄；資料量大到需要分頁是下一輪的問題，見「範疇之外」）
- 不做使用者搜尋結果的分頁（後端限制回傳最多 20 筆）
- 不做「顯示繼承項目」查詢的效能優化（例如快取、限制遞迴深度）——先求正確，效能問題等實際資料量出現再處理

## 後端設計

### 新增：`GET /users?search=<query>`

- **檔案**：`apps/api/src/users/users.controller.ts`（新增 route）、`apps/api/src/users/users.service.ts`（新增方法）
- **權限**：`@UseGuards(AuthGuard('jwt'))`，不需要額外的角色/ACL 檢查——任何登入使用者都可以呼叫
- **Query 參數**：`search`（必填，非空字串；空字串或缺少回 400）
- **比對邏輯**：對 `User.email` 與 `User.displayName` 做不分大小寫的 `contains` 比對（Prisma `mode: 'insensitive'`），OR 條件
- **回傳**：最多 20 筆，依 `displayName` 排序，欄位為 `{ id, email, displayName, department }`（**不含** `keycloakSub`）

### 擴充：`GET /folders/:id/permissions`、`GET /documents/:id/permissions`

- **檔案**：`apps/api/src/permissions/permissions.service.ts`（`listPermissions` 方法）
- 在既有查詢後，對回傳的每筆 `Permission`（`principalType === 'user'`）額外查一次對應的 `User`，組成 `{ ...permission, principal: { email, displayName } }`。`group` principal（目前系統中應該不存在）維持 `principal: null`
- 相容性擴充（新增欄位，不改動/移除任何既有欄位），現有呼叫方不受影響

### 新增：`GET /permissions?includeInherited=<bool>`（全域查詢，這次工作量最大的部分）

- **檔案**：`apps/api/src/permissions/permissions.controller.ts`（新 route）、`apps/api/src/permissions/permissions.service.ts`（新方法 `listGlobal`）、`apps/api/src/acl/acl.service.ts`（新方法 `findManagedResources`，見下）
- **權限**：`@UseGuards(AuthGuard('jwt'))`，任何登入使用者可呼叫；回傳內容依呼叫者身分而不同（見下方演算法），不需要額外的路由層級限制
- **Query 參數**：`includeInherited`（選填，預設 `false`）

**判斷「使用者管理得到哪些資源」的演算法**（`AclService.findManagedResources(user, includeInherited)`）：

1. **`admin` 角色**：直接回傳「不限制」——後續查詢不篩選 `resourceId`，等同於系統中所有資源
2. **非 admin，`includeInherited = false`**：查 `Permission.findMany({ where: { principalType: 'user', principalId: user.id, permissionLevel: 'manage' } })`，取得的每一筆 `{resourceType, resourceId}` 就是使用者「直接管理」的資源，`source: 'direct'`
3. **非 admin，`includeInherited = true`**：從步驟 2 的直接管理清單出發，對其中每一筆 `resourceType === 'folder'` 的資源，遞迴走訪其所有子資料夾與子文件（`parentId`/`folderId` 鏈）。走訪時在每個節點：
   - 檢查該節點是否有使用者自己的明確授權（`Permission` 對這個確切 `resourceId` 有沒有這個 `principalId` 的紀錄）
   - 有明確授權 → 這個節點的「有效層級」就是那筆授權的 `permissionLevel`，作為它自己的最近授權來源，繼續往下傳給它的子孫
   - 沒有明確授權 → 沿用從上層傳下來的「最近授權來源」的層級
   - 若最終有效層級是 `manage` → 納入管理清單，`source: { inheritedFrom: <該授權來源資源的 id/name> }`；若不是（更低層級，或壓根沒有繼承鏈——理論上不會發生，因為只從「直接管理」的資料夾出發）→ 不納入
   - **注意：不能因為某節點的有效層級掉到 `manage` 以下就停止往下遞迴**——它的子孫仍可能有自己獨立的 `manage` 授權（`resolveLevel` 的「最近授權優先」語意允許更深層重新拿到 `manage`），所以要遍歷完整棵子樹，沒有提前剪枝的安全捷徑。這是效能與正確性的直接取捨，見上方「範疇之外」

**組裝回應**：對演算法回傳的資源集合（或「不限制」時的全部資源），查出它們各自的所有 `Permission` 紀錄，each 加上：
- `resourceName`、`resourcePath`（資料夾用其祖先鏈組成 `"Root / A / B"`；文件用其所屬資料夾的祖先鏈 + 資料夾本身）——沿用/重構既有 `resolveLevel` 已經在用的父層走訪邏輯，避免重複實作
- `principal: { email, displayName }`（同上方 enrichment）
- `source: 'direct' | { inheritedFrom: { resourceId, resourceName } }`

**回應型別**：`GlobalPermissionEntry[]`

## 前端設計

### 新增：`api/users.ts`

```ts
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

### 新增：`api/permissions.ts`

```ts
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

### 新增：`components/ResourcePicker.tsx`

彈出視窗（沿用既有 `Dialog`），重用資料夾瀏覽邏輯讓使用者逐層點進資料夾選資源：

```
ResourcePicker({ open, onOpenChange, onSelect }: { open: boolean; onOpenChange: (v: boolean) => void; onSelect: (r: { resourceType: 'folder'|'document'; resourceId: string; name: string }) => void })
├─ 內部 state：目前瀏覽到的 folderId（null = 顯示頂層，重用 listRootFolders）
├─ folderId 非 null 時 → 呼叫既有 getFolder(folderId)，顯示：
│    ├─「選擇這個資料夾」按鈕（選定目前資料夾本身）→ onSelect({ resourceType: 'folder', ... })
│    ├─ 子資料夾清單，點擊 → 進入該子資料夾（folderId 換成子項 id）
│    └─ 文件清單，點擊 → onSelect({ resourceType: 'document', ... })
└─ folderId 為 null 時 → 顯示頂層資料夾清單（重用 listRootFolders），點擊進入
```

- 不需要新的後端端點——完全重用 Task 1 階段就有的 `listRootFolders`/`getFolder`
- 選定後 `Dialog` 關閉，把選到的資源顯示在外層表單上

### 新增：`components/PermissionsTable.tsx`

授權紀錄表格，資源專屬頁與全域儀表板共用：

```
PermissionsTable({ entries, showResourceColumn, onRevoke }: {
  entries: PermissionEntry[] | GlobalPermissionEntry[];
  showResourceColumn: boolean;  // 全域儀表板傳 true 多顯示一欄資源名稱+路徑，資源專屬頁傳 false
  onRevoke: (permissionId: string) => void;
})
```

- 每列：`showResourceColumn` 為 `true` 時最前面多一欄資源名稱+路徑、最後面多一欄來源標籤（直接管理／繼承自 X，只有 `GlobalPermissionEntry` 才有 `source` 欄位）；不論 `showResourceColumn` 為何都固定顯示的欄位：principal 顯示名稱+email → 權限層級（用色塊區分四個層級，比照這次做的 mockup）→ 授權時間 → 撤銷按鈕

### 新增：`components/GrantPermissionForm.tsx`

新增授權表單，資源專屬頁與全域儀表板共用，差別在於資源是否已知：

```
GrantPermissionForm({ fixedResource }: { fixedResource?: { resourceType: 'folder'|'document'; resourceId: string } })
```

- `fixedResource` 有值（資源專屬頁的情境）→ 不顯示資源選擇，表單只有「搜尋使用者→選人→選層級→授權」
- `fixedResource` 未提供（全域儀表板的情境）→ 表單最上面多一個「選擇資源」按鈕，開啟 `ResourcePicker`，選定後才能繼續選使用者/層級
- 搜尋使用者：輸入完按「搜尋」按鈕（不是即時 debounce type-ahead，避免這次新做一個 combobox 元件，YAGNI）→ 結果列表點選一筆
- 送出呼叫 `grantPermission(resourceType, resourceId, { principalId, permissionLevel }, accessToken)`

### 新增：`routes/PermissionsDashboard.tsx`（`/permissions`）

```
PermissionsDashboard()
├─ 內部 state：includeInherited（預設 false）、篩選字串、資源類型篩選、層級篩選
├─ useQuery(['globalPermissions', includeInherited], () => listGlobalPermissions(includeInherited, token))
│    ├─ includeInherited 從 false 切成 true 時才會觸發那支較慢的查詢（query key 改變，react-query 自動重打）
│    ├─ isLoading → data-testid="loading"（含「顯示繼承項目」按鈕本身顯示 loading 狀態，避免使用者重複點擊觸發重複查詢）
│    └─ isError → friendlyErrorMessage
├─ 篩選：前端本地篩選已經抓回來的資料（資源名稱/使用者關鍵字比對 resourceName/principal.displayName/principal.email；資源類型/層級是精確比對），不重新打 API——資料量在這次範疇內不需要伺服器端篩選
├─「顯示繼承項目」切換按鈕（未按下前 includeInherited=false，按下後永久是 true，沒有「再按一次收合」——收合的話原本繼承進來的授權管理權限就消失了，語意上更接近「載入更多」而不是「切換顯示」）
├─「＋ 新增授權」按鈕 → 開啟 `GrantPermissionForm`（無 `fixedResource`，含 `ResourcePicker`）
└─ 渲染 `PermissionsTable`（`showResourceColumn: true`）
```

### 新增：`routes/FolderPermissions.tsx`、`routes/DocumentPermissions.tsx`（資源專屬，`/folders/:id/permissions`、`/documents/:id/permissions`）

```
FolderPermissions()  // DocumentPermissions.tsx 對稱，resourceType 換成 'document'
├─ useParams 取 :id
├─ useQuery(['permissions', 'folder', id], () => listPermissions('folder', id, token))
├─「＋ 新增授權」按鈕 → 開啟 `GrantPermissionForm`（`fixedResource: { resourceType: 'folder', resourceId: id }`，不含 `ResourcePicker`）
└─ 渲染 `PermissionsTable`（`showResourceColumn: false`）
```

### 修改：`components/Navbar.tsx`

品牌標記與麵包屑 slot 之間，新增分頁式導覽連結：

```tsx
<nav className="flex gap-4 text-sm">
  <NavLink to="/" end className={({ isActive }) => isActive ? 'font-semibold text-white' : 'text-primary-foreground/75'}>
    資料夾
  </NavLink>
  <NavLink to="/permissions" className={({ isActive }) => isActive ? 'font-semibold text-white' : 'text-primary-foreground/75'}>
    權限管理
  </NavLink>
</nav>
```

（用 `react-router-dom` 既有的 `NavLink`，`isActive` 自動判斷目前路徑，不用自己手刻）

### 修改：`App.tsx`

在 `Navbar` layout route 底下追加路由：

```tsx
<Route path="/permissions" element={<PermissionsDashboard />} />
<Route path="/folders/:id/permissions" element={<FolderPermissions />} />
<Route path="/documents/:id/permissions" element={<DocumentPermissions />} />
```

### 修改：`routes/FolderView.tsx`、`routes/DocumentView.tsx`

各加一個到資源專屬權限頁面的連結（`<Link to={...permissions}>權限</Link>`），對所有登入使用者顯示，403 交給權限頁面處理（跟導覽列改版時「登入前畫面套用品牌風格」同一套哲學：前端能做的檢查前端做，做不到的讓後端 403 把關）

## 錯誤處理

- **搜尋使用者失敗/沒有結果** → 表單內 `friendlyErrorMessage` / 「找不到符合的使用者」
- **授權失敗**（400 重複/群組被拒、403 沒有 manage 權限）→ 表單內顯示錯誤，不清空已輸入的欄位
- **撤銷失敗**（404 已經被別人先撤銷、403 失去 manage 權限）→ 顯示錯誤，`invalidateQueries` 重新整理清單
- **全域儀表板 `includeInherited=true` 查詢失敗或逾時** → 沿用一般 `isError` 處理，`friendlyErrorMessage`；不做重試/降級（範疇之外）
- **資源專屬頁整頁 403** → 沿用既有 `friendlyErrorMessage` 模式

## 測試策略

回到第一階段的逐 Task TDD 節奏（每個 Task 先寫失敗測試再實作），不延續視覺改版那次「先實作後補測試」的例外安排：

- **後端**：
  - `apps/api/test/users.e2e-spec.ts`（新檔案）——搜尋比對、空 query 400、未登入 401、結果不含敏感欄位、上限 20 筆
  - `apps/api/test/permissions.e2e-spec.ts`（既有檔案，追加）——`GET .../permissions` 回應含 `principal`
  - `apps/api/test/global-permissions.e2e-spec.ts`（新檔案）——建構一個多層資料夾＋覆蓋授權的 fixture（比照這次 mockup 的例子：manage 授權在父層、子項有自己獨立的授權覆蓋），驗證 `includeInherited=false` 只回傳直接管理的資源、`=true` 正確納入繼承子項且 `source` 標示正確、被明確降級的分支不誤入清單、admin 看到全部、非 admin 看不到管理範圍外的資源
  - `apps/api/src/acl/acl.service.spec.ts`（既有檔案，追加）——`findManagedResources` 的單元測試，涵蓋「深層子孫重新拿到 manage」這種不能提前剪枝的情境
- **前端 RTL**：`api/users.test.ts`、`api/permissions.test.ts`；`components/ResourcePicker.test.tsx`、`components/PermissionsTable.test.tsx`、`components/GrantPermissionForm.test.tsx`（兩種模式：`fixedResource` 有無）；`routes/PermissionsDashboard.test.tsx`（含篩選、「顯示繼承項目」切換行為）；`routes/FolderPermissions.test.tsx`、`routes/DocumentPermissions.test.tsx`；`components/Navbar.test.tsx`（追加：新的分頁連結、`isActive` 狀態）
- 手動瀏覽器驗證：計畫裡會有對應 Task，比照既有慣例

## 範疇之外（留待之後）

- 群組（`group`）principal 支援
- 全域端點的伺服器端分頁/篩選（目前資料量小，前端本地篩選足夠）
- `includeInherited=true` 查詢的效能優化（快取、深度限制）
- 「我能不能管理這個資源」的快速查詢端點
- 資源選擇器（`ResourcePicker`）的關鍵字搜尋（目前只能逐層點進去找）
