# 檔案管理前端視覺改版（導覽列 + 內容區）設計文件

- 日期：2026-08-06
- 狀態：已核准，待轉入實作計畫
- 前置文件：[[2026-08-05-file-management-frontend-design.md]]（第一階段核心瀏覽功能，本文件是其視覺改版）

## 背景

第一階段（核心瀏覽）功能已實作完成並通過測試，但介面完全沒有視覺設計：登入後直接看到 `Home.tsx` 印出的一段 `Email/Name/Roles` 純文字、一個原生無樣式的「Log out」按鈕，資料夾/文件清單雖然套了 Tailwind，但欄位間距很窄、沒有圖示、沒有卡片框，長列表時觀感上跟未套樣式的純文字表格幾乎沒有分別。使用者實際操作後回饋「樣式太陽春，操作介面不友善」。本文件規劃一次視覺改版：加入常駐導覽列、統一品牌色、優化內容區列表呈現。

## 範疇

**這次做的：**
- 新增 `Navbar` 元件（登入後常駐於頁面最上方），取代目前的裸 `<button>Log out</button>` 與獨立的 `Home` whoami 文字區塊
- 品牌主色改為藍色系（取代 shadcn 預設的黑白灰中性色），套用到導覽列底色、`Button` 的 `default` variant、連結 hover 狀態
- 簡易 DRM 品牌標記（lucide-react 圖示 + 文字組合），非外部圖檔
- `RootFolders`、`FolderView`、`DocumentView` 的表格視覺優化：卡片外框、資料夾/文件類型圖示、列高與間距加大、hover 高亮
- 空狀態（無可存取資料夾）改用卡片包裝 + 圖示，取代單行文字
- 版面整體置中並限制最大寬度（不滿版拉伸）

**這次不做（維持原狀）：**
- 不新增任何後端 API、不改資料流邏輯（`api/folders.ts`、`api/documents.ts` 不動）
- 不做響應式/行動裝置版面（沿用桌面優先，這點與現有專案一致）
- 不做深色模式（沿用專案目前無 dark mode 的狀態；`tailwind.config.js` 的 CSS 變數維持單一主題）
- `MaintenanceNotice` 元件本身外觀不變，只調整它與新 `Navbar` 的堆疊順序

## 設計系統

### 色彩 token（`src/index.css` 的 CSS 變數）

沿用現有的 HSL CSS 變數架構（`--primary`、`--background`、`--muted` 等），只換數值，不改變數名稱與既有元件（`Button`/`Dialog`/`Table`）的 class 依賴關係：

| Token | 現值（中性灰黑） | 新值（藍色系） | 用途 |
|---|---|---|---|
| `--primary` | `222.2 47.4% 11.2%`（近黑） | `217 58% 27%`（深藍 `#1B3A6B`） | 導覽列底色、`Button default` 背景、連結 hover |
| `--primary-foreground` | `210 40% 98%` | 不變 | 導覽列文字、按鈕文字 |
| `--ring` | `222.2 84% 4.9%` | `217 58% 27%` | focus ring 跟隨品牌色 |
| 其餘（`--background`/`--border`/`--muted` 等） | 不變 | 不變 | 維持現有中性灰階，只有品牌強調色改變 |

### 圖示

新增依賴 `lucide-react`（`Folder`、`FileText`、`FolderOpen`）。品牌標記用 `Folder` 圖示放在一個白底圓角方塊內，搭配「DRM」文字，不使用外部圖片檔。

### 版面密度

內容區改用寬鬆間距：`TableCell` 的 padding 由現行 `p-2` 調整為 `py-3.5 px-5`；頁面內容容器加 `max-w-4xl mx-auto`。

## 元件結構

### 新增：`components/Navbar.tsx` + `components/NavbarBreadcrumbContext.tsx`

`Navbar` 必須整個登入 session 只掛載一次（避免路由切換時重複打 `/whoami`），但中間的麵包屑內容要能隨頁面變化。做法是 layout route + context，而不是每個頁面各自包一層 `<Navbar>`：

```
NavbarBreadcrumbContext.tsx
├─ React Context，內部 state: crumbNode: ReactNode | null
├─ export function useSetNavbarCrumb(node: ReactNode | null): void
│     └─ useEffect(() => { setCrumbNode(node); return () => setCrumbNode(null); }, [node])
│        （unmount 時自動清空，離開 FolderView/DocumentView 回到 RootFolders 時麵包屑自然消失）
└─ export function useNavbarCrumb(): ReactNode | null  // 給 Navbar 內部讀取

Navbar.tsx
├─ 品牌標記（Link to "/"）：圖示方塊 + "DRM" 文字
├─ 中間 slot：呼叫 useNavbarCrumb() 讀出目前頁面設定的麵包屑內容，RootFolders 沒設定時為 null（留空）
├─ 使用者區塊：角色 pill（來自 /whoami 的 roles[0]）+ displayName + 登出按鈕
└─ 內部渲染 <Outlet />（layout route 寫法），子路由畫面顯示在 Navbar 下方
```

