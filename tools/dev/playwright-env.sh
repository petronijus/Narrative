#!/usr/bin/env bash
# Prints the environment Playwright needs on this machine, for `eval "$(…)"`
# (used by `just e2e` and `just eval`). Where Playwright's own Chromium — the
# full browser and the headless shell headless runs use, at the revisions
# this Playwright version expects — is installed, nothing is printed. Where
# it is not (Playwright ships no build for Ubuntu 26.04) the system Chrome is
# used and video capture is off (it needs Playwright's ffmpeg build too);
# apps/web/playwright.config.ts reads these variables. Variables the caller
# already set win (PLAYWRIGHT_CHROME_EXECUTABLE pins a binary, e.g.
# /usr/bin/google-chrome-stable on Arch).
set -uo pipefail

root="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
installed="$(cd "$root/apps/web" && node -e '
  const path = require("path"), fs = require("fs"), os = require("os")
  try {
    const dir = path.dirname(require.resolve("playwright-core/package.json"))
    const want = JSON.parse(fs.readFileSync(path.join(dir, "browsers.json"))).browsers
    const cache = process.env.PLAYWRIGHT_BROWSERS_PATH ||
      (process.platform === "darwin" ? path.join(os.homedir(), "Library/Caches/ms-playwright")
        : path.join(os.homedir(), ".cache/ms-playwright"))
    const ok = ["chromium", "chromium-headless-shell"].every((name) => {
      const b = want.find((x) => x.name === name)
      return b && fs.existsSync(path.join(cache, name.replace(/-/g, "_") + "-" + b.revision))
    })
    process.stdout.write(ok ? "yes" : "no")
  } catch { process.stdout.write("no") }' 2>/dev/null)"
[[ "$installed" == yes ]] && exit 0

if [[ -z "${PLAYWRIGHT_USE_SYSTEM_CHROME:-}${PLAYWRIGHT_CHROME_EXECUTABLE:-}" ]]; then
  if command -v google-chrome >/dev/null 2>&1 || command -v google-chrome-stable >/dev/null 2>&1; then
    echo "export PLAYWRIGHT_USE_SYSTEM_CHROME=1"
  else
    echo "echo 'no browser for Playwright: pnpm --filter web exec playwright install chromium, or install Google Chrome' >&2; exit 1"
    exit 0
  fi
fi
[[ -n "${PLAYWRIGHT_NO_VIDEO:-}" ]] || echo "export PLAYWRIGHT_NO_VIDEO=1"
