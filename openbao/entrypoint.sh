#!/bin/sh
# Runs as root (see docker-compose.yml's `user: "0:0"` on openbao-init) for
# exactly one reason: the openbao_shared Docker volume is created root-owned
# on first use, and the image's non-root "openbao" user (uid 100, gid 1000 --
# see /etc/passwd in openbao/openbao:latest) can't write to it otherwise.
#
# Rather than running the whole init script as root, we chown the mount
# point (and anything already in it, from earlier root-owned runs) here --
# the one operation that actually needs root -- and then drop privileges
# via su-exec (already shipped in the base image and used the same way by
# its own docker-entrypoint.sh) before handing off to init.sh, which talks
# only to the OpenBao HTTP API and writes only under /shared.
set -eu

chown -R 100:1000 /shared

exec su-exec openbao /bin/sh /init.sh
