# 權限管理 UI 設計文件

- 日期：2026-08-07
- 狀態：已核准，待轉入實作計畫
- 前置文件：[[2026-08-05-file-management-frontend-design.md]]（核心瀏覽功能，本文件依賴其路由/元件慣例）、[[2026-08-06-frontend-backlog.md]]（本項目來源）

## 背景

檔案管理前端目前沒有任何權限管理介面。後端 `apps/api/src/permissions` 已經有完整的 grant/revoke/list ACL 端點（`POST`/`GET`/`DELETE /folders/:id/permissions`、`/documents/:id/permissions`），也有完整的 `AclService`（層級式權限 `view < download < edit < manage`、資料夾鏈繼承解析），但沒有任何前端介面可以呼叫。有 `manage` 權限的使用者目前只能透過直接呼叫 API 來管理誰可以存取一份資料夾或文件。

調查後端時發現一個關鍵缺口：**後端沒有任何使用者搜尋/列表 API**（`GET /whoami` 只能查自己）。要授權給某個人，前端需要知道對方的 `User.id`（uuid），但目前無從查起。這次一併補上一支後端使用者搜尋端點。

## 範疇

**這次做的：**
- 後端：新增 `GET /users?search=<query>`（任何登入使用者可呼叫，模糊比對 email/displayName）
- 後端：擴充既有 `GET /folders/:id/permissions`、`GET /documents/:id/permissions` 回應，每筆加上 `principal: { email, displayName }`
- 前端：資料夾與文件都支援權限管理（對稱處理，共用元件）
- 前端：獨立頁面 `/folders/:id/permissions`、`/documents/:id/permissions`
- 前端：`FolderView`、`DocumentView` 各加一個「權限」連結，導向對應頁面（對所有登入使用者顯示，進頁後才由 403 決定看不看得到內容）
- 前端：頁面內容含「現有授權清單」（顯示中人、層級、授權時間、撤銷按鈕）與「新增授權表單」（搜尋使用者→選人→選層級→送出）

**這次不做（維持原狀）：**
- 不支援 `principalType: 'group'`（後端目前會回 400 拒絕，這次不處理群組授權）
- 不新增「我能不能管理這個資源」的快速查詢端點——頁面直接呼叫 `GET .../permissions`，用既有的錯誤處理模式接住 403
- 不特別標示「直接授權」vs「繼承授權」的視覺差異（`GET .../permissions` 本來就只回傳該資源的直接授權列表，不含從父層繼承來的部分；繼承語意維持後端既有行為，前端只管理直接授權）
- 不做使用者搜尋結果的分頁（後端限制回傳最多 20 筆，這次先不做「還有更多結果」的 UI）

## 後端設計

### 新增：`GET /users?search=<query>`

- **檔案**：`apps/api/src/users/users.controller.ts`（新增 route）、`apps/api/src/users/users.service.ts`（新增方法）
- **權限**：`@UseGuards(AuthGuard('jwt'))`，不需要額外的角色/ACL 檢查——任何登入使用者都可以呼叫
- **Query 參數**：`search`（必填，非空字串；空字串或缺少回 400）
- **比對邏輯**：對 `User.email` 與 `User.displayName` 做不分大小寫的 `contains` 比對（Prisma `mode: 'insensitive'`），OR 條件
- **回傳**：最多 20 筆，依 `displayName` 排序，欄位為 `{ id, email, displayName, department }`（**不含** `keycloakSub`）
- **回應型別**：`UserSummary[]`

### 擴充：`GET /folders/:id/permissions`、`GET /documents/:id/permissions`

- **檔案**：`apps/api/src/permissions/permissions.service.ts`（`listPermissions` 方法）
- 在既有查詢後，對回傳的每筆 `Permission`（`principalType === 'user'`）額外查一次對應的 `User`，組成 `{ ...permission, principal: { email, displayName } }`。`principalType === 'group'` 的資料列（目前系統中應該不存在，因為 grant 已擋掉 group）維持 `principal: null`
- 這是既有端點回應的**相容性擴充**（新增欄位，不改動/移除任何既有欄位），現有呼叫方不受影響

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
export interface PermissionEntry {
  id: string;
  resourceType: 'folder' | 'document';
  resourceId: string;
  principalType: 'user' | 'group';
  principalId: string;
  permissionLevel: 'view' | 'download' | 'edit' | 'manage';
  grantedBy: string;
  grantedAt: string;
  principal: { email: string; displayName: string } | null;
}

export function listPermissions(
  resourceType: 'folder' | 'document',
  resourceId: string,
  accessToken: string,
) {
  return apiFetch<PermissionEntry[]>(`/${resourceType}s/${resourceId}/permissions`, accessToken);
}

