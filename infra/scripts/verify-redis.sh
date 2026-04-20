#!/usr/bin/env bash
# verify-redis.sh — health probe for the media queue Redis (M12)
#
# Usage:
#   ./infra/scripts/verify-redis.sh
#   MEDIA_REDIS_URL=redis://127.0.0.1:6380 ./infra/scripts/verify-redis.sh
#
# Requires Docker (uses redis:7-alpine to run redis-cli without a local install).
# In production, run from the host with SSH access to the server.
set -euo pipefail

ENDPOINT="${MEDIA_REDIS_URL:-redis://127.0.0.1:6380}"

echo "[verify-redis] probing ${ENDPOINT} ..."

RESPONSE=$(docker run --rm --network=host redis:7-alpine redis-cli -u "${ENDPOINT}" ping 2>&1)

if [ "${RESPONSE}" = "PONG" ]; then
  echo "[verify-redis] OK — got PONG from ${ENDPOINT}"
else
  echo "[verify-redis] FAIL — unexpected response: ${RESPONSE}" >&2
  exit 1
fi
