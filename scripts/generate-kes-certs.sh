#!/usr/bin/env bash
set -euo pipefail

OUT_DIR="secrets/kes"
mkdir -p "$OUT_DIR"

if [[ -f "$OUT_DIR/kes-server.cert" && -f "$OUT_DIR/minio-client.cert" ]]; then
  echo "Certs already exist in $OUT_DIR — skipping generation (delete the directory to regenerate)."
else
  # -addext "basicConstraints=critical,CA:FALSE" is required on both certs:
  # OpenSSL 3.x's `req -x509` defaults to the [v3_ca] policy for self-signed
  # certs (CA:TRUE) unless told otherwise. KES's client-cert identity
  # extraction (internal identifyRequest in auth.go) explicitly *skips* any
  # peer certificate with IsCA=true when looking for the client's leaf
  # cert -- so a CA:TRUE minio-client.cert makes KES treat every mTLS
  # request as if no client certificate were presented at all ("tls: client
  # certificate is required"), even though one was sent and the identity
  # hash matches the configured policy. The server cert isn't subject to
  # that code path, but is fixed too for correctness (a TLS server leaf
  # shouldn't self-identify as a CA either).
  echo "Generating self-signed KES server certificate..."
  openssl req -x509 -newkey rsa:4096 -sha256 -days 3650 -nodes \
    -keyout "$OUT_DIR/kes-server.key" -out "$OUT_DIR/kes-server.cert" \
    -subj "/CN=kes" \
    -addext "subjectAltName=DNS:kes,DNS:localhost" \
    -addext "basicConstraints=critical,CA:FALSE"

  echo "Generating self-signed MinIO client certificate..."
  openssl req -x509 -newkey rsa:4096 -sha256 -days 3650 -nodes \
    -keyout "$OUT_DIR/minio-client.key" -out "$OUT_DIR/minio-client.cert" \
    -subj "/CN=minio-client" \
    -addext "basicConstraints=critical,CA:FALSE"
fi

echo "Computing KES identity hash of the MinIO client certificate..."
docker run --rm -v "$(pwd)/$OUT_DIR":/certs minio/kes:latest identity of /certs/minio-client.cert \
  | tee "$OUT_DIR/minio-client-identity.txt"

echo "Done. Identity hash saved to $OUT_DIR/minio-client-identity.txt"
