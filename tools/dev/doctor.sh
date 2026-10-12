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
# The first version number in a command's output.
ver() { "$@" 2>/dev/null | grep -Eo '[0-9]+\.[0-9]+(\.[0-9]+)?' | head -1; }
# at_least <have> <want>: version comparison by sort -V.
at_least() { [[ -n "$1" && "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -1)" == "$2" ]]; }
# The pacman package that owns a tool, if pacman installed it.
pacman_pkg() { has pacman && has "$1" && pacman -Qqo "$(command -v "$1")" 2>/dev/null; }
# tool_ver <tool> <args…>: the tool's own answer, else its package's version
# (distro builds can lack the stamp: Arch's gitleaks prints "version is set
# by build process").
tool_ver() {
  local v pkg
  v="$(ver "$@")"
  if [[ -z "$v" ]] && pkg="$(pacman_pkg "$1")"; then
    v="$(pacman -Q "$pkg" | awk '{print $2}' | grep -Eo '^[0-9]+\.[0-9]+(\.[0-9]+)?')"
  fi
  printf '%s' "$v"
}
# How to install a package on this machine (Omarchy: pacman, MacBook: brew).
install() {
  if has pacman; then echo "sudo pacman -S $1"
  elif has brew; then echo "brew install $1"
  else echo "see SETUP.md → Toolchain ($1)"; fi
}

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
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
# MinIO comes from a private GHCR mirror (docs/storage.md → MinIO image):
# without a login, `just services` cannot pull it on a fresh machine.
minio_image="$(sed -n 's/^x-minio-image: *&minio-image *//p' infra/docker-compose.yml)"
if ! docker info >/dev/null 2>&1; then
  warn "Docker daemon not running (cannot check the MinIO image)" "start Docker, then just doctor"
elif docker image inspect "$minio_image" >/dev/null 2>&1; then
  ok "MinIO image (pulled)"
elif docker manifest inspect "$minio_image" >/dev/null 2>&1; then
  ok "MinIO image (pullable from GHCR)"
else
  bad "MinIO image not pulled and not pullable ($minio_image)" \
    "docker login ghcr.io -u petronijus   (a token with read:packages; docs/storage.md → MinIO image)"
fi
# The PPTX round-trip tests validate against the ECMA-376 schema with it.
has xmllint && ok "xmllint (PPTX schema tests)" || bad "xmllint missing" "$(install libxml2)"

echo "Dev tools"
for t in just lefthook; do
  has "$t" && ok "$t" || bad "$t missing" "$(install "$t")"
done
# The pre-commit hook runs `gitleaks git --pre-commit --staged` (8.19+).
v="$(tool_ver gitleaks version)"
at_least "$v" 8.19 && ok "gitleaks $v" ||
  bad "gitleaks ${v:-missing or unknown version} (want ≥ 8.19: the pre-commit hook's \`gitleaks git --staged\`)" "$(install gitleaks)"
# The Claude Code hooks and the docs check (tools/dev/docs-check.py) run on it.
if has python3 && python3 -c 'import sys; sys.exit(sys.version_info < (3, 9))' 2>/dev/null; then
  ok "python3 $(python3 -c 'import platform; print(platform.python_version())')"
else
  bad "python3 ≥ 3.9 missing (Claude Code hooks, docs check)" "$(install python)"
fi
# Secrets: SOPS + age, key from 1Password (scripts/secrets-decrypt.sh).
for t in sops age op; do
  # op is 1password-cli (brew cask; the AUR on Omarchy).
  has "$t" && ok "$t" || warn "$t missing (only for decrypting secrets)" "$(install "${t/#op/1password-cli}")"
done
# e2e: Playwright's own Chromium where it installs, the system Chrome
# elsewhere (Ubuntu 26.04) — the same decision `just e2e` makes.
if env_out="$(tools/dev/playwright-env.sh)" && [[ -z "$env_out" ]]; then
  ok "Playwright Chromium"
elif [[ "$env_out" == *PLAYWRIGHT_USE_SYSTEM_CHROME* || -n "${PLAYWRIGHT_CHROME_EXECUTABLE:-}${PLAYWRIGHT_USE_SYSTEM_CHROME:-}" ]]; then
  ok "system Chrome for e2e and the render worker (Playwright has no Chromium here; just e2e switches)"
elif [[ "$env_out" == *PLAYWRIGHT_CHROME_EXECUTABLE=* ]]; then
  bin="${env_out#*PLAYWRIGHT_CHROME_EXECUTABLE=}"
  ok "${bin%%$'\n'*} for e2e and the render worker (Playwright has no Chromium here)"
else
  warn "no browser for e2e or the render worker" \
    "pnpm --filter web exec playwright install chromium  (Ubuntu 26.04 / Arch: install Google Chrome or Chromium)"
fi

echo "Project"
[[ -d node_modules ]] && ok "dependencies installed" || bad "node_modules missing" "just setup"
[[ -f .env ]] && ok ".env present" || warn ".env missing" "scripts/secrets-decrypt.sh dev   (needs the private overlay)"
[[ -d private/.git ]] && ok "private overlay cloned" ||
  warn "private overlay missing" "git clone https://github.com/petronijus/Narrative-private.git private"
hooks_path="$(git config --get core.hooksPath || true)"
if [[ -n "$hooks_path" ]]; then
  bad "core.hooksPath=$hooks_path (left by husky; lefthook's hooks never run)" "just setup"
# In a linked worktree `.git` is a file; the hooks live in the main checkout's git directory.
elif pre_commit="$(git rev-parse --path-format=absolute --git-path hooks/pre-commit)" &&
  [[ -x "$pre_commit" ]] && grep -q lefthook "$pre_commit"; then
  ok "git hooks installed (lefthook)"
else
  warn "git hooks not installed" "just setup"
fi

exit $fail