- `/whoami` 呼叫（沿用 `Home.tsx` 現有的 fetch 邏輯，搬移過來，`Home.tsx` 整支刪除）與 `useAuth()`（`access_token`、`signoutRedirect`）都在 `Navbar` 內部，因為只掛載一次，不會重複請求
- `FolderView`/`DocumentView` 內部呼叫 `useSetNavbarCrumb(<Breadcrumb .../>)`（一個 `useEffect`），把自己的麵包屑內容送進 context 讓 `Navbar` 顯示；`RootFolders` 不呼叫，維持 null

### 修改：`App.tsx`

- 移除裸 `<button>Log out</button>` 與 `<Home accessToken=... />`
- 已登入分支改為 layout route 寫法：
  ```tsx
  <Routes>
    <Route element={<Navbar />}>
      <Route path="/" element={<RootFolders />} />
      <Route path="/folders/:id" element={<FolderView />} />
      <Route path="/documents/:id" element={<DocumentView />} />
    </Route>
  </Routes>
  ```
  `MaintenanceNotice` 留在 `<Routes>` 外層最上方，不受影響

### 修改：`routes/FolderView.tsx`、`routes/DocumentView.tsx`

- `FolderView` 目前在頁面內容區頂部直接 render `<Breadcrumb .../>`；改為呼叫 `useSetNavbarCrumb(<Breadcrumb .../>)` 把麵包屑送進 `Navbar`，頁面內容區本身不再重複顯示麵包屑
- 三個路由元件本身的資料邏輯（`useQuery`、`useMutation`）完全不動，只動最外層的 JSX 包裝

### 修改：`components/ui/table.tsx`

- `TableCell`/`TableHead` 的預設 padding class 由 `p-2` 改為 `py-3.5 px-5`
- `TableRow` 加上 `hover:bg-muted/50`（若尚未存在則補上；目前已有）

### 修改：`routes/RootFolders.tsx`、`routes/FolderView.tsx`

- 每個資料夾/文件名稱前加 `<Folder>`/`<FileText>` 圖示（lucide-react），跟連結文字一起包在 flex 容器內
- 外層包 `<div className="rounded-lg border bg-background">` 卡片容器
- 空狀態（`data-testid="empty"`）改為置中卡片：圖示 + 文字，取代目前單一 `<p>`

## 測試策略

延續專案既有的 RTL + `data-testid` 慣例：

- `NavbarBreadcrumbContext` 的 `useNavbarCrumb`/`useSetNavbarCrumb` 在沒有 `Provider` 包裹時要有安全預設值（`crumbNode: null`、`setCrumbNode` 是 no-op），這樣 `FolderView.test.tsx`/`DocumentView.test.tsx` 現有的 `renderWithProviders(<FolderView />, ...)`（不含 `Navbar`）呼叫 `useSetNavbarCrumb` 時才不會噴錯，既有測試檔案不需要額外包一層 `Navbar` 就能維持原樣通過
- 新增 `test/components/Navbar.test.tsx`：mock `useAuth`、mock `/whoami` fetch，驗證品牌連結、角色 pill、displayName、登出按鈕 `onClick` 觸發 `signoutRedirect`，以及 `useNavbarCrumb()` 回傳的內容有被渲染在導覽列中間
- 刪除 `test/Home.test.tsx`（連同 `src/Home.tsx` 一併移除，邏輯併入 `Navbar`）
- `test/App.test.tsx` 既有的登出前案例（維護公告 + Log in 按鈕）不受影響，維持原樣；另外補一個登入後案例，驗證 layout route 掛好後 `Navbar` 有渲染、且 `/` 對應到 `RootFolders`
- `test/routes/FolderView.test.tsx`、`test/routes/DocumentView.test.tsx`：既有斷言（`getByRole('link', {name: 'Q1'})` 等）不需要改動，因為 `Breadcrumb` 的渲染位置從「頁面自己 render」改成「透過 context 讓 Navbar render」，但頁面測試本身不斷言 `Navbar`/麵包屑的 DOM 位置，只斷言資料夾/文件列表內容，不受影響
- 視覺改動（顏色、間距、圖示）不寫快照測試，人工在瀏覽器確認即可（延續專案慣例：前端變更需要實際跑起來看過）

## 範疇之外（維持第一階段規劃，留待之後）

- 權限管理 UI、搜尋、rename/move/delete、站內 PDF 預覽
- 響應式/行動裝置版面
- 深色模式
