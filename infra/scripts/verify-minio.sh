#!/usr/bin/env bash
# verify-minio.sh — sanity check that MinIO is reachable and the media bucket exists.
#
# Usage:
#   ./infra/scripts/verify-minio.sh
#   MINIO_ENDPOINT=http://127.0.0.1:9100 MINIO_ROOT_USER=... MINIO_ROOT_PASSWORD=... \
#     ./infra/scripts/verify-minio.sh
#
# Designed to run after `docker compose up` as a post-deploy health check.
# Requires: curl, docker, and `docker login ghcr.io` (the MinIO image is a
# private GHCR mirror — docs/storage.md → MinIO image).
set -euo pipefail

# The MinIO image ships mc; take its reference from the compose file so the
# two never drift apart.
COMPOSE_FILE="$(cd "$(dirname "$0")/.." && pwd)/docker-compose.yml"
MINIO_IMAGE="$(sed -n 's/^x-minio-image: *&minio-image *//p' "$COMPOSE_FILE")"
[[ -n "$MINIO_IMAGE" ]] || { echo "verify-minio.sh: no x-minio-image in ${COMPOSE_FILE}" >&2; exit 1; }

ENDPOINT="${MINIO_ENDPOINT:-http://127.0.0.1:9100}"
BUCKET="${MEDIA_BUCKET:-narrative-media}"
USER="${MINIO_ROOT_USER:?MINIO_ROOT_USER env var is required}"
PASS="${MINIO_ROOT_PASSWORD:?MINIO_ROOT_PASSWORD env var is required}"

# Strip protocol prefix for mc alias construction
ENDPOINT_HOST="${ENDPOINT#http://}"
ENDPOINT_HOST="${ENDPOINT_HOST#https://}"

echo "Checking MinIO reachability at ${ENDPOINT}..."
curl -fsS --max-time 10 "${ENDPOINT}/minio/health/ready"
echo "MinIO ready"
echo ""

echo "Verifying bucket '${BUCKET}' exists..."
# Run mc in a throwaway container — no local mc install required.
# Uses host network so ENDPOINT on localhost is reachable.
docker run --rm --network=host \
  -e "MC_HOST_local=http://${USER}:${PASS}@${ENDPOINT_HOST}" \
  --entrypoint mc \
  "${MINIO_IMAGE}" \
  ls "local/${BUCKET}" > /dev/null
echo "Bucket '${BUCKET}' exists"
echo ""

echo "MinIO check passed."
