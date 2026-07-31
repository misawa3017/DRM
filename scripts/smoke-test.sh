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

echo "Smoke test passed."
