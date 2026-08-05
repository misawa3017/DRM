#!/bin/sh
set -eu

# NOTE: quay.io/keycloak/keycloak:25.0's /bin/sh is actually bash 5.1
# (confirmed via `docker run --rm --entrypoint sh quay.io/keycloak/keycloak:25.0
# -c "sh --version"`), so this script relies on bash's ${var//search/replace}
# parameter expansion for template substitution, matching the pattern
# already used in kes/entrypoint.sh (see that file for the fuller rationale
# on minimal images not always having sed).
#
# This wrapper exists because realm-export.json is bind-mounted into the
# container and imported at startup by `--import-realm`, but its
# redirectUris/webOrigins need to point at whatever host this deployment
# actually runs on (DRM_APP_HOST) -- and Docker Compose's ${VAR}
# interpolation only applies to docker-compose.yml itself, not to files it
# mounts into containers. So the real redirect-URI template substitution
# happens here at container start, before handing off to the image's real
# entrypoint (kc.sh) with the original args (start-dev --import-realm)
# intact -- confirmed via `docker inspect quay.io/keycloak/keycloak:25.0`
# that /opt/keycloak/bin/kc.sh is the image's actual entrypoint binary.

: "${DRM_APP_HOST:?entrypoint.sh: DRM_APP_HOST env var is required (e.g. app.drm.localhost)}"

mkdir -p /opt/keycloak/data/import

TEMPLATE=$(cat /template/realm-export.json.template)
TEMPLATE="${TEMPLATE//__APP_HOST__/$DRM_APP_HOST}"
printf '%s\n' "$TEMPLATE" > /opt/keycloak/data/import/realm-export.json

exec /opt/keycloak/bin/kc.sh "$@"
