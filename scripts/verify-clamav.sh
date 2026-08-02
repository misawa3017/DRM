#!/usr/bin/env bash
set -euo pipefail

# Phase 4A ClamAV verification.
#
# Client choice: the `clamscan` npm package (https://www.npmjs.com/package/clamscan).
# Researched against the plan's two named candidates plus a hand-rolled fallback:
#   - clamdjs (npm): zero deps, but last published 2019, ~95k downloads/month.
#   - clamscan (npm): zero deps, actively maintained (published Oct 2024),
#     ~1.66M downloads/month, native support for scanning over a remote
#     clamd TCP host:port (clamdscan.host/port) with no local ClamAV binary
#     required -- exactly this deployment's shape. Chosen over clamdjs for
#     being the maintained, far more widely used option; a hand-rolled
#     INSTREAM client was not needed since a suitable library exists.
# Verified interactively before writing this script: `clamscan` correctly
# reports isInfected:false for a clean file and isInfected:true with
# viruses:["Eicar-Test-Signature"] for the EICAR string, against the real
# clamav service on the drm_default network.
#
# The npm install happens inside an ephemeral node:20-alpine container on
# every run (clamscan has zero dependencies, so this is fast) rather than
# vendoring node_modules into the repo.

WORKDIR=$(mktemp -d)
trap 'rm -rf "$WORKDIR"' EXIT

# node:20-alpine's default user is root, but be explicit/robust about the
# bind-mounted scratch dir being writable/readable regardless of who's on
# either side of the mount.
chmod 777 "$WORKDIR"

# The standard EICAR antivirus test string -- not a real virus, every AV
# engine (including ClamAV) is specifically designed to flag it. It's
# base64-encoded here rather than written as a literal: ClamAV (and many
# other security scanners) match this exact 68-byte pattern anywhere they
# find it, including inside source files, so a literal copy in this
# tracked script would itself get flagged on sight. Decoded only into this
# mktemp'd scratch directory at run time -- the raw string never touches a
# tracked file.
echo 'WDVPIVAlQEFQWzRcUFpYNTQoUF4pN0NDKTd9JEVJQ0FSLVNUQU5EQVJELUFOVElWSVJVUy1URVNULUZJTEUhJEgrSCo=' | base64 -d > "$WORKDIR/eicar.txt"
echo "This is a clean, benign test file for Phase 4A verification." > "$WORKDIR/clean.txt"

# Node scan helper: connects to clamd purely over TCP (host/port), no local
# ClamAV binary needed. Emits one JSON line describing the result.
cat > "$WORKDIR/scan.mjs" <<'EOF'
import NodeClam from 'clamscan';

const filePath = process.argv[2];
if (!filePath) {
  console.error('usage: node scan.mjs <file>');
  process.exit(2);
}

const clamscan = await new NodeClam().init({
  removeInfected: false,
  debugMode: false,
  clamscan: {
    active: false, // never try a local clamscan binary -- none exists in this container
  },
  clamdscan: {
    host: process.env.CLAMD_HOST || 'clamav',
    port: Number(process.env.CLAMD_PORT || 3310),
    timeout: 120000,
    localFallback: false, // must not silently fall back to a local binary
    active: true,
    bypassTest: false,
  },
  preference: 'clamdscan',
});

const { isInfected, viruses, file } = await clamscan.isInfected(filePath);
console.log(JSON.stringify({ file, isInfected, viruses }));
EOF

run_scan() {
  local target="$1"
  # Run as the host UID/GID (not the image's default root) so that
  # `npm install`'s output (node_modules/, package-lock fragments) ends up
  # owned by the invoking user, not root -- otherwise the `trap rm -rf`
  # cleanup above can't delete them, and a failed cleanup at EXIT
  # overwrites this script's real (successful) exit code with rm's
  # failure code. HOME=/tmp keeps npm's cache writes inside the
  # container's own throwaway filesystem, not the bind mount.
  docker run --rm --network drm_default -u "$(id -u):$(id -g)" -e HOME=/tmp \
    -v "$WORKDIR:$WORKDIR" -w "$WORKDIR" node:20-alpine \
    sh -c "npm install --no-save --silent clamscan >/dev/null 2>&1 && node scan.mjs $target"
}

echo "Scanning the EICAR test file (must be detected)..."
run_scan "$WORKDIR/eicar.txt" | tee "$WORKDIR/eicar-result.json"

if ! grep -q '"isInfected":true' "$WORKDIR/eicar-result.json"; then
  echo "FAIL: EICAR test file was not detected" >&2
  exit 1
fi
if ! grep -qi "eicar" "$WORKDIR/eicar-result.json"; then
  echo "FAIL: EICAR test file was flagged but not with an EICAR signature name" >&2
  exit 1
fi

echo "Scanning the clean file (must pass)..."
run_scan "$WORKDIR/clean.txt" | tee "$WORKDIR/clean-result.json"

if ! grep -q '"isInfected":false' "$WORKDIR/clean-result.json"; then
  echo "FAIL: clean file was incorrectly flagged" >&2
  exit 1
fi

echo "ClamAV verification passed: EICAR detected, clean file passed."
