# Phase 1 手動驗證檢查清單

1. 在瀏覽器中開啟 http://app.drm.localhost。
2. 點擊「Log in」— 預期會重新導向至 http://auth.drm.localhost。
3. 使用 `testuser` / `testpass` 登入。
4. 預期會重新導向回 http://app.drm.localhost，並顯示：
   - Email: testuser@example.com
   - Name: Test User
   - Roles: employee
5. 點擊「Log out」— 預期「Log in」按鈕會重新出現。
6. 確認 Postgres 中存在對應的資料列：`docker compose exec postgres psql -U drm -d drm -c "select email, \"keycloakSub\" from users;"` 應會列出 `testuser@example.com`。
