# SonarQube Cloud 與 CI 品質閘門

本專案使用 **SonarQube Cloud** 與 GitHub Actions 做靜態程式碼分析及 Quality Gate。程式碼只會由 GitHub hosted runner 透過 HTTPS 送往 SonarQube Cloud 分析；不使用、不維護地端 SonarQube、資料庫或 self-hosted runner。

`main` 的 Pull Request 合併前，必須通過 GitHub Actions 的測試與 SonarQube Cloud Quality Gate。

## 你需要完成的首次設定

1. 到 [SonarQube Cloud](https://sonarcloud.io) 使用 GitHub 帳號登入，並授權 SonarQube Cloud App 存取 GitHub 組織／帳號 `misawa3017`。
2. 建立或匯入 GitHub repository `misawa3017/DRM`。分析方式選擇 **GitHub Actions**，並確認專案 Key 是 `misawa3017_DRM`。
3. 確認 SonarQube Cloud 組織 Key 為 `misawa3017`。此值已寫在 `sonar-project.properties` 的 `sonar.organization`；若 Cloud 顯示不同的組織 Key，請以 Cloud 顯示的值取代它。
4. 在 SonarQube Cloud 建立分析 Token：Team／Enterprise 方案優先建立 Scoped Organization Token；其他方案建立具「Execute Analysis」權限的 Personal Access Token。Token 只會顯示一次，請立即安全保存。
5. 到 GitHub repository 的 **Settings → Secrets and variables → Actions**，新增 repository secret：
   - 名稱：`SONAR_TOKEN`
   - 值：步驟 4 建立的 Token
6. Push 本次設定後，在 GitHub 的 **Actions → 品質閘門** 執行 workflow，確認 API 測試、前端測試與 SonarQube Cloud 掃描均成功。
7. 在 GitHub 的 `main` branch protection／ruleset 中，將 `品質閘門 / test-and-sonar` 設為 required status check。若 SonarQube Cloud 另外回報 Pull Request 品質檢查，也一併設為 required。

SonarQube Cloud 的專案設定頁也會依你的帳號與方案提供精確的設定教學；以該頁給出的組織 Key 和 Token 為準。

## Repository 內已完成的設定

- `.github/workflows/quality-gate.yml` 使用 `ubuntu-latest`，不再啟動 Docker 或要求 self-hosted runner。
- `sonar-project.properties` 指向 `https://sonarcloud.io`，並設定專案 Key、組織 Key、掃描來源及五分鐘的 Quality Gate 等候時間。
- `docker-compose.yml` 不再包含 SonarQube、其 PostgreSQL 或 scanner 容器；`package.json` 也不再提供地端 SonarQube 指令。

## 如何判讀 DRM 專案品質

SonarQube Cloud 是**靜態程式碼品質與安全性**指標，不等同於系統功能、效能或實際資安滲透測試全部合格。判讀時先以最新一次 `main` 分支分析結果為基準；審查功能時則以該 Pull Request 的結果為準。

### 第一次查看的順序

1. 開啟 SonarQube Cloud 的 DRM 專案，選取 `main` 分支。
2. 在 **Overview** 頁面先看最上方的 **Quality Gate**：`Passed` 表示符合目前門檻，`Failed` 表示至少一項條件未達標，不能據此判定可發布或可合併。
3. 切換 **New Code** 與 **Overall Code**：
   - **New Code** 是近期新增或修改的程式碼；Pull Request 中則等同該 PR 的變更。它是日常合併決策的優先依據。
   - **Overall Code** 是整個專案累積的狀態，用來規劃技術債；既有問題不應成為新功能無限期無法合併的理由。
4. 若 Quality Gate 為 `Failed`，點選失敗的指標或進入 **Issues**，使用 `New Code`、嚴重度與類型篩選，逐一處理造成失敗的項目。

### 各項指標代表什麼

| 指標 | 代表意義 | DRM 專案的處理優先度 |
| --- | --- | --- |
| Reliability（可靠性） | 可能造成錯誤行為、例外或不正確結果的 Bug | 高；尤其是檔案、權限、背景任務流程 |
| Security（安全性） | 已識別的程式安全弱點，例如不安全的資料處理 | 最高；先確認是否會影響認證、授權、金鑰或檔案存取 |
| Security Hotspots | 需要人為判斷是否安全敏感的程式位置，不一定已是漏洞 | 高；必須逐筆檢視並標示安全或修正 |
| Maintainability（可維護性）／Code Smells | 可讀性、複雜度、重複邏輯與日後維護成本 | 中；新程式碼應修正，舊程式碼納入技術債排程 |
| Coverage（測試覆蓋率） | 有多少程式行為被測試執行到 | 中高；須搭配測試報告才有意義，不能單憑百分比判斷安全 |
| Duplications（重複率） | 重複的程式片段比例 | 中；新增重複邏輯應抽取共用實作 |

嚴重度出現 `Blocker` 或 `Critical` 時，先處理；若屬 Security 或權限、加密、檔案下載路徑，未確認風險前不要合併。

### 如何處理一筆 Issue

1. 在 **Issues** 開啟項目，先閱讀規則說明、受影響檔案與程式碼位置。
2. 確認是否真的適用於 DRM 的使用情境；修正後提交程式碼，讓 GitHub Actions 重新掃描。
3. 若確認是誤判或已有等效防護，留下理由後依專案權限將其標記為 `False Positive` 或 `Won't Fix`；不可只為讓 Gate 變綠而忽略安全問題。
4. 回到 Pull Request 或 `main` 的 **Overview**，確認最新分析已將該問題關閉，且 Quality Gate 變為 `Passed`。

### Security Hotspots 的檢視方式

在 **Security Hotspots** 頁面依優先度逐項開啟，先閱讀 **What's the risk?**，再在 **Are you at risk?** 依提示核對實際資料流與保護措施。對本專案特別確認：JWT 驗證與授權、租戶隔離、檔案存取權限、加密金鑰、上傳檔名／路徑，以及輸入驗證。確認安全後才能標示為已檢視；若無法證明安全，應修正程式碼。

### Pull Request 審查標準

建立 PR 後，先在 GitHub PR 的 **Checks** 看 `品質閘門 / test-and-sonar`，再點開 SonarQube Cloud 的 PR 分析結果：

1. Quality Gate 必須是 `Passed`。
2. 新增的 Reliability 或 Security 問題必須為零，或已有明確且經審查的處置理由。
3. 新增的 Security Hotspot 必須已完成檢視。
4. 新增的 Code Smell 與重複程式碼應在合併前修正；確有必要延後時，建立可追蹤的技術債工作項目。

若 `main` 顯示的 Overall Code 仍有許多舊問題，請以 **Issues → Overall Code** 匯出或分批建立技術債，不要在一個功能 PR 中混入大範圍重構。

### 覆蓋率的目前限制

目前 workflow 會執行 Jest 與 Vitest 測試，但尚未產生並匯入 LCOV coverage report。因此 SonarQube Cloud 的 Coverage 可能顯示空白、0% 或不完整，不能解讀為「沒有測試」。待日後將測試指令改為輸出 coverage 並在 `sonar-project.properties` 設定報告路徑後，才可將 Coverage 納入 Quality Gate 的正式門檻。

## 日常流程

完成大型功能後，先在本機執行測試：

```bash
pnpm --filter api lint
pnpm --filter api test -- --runInBand
pnpm --filter web lint
pnpm --filter web test
```

提交分支並建立 Pull Request 後，GitHub Actions 會自動分析。請在 Pull Request 的 Checks 與 SonarQube Cloud 儀表板修正問題，Quality Gate 為綠燈後才合併。

## 疑難排解

- `Project not found` 或 `Not authorized`：確認 `sonar.projectKey`、`sonar.organization` 與 SonarQube Cloud 專案資訊一致，且 GitHub 的 `SONAR_TOKEN` 尚有效並有 Execute Analysis 權限。
- GitHub Actions 找不到 `SONAR_TOKEN`：確認 secret 建在 `misawa3017/DRM` repository，名稱須完全相同；來自 fork 的 Pull Request 不會取得 repository secret，屬 GitHub 的安全限制。
- Quality Gate 未出現在 branch protection 可選清單：先讓 workflow 成功執行一次，再回到 branch protection／ruleset 選取實際顯示的 check 名稱。
- 若先前已在 Docker 主機啟動地端 SonarQube，請在確認 Cloud 分析成功後，依團隊的容器與資料保留政策停用舊容器；不要在未確認資料已無需保留前刪除 Docker volumes。

官方參考：[GitHub Actions 整合說明](https://docs.sonarsource.com/sonarqube-cloud/advanced-setup/ci-based-analysis/github-actions-for-sonarcloud)、[GitHub 組織匯入說明](https://docs.sonarsource.com/sonarqube-cloud/getting-started/github)。
