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

# Playwright's `channel: 'chrome'` looks for Chrome at its fixed install path
# (/opt/google/chrome/chrome on Linux) whatever is on PATH, so a wrapper named
# google-chrome, or only the beta or Chromium installed, is no Chrome to it.
# Use the channel where that path exists; otherwise name a binary that does
# exist (stable channels first, as apps/render-worker/src/browser.ts does).
if [[ -z "${PLAYWRIGHT_USE_SYSTEM_CHROME:-}${PLAYWRIGHT_CHROME_EXECUTABLE:-}" ]]; then
  if [[ -x /opt/google/chrome/chrome || -x "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ]]; then
    echo "export PLAYWRIGHT_USE_SYSTEM_CHROME=1"
  else
    found=""
    # A stable channel before the beta: Chrome 156 beta fails
    # route-load-failure's "failed dependency" case that 152 passes (2026-10-10).
    for candidate in /usr/bin/google-chrome-stable /usr/bin/google-chrome /usr/bin/chromium \
      /usr/bin/chromium-browser /usr/bin/google-chrome-beta; do
      if [[ -x "$candidate" ]]; then
        found="$candidate"
        break
      fi
    done
    if [[ -n "$found" ]]; then
      echo "export PLAYWRIGHT_CHROME_EXECUTABLE=$found"
    else
      echo "echo 'no browser for Playwright: pnpm --filter web exec playwright install chromium, or install Google Chrome or Chromium' >&2; exit 1"
      exit 0
    fi
  fi
fi
[[ -n "${PLAYWRIGHT_NO_VIDEO:-}" ]] || echo "export PLAYWRIGHT_NO_VIDEO=1"
