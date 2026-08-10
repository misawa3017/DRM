# SonarQube 與 CI 品質閘門

本專案以自架 SonarQube 作為靜態程式碼分析與 Quality Gate。所有大型功能完成後，在提交 Pull Request 前必須通過測試、SonarQube 掃描與 Quality Gate；`main` 分支必須以 GitHub branch protection 強制要求 `品質閘門` workflow 成功。

## 架構

- `sonar-postgres`：SonarQube 專用 PostgreSQL，與 DRM 業務資料庫分離。
- `sonarqube`：分析結果與 Quality Gate 儀表板，只綁定 Docker 主機的 `127.0.0.1:9002`。
- `sonar-scanner`：一次性掃描容器，以 `pnpm sonar:scan` 執行。
- `sonar-project.properties`：定義專案識別、掃描範圍與等待 Quality Gate 的規則。

品質服務使用 `quality` profile，平常執行 `docker compose up -d` 不會啟動它們。

## 一次性主機設定

SonarQube 內建 Elasticsearch 需要較高的 Linux 虛擬記憶體映射數。以具 sudo 權限的帳號在 Docker 主機執行：

```bash
sudo sysctl -w vm.max_map_count=524288
printf 'vm.max_map_count=524288\n' | sudo tee /etc/sysctl.d/99-sonarqube.conf
sudo sysctl --system
```

啟動服務：

```bash
pnpm sonar:up
```

首次啟動完成後，在 Docker 主機開啟 `http://127.0.0.1:9002`。預設帳密是 `admin` / `admin`，首次登入時必須立即更改密碼。不要將 9002 連接埠公開到網際網路；若 CI runner 不在同一台主機，須先透過 VPN 或受驗證的反向代理提供安全連線。

## 建立專案與 Token

1. 以管理員登入 SonarQube，建立本機專案，Project Key 使用 `misawa3017_DRM`。
2. 建立最小權限的專案分析 Token。
3. 在 GitHub repository 的 **Settings → Secrets and variables → Actions** 新增 repository secret：`SONAR_TOKEN`。
4. 在 Docker 主機註冊 GitHub self-hosted runner，並確保 runner 帳號能執行 `docker compose`。
5. GitHub 的 **Settings → Branches** 為 `main` 建立 branch protection，將 `品質閘門 / test-and-sonar` 設為必須通過的 status check。

GitHub hosted runner 無法連入此 Compose 內、僅監聽 loopback 的 SonarQube，因此 workflow 明確使用 `self-hosted` runner。若改用外部 SonarQube Server，才可改為 GitHub hosted runner，並將 `SONAR_HOST_URL` 改為該受 TLS 保護的網址。

## 日常開發流程

大型功能完成後，依序執行：

```bash
pnpm --filter api lint
pnpm --filter api test -- --runInBand
pnpm --filter web lint
pnpm --filter web test
export SONAR_TOKEN='只在目前終端機設定的分析 Token'
pnpm sonar:scan
```

掃描器會等待最多五分鐘取得 Quality Gate 結果；Quality Gate 失敗時指令會回傳非零狀態。修正問題後重新掃描，Quality Gate 綠燈才建立或合併 Pull Request。

## 疑難排解

- `max virtual memory areas vm.max_map_count ... is too low`：重新完成「一次性主機設定」。
- Scanner 顯示無法連線：確認 `pnpm sonar:up` 已啟動，並用 `docker compose --profile quality ps` 檢查服務。
- `Not authorized`：確認 `SONAR_TOKEN` 未過期、Token 對應專案正確，且 GitHub secret 名稱完全是 `SONAR_TOKEN`。
- 不要使用 `docker compose down -v` 清除品質服務，這會同時刪除 SonarQube 的資料庫與歷史分析結果。
