#!/usr/bin/env bash
# Checks this machine against Narrative's toolchain (AGENTS.md → Conventions)
# and prints the fix for anything missing. Exit 1 when something required
# is wrong; warnings (!) are for optional lanes and one-time setup steps.
# `check && ok … || bad …` is if/else here: ok and warn only print.
# shellcheck disable=SC2015
set -uo pipefail

fail=0
ok() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad() { printf '  \033[31m✗\033[0m %s\n      → %s\n' "$1" "$2"; fail=1; }
warn() { printf '  \033[33m!\033[0m %s\n      → %s\n' "$1" "$2"; }
has() { command -v "$1" >/dev/null 2>&1; }
install_hint() { [[ "$(uname)" == Darwin ]] && echo "brew install $1" || echo "see SETUP.md → Toolchain ($1)"; }

root="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
cd "$root" || exit 1

echo "Toolchain"
if has node; then
  v="$(node -v | tr -d v)"
  IFS=. read -r major minor _ <<<"$v"
  # engines.node: >= 24.4 — Node 24 LTS, the line the images run; 24.4 added
  # fs.promises.mkdtempDisposable (the server's URL downloads). Node 24 strips
  # types by default, which the ESLint config needs for the parity table.
  if ((major > 24 || (major == 24 && minor >= 4))); then ok "Node $v"; else
    bad "Node $v (want ≥ 24.4)" "install the current Node LTS (fnm / brew install node@24)"; fi
  ts="$(node -p 'process.features.typescript ?? false' 2>/dev/null)"
  [[ "$ts" != false ]] && ok "Node type stripping ($ts)" ||
    warn "this Node build has no TypeScript support (Ubuntu's distro package)" \
      "nothing to do for just recipes (they load tsx); raw \`pnpm lint\` needs NODE_OPTIONS=--import=tsx"
else
  bad "Node missing" "install Node ≥ 24.4"
fi
want_pnpm="$(node -p 'require("./package.json").packageManager.split("@")[1]' 2>/dev/null)"
if has pnpm; then
  v="$(pnpm -v)"
  [[ "$v" == "$want_pnpm" ]] && ok "pnpm $v" ||
    bad "pnpm $v (packageManager pins $want_pnpm)" "corepack enable && corepack prepare pnpm@$want_pnpm --activate"
else
  bad "pnpm missing" "corepack enable && corepack prepare pnpm@$want_pnpm --activate"
fi
has docker && docker compose version >/dev/null 2>&1 && ok "Docker + compose (dev services)" ||
  bad "Docker with the compose plugin missing" "install Docker (SETUP.md → Boot the storage / image stack)"
# The PPTX round-trip tests validate against the ECMA-376 schema with it.
has xmllint && ok "xmllint (PPTX schema tests)" || bad "xmllint missing" "$(install_hint libxml2)"

echo "Dev tools"
for t in just lefthook gitleaks; do
  has "$t" && ok "$t" || bad "$t missing" "$(install_hint "$t")"
done
# The Claude Code hooks and the docs check (tools/dev/docs-check.py) run on it.
if has python3 && python3 -c 'import sys; sys.exit(sys.version_info < (3, 9))' 2>/dev/null; then
  ok "python3 $(python3 -c 'import platform; print(platform.python_version())')"
else
  bad "python3 ≥ 3.9 missing (Claude Code hooks, docs check)" "$(install_hint python3)"
fi
# Secrets: SOPS + age, key from 1Password (scripts/secrets-decrypt.sh).
for t in sops age op; do
  has "$t" && ok "$t" || warn "$t missing (only for decrypting secrets)" "$(install_hint "$t")"
done
# e2e: Playwright's own Chromium where it installs, the system Chrome
# elsewhere (Ubuntu 26.04) — the same decision `just e2e` makes.
if env_out="$(tools/dev/playwright-env.sh)" && [[ -z "$env_out" ]]; then
  ok "Playwright Chromium"
elif [[ "$env_out" == *PLAYWRIGHT_USE_SYSTEM_CHROME* || -n "${PLAYWRIGHT_CHROME_EXECUTABLE:-}${PLAYWRIGHT_USE_SYSTEM_CHROME:-}" ]]; then
  ok "system Chrome for e2e (Playwright has no Chromium here; just e2e switches)"
else
  warn "no browser for e2e" "pnpm --filter web exec playwright install chromium  (Ubuntu 26.04: install Google Chrome)"
fi

echo "Project"
[[ -d node_modules ]] && ok "dependencies installed" || bad "node_modules missing" "just setup"
[[ -f .env ]] && ok ".env present" || warn ".env missing" "scripts/secrets-decrypt.sh dev   (needs the private overlay)"
[[ -d private/.git ]] && ok "private overlay cloned" ||
  warn "private overlay missing" "git clone https://github.com/petronijus/Narrative-private.git private"
hooks_path="$(git config --get core.hooksPath || true)"
if [[ -n "$hooks_path" ]]; then
  bad "core.hooksPath=$hooks_path (left by husky; lefthook's hooks never run)" "just setup"
elif [[ -x .git/hooks/pre-commit ]] && grep -q lefthook .git/hooks/pre-commit; then
  ok "git hooks installed (lefthook)"
else
  warn "git hooks not installed" "just setup"
fi

exit $fail
