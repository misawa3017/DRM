# OpenAPI／Swagger 文件

API 在非 production 環境會提供互動式 Swagger UI：

- UI：`/api-docs`
- OpenAPI 3.0 JSON：`/api-docs/openapi.json`

例如本機 API 在 `http://localhost:3000` 運行時，開啟
`http://localhost:3000/api-docs`。在 Swagger UI 右上角按 **Authorize**，貼上
Keycloak access token 後，可測試所有需要登入的端點。

正式環境刻意不提供這兩個路由（回應 `404`），以避免公開服務暴露完整 API
結構與資料模型。若要查閱正式版本相同 commit 的文件，請在隔離的開發／測試
環境以 `NODE_ENV=development` 啟動 API。

規格依控制器分為健康檢查、文件、資料夾、權限、稽核、搜尋、使用者、回收桶、
限時分享與 OnlyOffice 整合。請求 DTO 的必填欄位、格式、範例與驗證限制由
NestJS Swagger CLI plugin 在編譯時產生。
