#!/usr/bin/env bash
# verify-authentik.sh — sanity check that Authentik OIDC endpoints are reachable.
#
# Usage:
#   ./infra/scripts/verify-authentik.sh
#   AUTHENTIK_ISSUER=https://auth.example.com/application/o/narrative/ ./infra/scripts/verify-authentik.sh
#
# Designed to run after `docker compose up` as a post-deploy health check.
set -euo pipefail

ISSUER="${AUTHENTIK_ISSUER:-http://localhost:9000/application/o/narrative/}"
JWKS_URL="${AUTHENTIK_JWKS_URL:-http://localhost:9000/application/o/narrative/jwks/}"

# Strip trailing slash for .well-known URL construction
ISSUER_BASE="${ISSUER%/}"

echo "Checking Authentik OIDC discovery at: ${ISSUER_BASE}/.well-known/openid-configuration"
DISCOVERY=$(curl -fsS --max-time 10 "${ISSUER_BASE}/.well-known/openid-configuration")
echo "${DISCOVERY}" | head -5
echo "OIDC discovery reachable"
echo ""

echo "Checking JWKS endpoint at: ${JWKS_URL}"
JWKS=$(curl -fsS --max-time 10 "${JWKS_URL}")
echo "${JWKS}" | head -5
echo "JWKS reachable"
echo ""

# Validate that issuer in discovery matches configured AUTHENTIK_ISSUER
DISCOVERED_ISSUER=$(echo "${DISCOVERY}" | grep -o '"issuer":"[^"]*"' | cut -d'"' -f4 || true)
if [ -n "${DISCOVERED_ISSUER}" ]; then
  if [ "${DISCOVERED_ISSUER}" = "${ISSUER_BASE}" ]; then
    echo "Issuer match: ${DISCOVERED_ISSUER}"
  else
    echo "WARNING: issuer mismatch — configured: ${ISSUER_BASE} / discovered: ${DISCOVERED_ISSUER}"
    echo "Update AUTHENTIK_ISSUER in .env to match the discovered issuer."
  fi
fi

echo ""
echo "Authentik OIDC check passed."
