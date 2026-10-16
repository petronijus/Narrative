#!/usr/bin/env bash
# `just desktop-publish <linux|mac|win>`: put one platform's desktop app
# release into the update feed on the production VM (ADR 0015,
# docs/plans/desktop-d0-spec.md §6). The feed is code delivery: every
# installed app updates from it, so only a released build goes there.
#
#   1. HEAD is the release tag vX.Y.Z (on GitHub), the tree is clean, and the
#      build in apps/desktop/release says it was made from exactly that
#      commit, clean, with the committed servers.json;
#   2. every artefact is signed through the 1Password SSH agent
#      (apps/desktop/scripts/sign-release.mjs — one approval each);
#   3. the VM has room (5 GB), then the binaries, blockmaps and signatures go
#      up first and the platform's latest*.yml last, so no installed app ever
#      sees a version whose files are not there yet;
#   4. the feed keeps the live version and two older ones per platform; older
#      files go to the VM's trash (never deleted outright).
#
# Linux and Windows publish from the Linux desktop, macOS from the MacBook;
# each needs SSH to the VM (NARRATIVE_VM in infra/release.env).
set -euo pipefail

platform="${1:?usage: desktop-publish.sh <linux|mac|win>}"
case "$platform" in
  linux) yml=latest-linux.yml ;;
  mac) yml=latest-mac.yml ;;
  win) yml=latest.yml ;;
  *) echo "✗ desktop-publish: linux, mac or win" >&2; exit 64 ;;
esac

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
cd "$root"
release="apps/desktop/release"

fail() {
  echo "✗ $1" >&2
  [[ -z "${2:-}" ]] || echo "  fix: $2" >&2
  exit 1
}
setting() {
  local name="$1" value
  value="${!name:-}"
  [[ -n "$value" ]] || value="$(sed -n "s/^${name}=//p" infra/release.env | tail -n 1)"
  [[ -n "$value" ]] || fail "${name} is set neither in the environment nor in infra/release.env"
  printf '%s' "$value"
}
vm="$(setting NARRATIVE_VM)"
feed=/opt/narrative/desktop-feed
version="$(node -p 'require("./apps/desktop/package.json").version')"
tag="v${version}"

# ── 1. A released, clean build ───────────────────────────────────────────────
echo "→ Checking the ${platform} build of ${tag}"
[[ -z "$(git status --porcelain)" ]] || fail "the working tree is not clean" "commit or stash first"
[[ "$(git describe --exact-match --tags HEAD 2>/dev/null)" == "$tag" ]] ||
  fail "HEAD is not ${tag}" "check out the release tag (just bump, commit, tag, push)"
git ls-remote --exit-code --tags origin "refs/tags/${tag}" >/dev/null 2>&1 ||
  fail "${tag} is not on GitHub" "git push origin ${tag}"
[[ -f "${release}/release-info.json" ]] || fail "no packaged build here" "just desktop-dist ${platform}"

[[ -f "${release}/${yml}" ]] || fail "no ${yml} in ${release}" "just desktop-dist ${platform}"
# bash 3.2 (macOS) has no mapfile.
binaries=()
while IFS= read -r f; do binaries+=("$f"); done < <(find "$release" -maxdepth 1 -type f \
  -name "narrative-${version}-${platform}-*" ! -name '*.blockmap' ! -name '*.manifest' ! -name '*.sig' | sort)
[[ ${#binaries[@]} -gt 0 ]] || fail "no ${platform} artefacts of ${version} in ${release}"
blockmaps=()
while IFS= read -r f; do blockmaps+=("$f"); done < <(find "$release" -maxdepth 1 -type f \
  -name "narrative-${version}-${platform}-*.blockmap" | sort)

# The packages themselves, not just the last bundle, must be the release:
# release-info.json binds each package's hash to the build it came from.
build="$(node apps/desktop/scripts/release-info.mjs check "${binaries[@]}" ${blockmaps[@]+"${blockmaps[@]}"} "${release}/${yml}")" ||
  fail "a package in ${release} is not from the last build" "just desktop-dist ${platform} on the tag"
node -e '
  const info = JSON.parse(process.argv[1])
  const [commit, version] = process.argv.slice(2)
  const problems = []
  if (info.commit !== commit) problems.push(`built from ${info.commit.slice(0, 7)}, not ${commit.slice(0, 7)}`)
  if (info.version !== version) problems.push(`built as ${info.version}, not ${version}`)
  if (info.dirty) problems.push("built from a dirty tree")
  if (!info.serversJsonDefault) problems.push("built with a changed servers.json")
  if (problems.length) { console.error(problems.join("; ")); process.exit(1) }
' "$build" "$(git rev-parse HEAD)" "$version" ||
  fail "the build is not the release" "just desktop-dist ${platform} on the tag"

# ── 2. Sign ──────────────────────────────────────────────────────────────────
echo "→ Signing ${#binaries[@]} artefacts (1Password asks for each)"
node apps/desktop/scripts/sign-release.mjs "${binaries[@]}"

# ── 3. Upload: files first, the feed's metadata last ─────────────────────────
ssh_vm=(ssh -o BatchMode=yes -o ConnectTimeout=15)
free_kb="$("${ssh_vm[@]}" "$vm" "mkdir -p ${feed} && df -Pk ${feed} | awk 'NR==2 {print \$4}'")"
[[ "$free_kb" -ge $((5 * 1024 * 1024)) ]] ||
  fail "the VM has less than 5 GB free at ${feed}" "free space there (docs/deploy.md → disk space)"

uploads=("${binaries[@]}" ${blockmaps[@]+"${blockmaps[@]}"})
for b in "${binaries[@]}"; do uploads+=("${b}.manifest" "${b}.manifest.sig"); done
echo "→ Uploading to ${vm}:${feed}"
rsync -a --chmod=F644 -e "${ssh_vm[*]}" "${uploads[@]}" "${vm}:${feed}/"
rsync -a --chmod=F644 -e "${ssh_vm[*]}" "${release}/${yml}" "${vm}:${feed}/"

# ── 4. Prune: the live version and two older ones per platform ───────────────
"${ssh_vm[@]}" "$vm" bash -s -- "$feed" "$platform" <<'REMOTE'
set -euo pipefail
feed="$1" platform="$2"
cd "$feed"
mapfile -t versions < <(ls -1 | sed -n "s/^narrative-\([0-9][0-9.]*\)-${platform}-.*/\1/p" | sort -uV)
(( ${#versions[@]} > 3 )) || exit 0
old=("${versions[@]:0:${#versions[@]}-3}")
if command -v gio >/dev/null && gio trash --help >/dev/null 2>&1; then trash=(gio trash)
elif command -v trash-put >/dev/null; then trash=(trash-put)
else
  echo "! not pruning ${old[*]}: no trash command on the VM (install trash-cli)" >&2
  exit 0
fi
for v in "${old[@]}"; do
  "${trash[@]}" narrative-"${v}"-"${platform}"-*
  echo "  pruned ${v} (to the VM's trash)"
done
REMOTE

echo "✓ ${platform} ${version} is in the feed: https://$(setting DOMAIN)/desktop/${yml}"
