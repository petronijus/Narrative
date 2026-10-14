#!/usr/bin/env bash
# Build, push and deploy one release ON THE BUILD HOST. Not run by hand:
# infra/scripts/ship.sh (`just deploy vX.Y.Z`) streams it to the builder over
# `ssh -A` together with a GitHub token, so nothing heavy crosses the network
# of the machine `just deploy` was started on — the builder fetches the code
# from GitHub, pushes the images to GHCR and syncs the VM over the LAN.
#
#   remote-release.sh <tag> <tooling-commit> <vm>
#
# <tag> is what gets built and deployed; <tooling-commit> is the commit whose
# infra/ scripts do it (the deploying machine's HEAD), so an older tag ships
# with today's tooling; <vm> is the production VM's ssh target (the private
# overlay's NARRATIVE_VM, which the builder's public checkout does not have). Expects GH_TOKEN (read access to the repo; used for
# the fetch only, never written to disk) and the forwarded SSH agent, which
# reaches the VM.
set -euo pipefail

tag="${1:?usage: remote-release.sh <tag> <tooling-commit>}"
tooling="${2:?usage: remote-release.sh <tag> <tooling-commit> <vm>}"
vm="${3:?usage: remote-release.sh <tag> <tooling-commit> <vm>}"
: "${GH_TOKEN:?GH_TOKEN must be set (ship.sh passes it on stdin)}"

root="${HOME}/narrative-builder"
repo="${root}/repo"
mkdir -p "$root"

# One release at a time on this host: a second deploy waits for the first
# (up to 30 min) instead of building into the same worktrees.
exec 9>"${root}/lock"
if ! flock -n 9; then
  echo "→ Another Narrative deploy is running on $(hostname); waiting for it"
  flock -w 1800 9 || { echo "✗ The other deploy still holds ${root}/lock after 30 min" >&2; exit 1; }
fi

# GitHub over HTTPS with the token in the environment of the git process
# only — not on its command line (other users' `ps`), not in any config file.
github() {
  GIT_CONFIG_COUNT=1 \
    GIT_CONFIG_KEY_0="http.https://github.com/.extraheader" \
    GIT_CONFIG_VALUE_0="AUTHORIZATION: basic $(printf 'x-access-token:%s' "$GH_TOKEN" | base64 -w0)" \
    GIT_TERMINAL_PROMPT=0 \
    git "$@"
}

if [[ ! -d "${repo}/.git" ]]; then
  echo "→ First release on this host: cloning the repository"
  github clone --quiet --no-checkout https://github.com/petronijus/Narrative.git "$repo"
fi
echo "→ Fetching ${tag} and the tooling commit ${tooling:0:7}"
github -C "$repo" fetch --quiet --force --prune --tags origin '+refs/heads/*:refs/remotes/origin/*'
unset GH_TOKEN

tag_commit="$(git -C "$repo" rev-parse --verify --quiet "refs/tags/${tag}^{commit}")" ||
  { echo "✗ ${tag} is not a tag on GitHub" >&2; exit 1; }
git -C "$repo" cat-file -e "${tooling}^{commit}" 2>/dev/null ||
  { echo "✗ The tooling commit ${tooling} is not on GitHub — push it first" >&2; exit 1; }

# Fresh worktrees every time: what is built is exactly the tagged tree.
checkout() {
  local dir="$1" rev="$2"
  git -C "$repo" worktree remove --force "$dir" 2>/dev/null || rm -rf "$dir"
  git -C "$repo" worktree prune
  git -C "$repo" worktree add --quiet --detach "$dir" "$rev"
}
checkout "${root}/src" "$tag_commit"
checkout "${root}/tooling" "$tooling"

NARRATIVE_TAG="$tag" "${root}/tooling/infra/scripts/build-push.sh" --src "${root}/src"

setting() { sed -n "s/^$1=//p" "${root}/tooling/infra/release.env" | tail -n 1; }
domain="${DOMAIN:-$(setting DOMAIN)}"
ssh_vm=(ssh -o BatchMode=yes -o ConnectTimeout=15 -o StrictHostKeyChecking=accept-new)

# The VM gets the tagged tree itself (git archive: no worktree metadata, no
# gitignored files). --delete spares what lives only on the VM: its env files
# and the backups.
tree="$(mktemp -d)"
trap 'rm -rf "$tree"' EXIT
git -C "$repo" archive "$tag_commit" | tar -x -C "$tree"
echo "→ Syncing ${tag} to ${vm}:/opt/narrative"
rsync -az --delete -e "${ssh_vm[*]}" \
  --exclude /.env --exclude infra/.env.prod --exclude backups/ \
  "${tree}/" "${vm}:/opt/narrative/"

echo "→ Deploying ${tag} on ${vm}"
"${ssh_vm[@]}" -n "$vm" "chmod +x /opt/narrative/infra/scripts/*.sh &&
  cd /opt/narrative && USE_SHARED_TUNNEL=1 NARRATIVE_TAG=${tag} ./infra/scripts/deploy.sh prod"

# Production serves the release: /version.json is never cached, but give the
# containers a minute to answer after the restart.
for _ in $(seq 1 12); do
  served="$(curl -fsS --max-time 10 "https://${domain}/version.json" 2>/dev/null || true)"
  if [[ "$served" == *"\"${tag}+"* ]]; then
    echo "✓ https://${domain} serves ${served}"
    exit 0
  fi
  sleep 5
done
echo "✗ https://${domain}/version.json says '${served:-nothing}', not ${tag}" >&2
exit 1
