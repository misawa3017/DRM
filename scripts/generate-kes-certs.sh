#!/usr/bin/env bash
set -euo pipefail

OUT_DIR="secrets/kes"
mkdir -p "$OUT_DIR"

if [ -f "$OUT_DIR/kes-server.cert" ] && [ -f "$OUT_DIR/minio-client.cert" ]; then
  echo "Certs already exist in $OUT_DIR — skipping generation (delete the directory to regenerate)."
else
  echo "Generating self-signed KES server certificate..."
  openssl req -x509 -newkey rsa:4096 -sha256 -days 3650 -nodes \
    -keyout "$OUT_DIR/kes-server.key" -out "$OUT_DIR/kes-server.cert" \
    -subj "/CN=kes" \
    -addext "subjectAltName=DNS:kes,DNS:localhost"

  echo "Generating self-signed MinIO client certificate..."
  openssl req -x509 -newkey rsa:4096 -sha256 -days 3650 -nodes \
    -keyout "$OUT_DIR/minio-client.key" -out "$OUT_DIR/minio-client.cert" \
    -subj "/CN=minio-client"
fi

echo "Computing KES identity hash of the MinIO client certificate..."
docker run --rm -v "$(pwd)/$OUT_DIR":/certs minio/kes:latest identity of /certs/minio-client.cert \
  | tee "$OUT_DIR/minio-client-identity.txt"

echo "Done. Identity hash saved to $OUT_DIR/minio-client-identity.txt"
