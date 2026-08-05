#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
source .env

: "${DRM_BASE_DOMAIN:?set DRM_BASE_DOMAIN in .env}"

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

# Phase 4A's new services (redis, gotenberg, clamav, worker) don't publish
# an HTTP port to the host, so check()'s plain HTTP GET doesn't apply to
# them. This checks container health/state via `docker compose ps`
# instead. Field/value names verified live against this host's Docker
# Compose (v5.3.1): `docker compose ps --format '{{.Service}} {{.State}}
# {{.Health}}'` reports State as "running" for all containers and Health
# as "healthy"/"" depending on whether the service has a healthcheck
# defined. redis, gotenberg, and clamav all have real healthchecks (see
# docker-compose.yml), so they're checked against Health="healthy".
# worker has no healthcheck defined (per the plan, it's a pure background
# consumer, not an HTTP service) -- Health is empty for it, so it's
# checked against State="running" instead.
check_container_state() {
  local service=$1
  local field=$2
  local expected=$3
  local actual
  actual=$(docker compose ps --format "{{.$field}}" "$service")
  if [ "$actual" != "$expected" ]; then
    echo "FAIL: $service $field is '$actual', expected '$expected'" >&2
    exit 1
  fi
  echo "OK: $service $field is $expected"
}

check "http://api.${DRM_BASE_DOMAIN}/health"
check "http://auth.${DRM_BASE_DOMAIN}/realms/drm/.well-known/openid-configuration"
check "http://app.${DRM_BASE_DOMAIN}/"

# MinIO console, routed through Traefik. Verified live: this returns a bare
# 200 with the console's HTML shell even pre-login (no redirect), so the
# existing check() function's plain 200 check applies unmodified.
check "http://storage.${DRM_BASE_DOMAIN}/"

# MinIO's own health-live endpoint, hit directly on the loopback-only port
# (127.0.0.1:9000, added to docker-compose.yml's minio service) so this
# check doesn't depend on Traefik routing at all. Verified live: returns a
# bare 200 with an empty body.
check "http://127.0.0.1:9000/minio/health/live"

# Phase 4A: redis, gotenberg, clamav all have real healthchecks defined in
# docker-compose.yml, so check Health rather than just State.
check_container_state "redis" "Health" "healthy"
check_container_state "gotenberg" "Health" "healthy"
check_container_state "clamav" "Health" "healthy"
# worker has no healthcheck (pure background BullMQ consumer), so State is
# the right bar for it specifically.
check_container_state "worker" "State" "running"

echo "Smoke test passed."
