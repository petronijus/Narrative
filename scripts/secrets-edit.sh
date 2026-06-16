#!/usr/bin/env bash
# Edit SOPS-encrypted secrets in $EDITOR (decrypt -> edit -> re-encrypt in place).
#
#   ./scripts/secrets-edit.sh [dev|prod]      (default: dev)
#     dev  → private/config/env.sops
#     prod → private/config/env.prod.sops
#
# Commit the updated private/config/*.sops in the private overlay afterwards.
# For prod, then re-materialize + push to the VM (see secrets-decrypt.sh prod).
set -euo pipefail
cd "$(dirname "$0")/.."

TARGET="${1:-dev}"
case "$TARGET" in
  dev)  ENC="private/config/env.sops" ;;
  prod) ENC="private/config/env.prod.sops" ;;
  *)    echo "usage: $0 [dev|prod]"; exit 1 ;;
esac

KEY_ITEM="SOPS age key (dev repos)"
command -v sops >/dev/null || { echo "sops not found — 'brew install sops age'"; exit 1; }
command -v op   >/dev/null || { echo "op (1Password CLI) not found"; exit 1; }
[ -f "$ENC" ] || { echo "Missing $ENC — clone the private overlay into ./private first."; exit 1; }

key="$(op document get "$KEY_ITEM" 2>/dev/null)" || { echo "Could not read '$KEY_ITEM' from 1Password."; exit 1; }
SOPS_AGE_KEY="$(printf '%s' "$key" | grep '^AGE-SECRET-KEY')" \
  sops --input-type binary --output-type binary "$ENC"
echo "Re-encrypted $ENC — commit it in the private overlay."
