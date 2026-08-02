#!/usr/bin/env bash
set -euo pipefail

WORKDIR=$(mktemp -d)
trap 'rm -rf "$WORKDIR"' EXIT

# mktemp -d creates the directory 0700 (owner-only). The verification
# request below shells out to the curlimages/curl image, which runs as a
# non-root container user -- it needs to both read test.txt (input) and
# write output.pdf (output) into this bind-mounted directory, so it needs
# read+write+execute for "other", not just read+execute.
chmod 777 "$WORKDIR"

echo "Phase 4A Gotenberg verification $(date -u +%FT%TZ)" > "$WORKDIR/test.txt"
chmod 644 "$WORKDIR/test.txt"

echo "Converting test.txt to PDF via Gotenberg..."
docker run --rm --network drm_default -v "$WORKDIR:$WORKDIR" curlimages/curl:latest \
  -sf -X POST http://gotenberg:3000/forms/libreoffice/convert \
  -F "files=@$WORKDIR/test.txt" \
  -o "$WORKDIR/output.pdf"

echo "Confirming the output is a real PDF..."
if [ "$(head -c 4 "$WORKDIR/output.pdf")" != "%PDF" ]; then
  echo "FAIL: output does not start with the PDF magic bytes" >&2
  exit 1
fi

echo "Gotenberg verification passed. Output size: $(wc -c < "$WORKDIR/output.pdf") bytes."
