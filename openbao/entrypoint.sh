#!/bin/sh
# Runs as root (see docker-compose.yml's `user: "0:0"` on openbao-init) for
# exactly one reason: the openbao_init/openbao_approle Docker volumes are
# created root-owned on first use, and the image's non-root "openbao" user
# (uid 100, gid 1000 -- see /etc/passwd in openbao/openbao:latest) can't
# write to them otherwise.
#
# Rather than running the whole init script as root, we chown the mount
# points (and anything already in them, from earlier root-owned runs) here
# -- the one operation that actually needs root -- and then drop privileges
# via su-exec (already shipped in the base image and used the same way by
# its own docker-entrypoint.sh) before handing off to init.sh, which talks
# only to the OpenBao HTTP API and writes only under /init and /approle.
#
# /init and /approle are two SEPARATE volumes (not one shared mount): /init
# holds openbao-init.json (unseal key + root token -- full KMS control) and
# is never mounted into any other container; /approle holds only the scoped
# AppRole role_id/secret_id and is also mounted read-only into kes. This
# split is what actually keeps a compromised KES container from reading
# OpenBao's root token -- see docker-compose.yml.
set -eu

chown -R 100:1000 /init /approle

exec su-exec openbao /bin/sh /init.sh
