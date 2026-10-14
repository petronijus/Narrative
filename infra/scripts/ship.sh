#!/usr/bin/env bash
# `just deploy vX.Y.Z`: ship a pushed release tag to production from any of
# Petr's machines.
#
# The machine this runs on only checks and orders; the build host
# (infra/release.env → NARRATIVE_BUILDER, an always-on x86_64 VM on the LAN)
# fetches the tag from GitHub, builds the images without secrets, pushes them
# to GHCR, syncs the tagged tree to the VM and runs deploy.sh there
# (infra/scripts/remote-release.sh). So a deploy no longer depends on this
# machine's uplink, CPU architecture, Docker or copy of infra/.env.prod —
# each of which stopped the 0.10.18 deploy from a MacBook on 2026-10-07/09.
#
# Needs here: git, ssh with the 1Password agent (it reaches the builder, and
# forwarded, the VM), Tailscale, and `gh` logged in (a read token for the
# fetch, passed on stdin and never stored on the builder).
#
#   infra/scripts/ship.sh v0.10.18
#   NARRATIVE_BUILDER=user@host infra/scripts/ship.sh v0.10.18   # another builder
set -euo pipefail

tag="${1:?usage: ship.sh vX.Y.Z}"
[[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "✗ ${tag} is not a release tag (vX.Y.Z)" >&2; exit 64; }

root="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
cd "$root"

# A release setting: the environment, then the private overlay
# (private/release.env: the build host and the VM), then infra/release.env.
setting() {
  local name="$1" value file
  value="${!name:-}"
  for file in private/release.env infra/release.env; do
    [[ -n "$value" || ! -f "$file" ]] || value="$(sed -n "s/^${name}=//p" "$file" | tail -n 1)"
  done
  [[ -n "$value" ]] || { echo "✗ ${name} is set neither in the environment nor in private/release.env or infra/release.env" >&2; exit 1; }
  printf '%s' "$value"
}
builder="$(setting NARRATIVE_BUILDER)"
vm="$(setting NARRATIVE_VM)"
domain="$(setting DOMAIN)"

fail() {
  echo "✗ $1" >&2
  [[ -z "${2:-}" ]] || echo "  fix: $2" >&2
  exit 1
}

# ── Preflight: everything the release needs, before anything is built ──────
echo "→ Preflight for ${tag}"

git ls-remote --exit-code --tags origin "refs/tags/${tag}" >/dev/null 2>&1 ||
  fail "${tag} is not on GitHub" "just bump, commit, git tag -a ${tag}, git push origin main ${tag}"

# The scripts that do the release are this checkout's HEAD; the builder takes
# them from GitHub, so HEAD must be there (uncommitted work does not matter).
tooling="$(git rev-parse HEAD)"
git fetch --quiet origin main 2>/dev/null || fail "cannot reach GitHub (git fetch origin main)"
git merge-base --is-ancestor "$tooling" origin/main ||
  fail "this checkout's HEAD ${tooling:0:7} is not on origin/main — the builder could not run its scripts" "git push origin main"

token="$(gh auth token 2>/dev/null)" || fail "gh is not logged in here" "gh auth login"
[[ -n "$token" ]] || fail "gh returned an empty token" "gh auth login"

ssh_builder=(ssh -A -o BatchMode=yes -o ConnectTimeout=15 -o ServerAliveInterval=30 -o ServerAliveCountMax=6 "$builder")
"${ssh_builder[@]}" true 2>/dev/null ||
  fail "the build host ${builder} does not answer over SSH" "is it up and on Tailscale? (or NARRATIVE_BUILDER=user@host)"

# shellcheck disable=SC2016  # expanded on the builder
"${ssh_builder[@]}" bash -s -- "$vm" <<'PREFLIGHT' || exit 1
set -uo pipefail
vm="$1"
fail() { echo "✗ $1" >&2; [[ -z "${2:-}" ]] || echo "  fix: $2" >&2; exit 1; }
for tool in git docker rsync flock curl python3 base64; do
  command -v "$tool" >/dev/null || fail "$(hostname) has no ${tool}"
done
docker info >/dev/null 2>&1 || fail "Docker is not running on $(hostname), or $(id -un) may not use it"
docker buildx version >/dev/null 2>&1 || fail "$(hostname) has no docker buildx"
grep -q '"ghcr.io"' ~/.docker/config.json 2>/dev/null ||
  fail "$(hostname) is not logged in to ghcr.io" "ssh $(hostname) and: docker login ghcr.io -u petronijus (a write:packages token)"
free_gb="$(df -Pk "$HOME" | awk 'NR == 2 { print int($4 / 1048576) }')"
((free_gb >= 15)) || fail "$(hostname) has ${free_gb} GB free; a build needs 15" "docker system prune / docker builder prune on $(hostname)"
# -n: this script arrives on stdin (bash -s); ssh would swallow the rest of it.
ssh -n -o BatchMode=yes -o ConnectTimeout=15 -o StrictHostKeyChecking=accept-new "$vm" 'test -f /opt/narrative/infra/.env.prod' 2>/dev/null ||
  fail "$(hostname) cannot reach the VM ${vm} with the forwarded agent, or the VM has no /opt/narrative/infra/.env.prod" \
    "approve the 1Password prompt; check that the VM is up"
echo "  builder $(hostname): docker, buildx, ghcr login, ${free_gb} GB free, VM reachable"
PREFLIGHT

# ── Release: on the builder ─────────────────────────────────────────────────
# The token goes first on stdin, then the script (from the same commit the
# builder checks out as tooling); the builder keeps neither.
echo "→ Building and deploying ${tag} on ${builder} (tooling ${tooling:0:7})"
# ssh hands the remote shell one command string, so the arguments go into it
# (both validated above: a vX.Y.Z tag and a 40-hex commit).
remote_args="$(printf '%q %q %q' "$tag" "$tooling" "$vm")"
remote_script="$(git show "${tooling}:infra/scripts/remote-release.sh" 2>/dev/null)" ||
  fail "HEAD ${tooling:0:7} has no infra/scripts/remote-release.sh" "deploy from a checkout of current main"
{
  printf '%s\n' "$token"
  printf '%s\n' "$remote_script"
} | "${ssh_builder[@]}" "IFS= read -r GH_TOKEN && export GH_TOKEN &&
    script=\"\$(mktemp)\" && cat >\"\$script\" && bash \"\$script\" ${remote_args}; rc=\$?; rm -f \"\$script\"; exit \$rc"

# The builder checked it already; this is the view from here.
served="$(curl -fsS --max-time 15 "https://${domain}/version.json")" ||
  fail "https://${domain}/version.json does not answer from here"
echo "$served"
[[ "$served" == *"\"${tag}+"* ]] || fail "production does not serve ${tag}"
echo "✓ ${tag} is live on https://${domain}"
