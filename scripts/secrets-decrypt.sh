#!/usr/bin/env bash
# Decrypt SOPS-encrypted secrets into the gitignored target env file.
#
#   ./scripts/secrets-decrypt.sh [dev|prod]      (default: dev)
#     dev  → private/config/env.sops       → ./.env             (local dev)
#     prod → private/config/env.prod.sops  → ./infra/.env.prod  (prod, see below)
#
# Age private key is fetched from 1Password at runtime (never hits disk).
# Requires the private overlay cloned into ./private.
#
# PROD: this writes ./infra/.env.prod LOCALLY. It still has to reach the VM —
# copy it over after decrypting, then redeploy:
#   ./scripts/secrets-decrypt.sh prod
#   scp infra/.env.prod narrative:/opt/narrative/infra/.env.prod
#   ssh narrative 'cd /opt/narrative && ./infra/scripts/deploy.sh prod'
set -euo pipefail
cd "$(dirname "$0")/.."

TARGET="${1:-dev}"
case "$TARGET" in
  dev)  ENC="private/config/env.sops";      OUT=".env" ;;
  prod) ENC="private/config/env.prod.sops"; OUT="infra/.env.prod" ;;
  *)    echo "usage: $0 [dev|prod]"; exit 1 ;;
esac

KEY_ITEM="SOPS age key (dev repos)"
command -v sops >/dev/null || { echo "sops not found — 'brew install sops age'"; exit 1; }
command -v op   >/dev/null || { echo "op (1Password CLI) not found"; exit 1; }
[ -f "$ENC" ] || { echo "Missing $ENC — clone the private overlay into ./private first."; exit 1; }

key="$(op document get "$KEY_ITEM" 2>/dev/null)" || { echo "Could not read '$KEY_ITEM' from 1Password."; exit 1; }
SOPS_AGE_KEY="$(printf '%s' "$key" | grep '^AGE-SECRET-KEY')" \
  sops --input-type binary --output-type binary -d "$ENC" > "$OUT"
echo "Wrote $OUT (gitignored)."