export function grantPermission(
  resourceType: 'folder' | 'document',
  resourceId: string,
  input: { principalId: string; permissionLevel: PermissionEntry['permissionLevel'] },
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

### 新增：`components/PermissionsPanel.tsx`

共用元件，資料夾與文件頁共用，因為權限語意完全相同：

```
PermissionsPanel({ resourceType, resourceId }: { resourceType: 'folder' | 'document'; resourceId: string })
├─ useQuery(['permissions', resourceType, resourceId], () => listPermissions(...))
│    ├─ isLoading → data-testid="loading"
│    ├─ isError（403 等）→ friendlyErrorMessage，data-testid="error"
│    └─ 成功 → 現有授權表格 + 新增授權表單
├─ 現有授權表格：每列顯示 principal.displayName（次要顯示 email）、permissionLevel、grantedAt、撤銷按鈕
│    └─ 撤銷 useMutation → revokePermission → 成功後 invalidateQueries(['permissions', resourceType, resourceId])
└─ 新增授權表單（內部 state：搜尋字串、選中的 UserSummary、選擇的 level）
     ├─ 搜尋輸入框 + 「搜尋」按鈕 → useQuery(['userSearch', query], enabled: 有按下搜尋)
     ├─ 搜尋結果列表（點擊一筆設為「已選使用者」，顯示 displayName/email）
     ├─ 權限層級下拉選單（view/download/edit/manage）
     └─ 「授權」按鈕 → useMutation → grantPermission → 成功後清空表單、invalidateQueries
```

- 搜尋不是即時 debounce type-ahead，而是「輸入完按搜尋鍵/按鈕」的明確步驟，避免這次要新做一個 combobox 元件（YAGNI，符合專案目前只有 Button/Dialog/Table 這幾個基礎元件的現況）
- 沒有結果時顯示「找不到符合的使用者」

### 新增路由：`routes/FolderPermissions.tsx`、`routes/DocumentPermissions.tsx`

兩個路由元件都很薄，只負責從 `useParams` 取出 `:id`，包一層 `max-w-4xl mx-auto` 版面容器 + 標題，內容交給 `PermissionsPanel`：

```tsx
// routes/FolderPermissions.tsx（DocumentPermissions.tsx 對稱，resourceType 換成 'document'）
export function FolderPermissions() {
  const { id } = useParams<{ id: string }>();
  return (
    <div className="mx-auto max-w-4xl px-6 py-8">
      <h1 className="mb-6 text-xl font-bold">權限管理</h1>
      <PermissionsPanel resourceType="folder" resourceId={id ?? ''} />
    </div>
  );
}
```

### 修改：`App.tsx`

在 `Navbar` layout route 底下追加兩條路由：

```tsx
<Route path="/folders/:id/permissions" element={<FolderPermissions />} />
<Route path="/documents/:id/permissions" element={<DocumentPermissions />} />
```

### 修改：`routes/FolderView.tsx`、`routes/DocumentView.tsx`

各加一個到權限頁面的連結（`<Link to={...permissions}>權限</Link>`），放在頁面既有的操作按鈕群組旁邊，對所有登入使用者顯示（不依角色/權限做前端 gate，403 交給權限頁面自己處理，跟稍早導覽列改版「登入前畫面套用品牌風格」時同一套處理哲學一致：能做的檢查前端做，做不到的檢查讓後端 403 把關，前端只負責把錯誤訊息顯示友善）

## 錯誤處理

- **搜尋使用者失敗**（網路錯誤等）→ 表單內顯示 `friendlyErrorMessage`
- **搜尋沒有結果** → 「找不到符合的使用者」（不是錯誤，是空狀態）
- **授權失敗**（400 重複/群組被拒、403 沒有 manage 權限）→ 表單內顯示錯誤，不清空已輸入的欄位，讓使用者可以修改重試
- **撤銷失敗**（404 已經被別人先撤銷、403 失去 manage 權限）→ 顯示錯誤，重新整理清單（`invalidateQueries`）反映實際狀態
- **整頁 403**（沒有 manage 這個資源的權限）→ 沿用既有 `friendlyErrorMessage` 模式：「你沒有存取這個項目的權限」

## 測試策略

回到第一階段的逐 Task TDD 節奏（每個 Task 先寫失敗測試再實作），不延續視覺改版那次「先實作後補測試」的例外安排：

- **後端**：`apps/api/test/users.e2e-spec.ts`（新檔案）——搜尋比對 email/displayName、空 query 回 400、未登入回 401、結果不含敏感欄位、上限 20 筆；`apps/api/test/permissions.e2e-spec.ts`（既有檔案，追加測試）——確認 `GET .../permissions` 回應現在包含 `principal.displayName`/`principal.email`
- **前端 RTL**：`api/users.test.ts`、`api/permissions.test.ts`（沿用 `api/client.test.ts` 既有 mock fetch 模式）；`components/PermissionsPanel.test.tsx`（列表渲染、搜尋流程、授權流程、撤銷流程、各種錯誤狀態，mock `listPermissions`/`searchUsers`/`grantPermission`/`revokePermission`）；`routes/FolderPermissions.test.tsx`、`routes/DocumentPermissions.test.tsx`（薄封裝，主要測 `:id` 有正確傳給 `PermissionsPanel`）
- 不需要額外的瀏覽器手動驗證清單之外的東西——沿用專案既有慣例（前端變更需要實際跑起來看過），計畫裡會有對應的手動驗證 Task

## 範疇之外（留待之後）

- 群組（`group`）principal 支援
- 「我能不能管理這個資源」的快速查詢端點 / 前端依此隱藏「權限」連結
- 直接授權 vs 繼承授權的視覺區分
- 使用者搜尋結果分頁 / debounce type-ahead
