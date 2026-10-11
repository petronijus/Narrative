#!/usr/bin/env bash
# Install the AppArmor profile that lets this checkout's development Electron
# binary create the user namespaces its sandbox needs. Ubuntu 23.10 and later
# (26.04 included) deny unprivileged user namespaces to every program without
# a profile (kernel.apparmor_restrict_unprivileged_userns=1); the installed
# app gets its profile from the .deb, but node_modules/electron/dist/electron
# of a checkout has none, and Electron then refuses to start rather than run
# unsandboxed (apps/desktop/src/main/index.ts never adds --no-sandbox).
#
# The profile is named after the binary's path, so every checkout (the main
# worktree, a feature worktree) gets its own; `--check` only reports.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
binary="$root/node_modules/electron/dist/electron"
restrict=/proc/sys/kernel/apparmor_restrict_unprivileged_userns

profile_name() { printf 'narrative-electron-dev-%s' "$(printf '%s' "$binary" | sha256sum | cut -c1-8)"; }

needed() { [[ -r "$restrict" && "$(cat "$restrict")" == 1 ]]; }

if [[ "${1:-}" == --check ]]; then
  needed || exit 0
  [[ -f "/etc/apparmor.d/$(profile_name)" ]] && exit 0
  exit 1
fi

if ! needed; then
  echo "desktop-apparmor: this system does not restrict user namespaces; nothing to do."
  exit 0
fi
[[ -x "$binary" ]] || { echo "desktop-apparmor: no Electron binary at $binary; run \`just desktop\` once first." >&2; exit 1; }

name="$(profile_name)"
tmp="$(mktemp)"
cat >"$tmp" <<PROFILE
# Narrative desktop (development): $binary
abi <abi/4.0>,
include <tunables/global>

profile $name "$binary" flags=(unconfined) {
  userns,
  include if exists <local/$name>
}
PROFILE
sudo install -m 0644 "$tmp" "/etc/apparmor.d/$name"
rm -f "$tmp"
sudo apparmor_parser -r "/etc/apparmor.d/$name"
echo "desktop-apparmor: /etc/apparmor.d/$name loaded."
