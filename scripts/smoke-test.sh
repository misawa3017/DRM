#!/usr/bin/env bash
set -euo pipefail

check() {
  local url=$1
  local code
  code=$(curl -s -o /dev/null -w '%{http_code}' "$url")
  if [ "$code" != "200" ]; then
    echo "FAIL: $url returned $code"
    exit 1
  fi
  echo "OK: $url"
}

check "http://api.drm.localhost/health"
check "http://auth.drm.localhost/realms/drm/.well-known/openid-configuration"
check "http://app.drm.localhost/"

# MinIO console, routed through Traefik. Verified live: this returns a bare
# 200 with the console's HTML shell even pre-login (no redirect), so the
# existing check() function's plain 200 check applies unmodified.
check "http://storage.drm.localhost/"

# MinIO's own health-live endpoint, hit directly on the loopback-only port
# (127.0.0.1:9000, added to docker-compose.yml's minio service) so this
# check doesn't depend on Traefik routing at all. Verified live: returns a
# bare 200 with an empty body.
check "http://127.0.0.1:9000/minio/health/live"

echo "Smoke test passed."
