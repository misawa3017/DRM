# Phase 1 Manual Verification Checklist

1. Open http://app.drm.localhost in a browser.
2. Click "Log in" — expect a redirect to http://auth.drm.localhost.
3. Log in with `testuser` / `testpass`.
4. Expect a redirect back to http://app.drm.localhost showing:
   - Email: testuser@example.com
   - Name: Test User
   - Roles: employee
5. Click "Log out" — expect the "Log in" button to reappear.
6. Confirm a row exists in Postgres: `docker compose exec postgres psql -U drm -d drm -c "select email, keycloak_sub from users;"` should list `testuser@example.com`.
