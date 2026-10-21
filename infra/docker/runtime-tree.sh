#!/bin/sh
# runtime-tree.sh <app> <out> — the runtime tree of one Node app image,
# assembled in its Dockerfile's builder stage after `pnpm --filter <app>
# build` (performance plan D2). The runtime stage copies <out> to /app and
# nothing else: no pnpm, no store, no sources, no dev dependencies.
#
#   <out>/apps/<app>/package.json   (the server reads its version from it)
#   <out>/apps/<app>/dist/apps/<app>/src/…   the compiled app (entry unchanged)
#   <out>/node_modules/…            the app's production dependencies only
#                                   (`pnpm deploy --prod`), its workspace
#                                   packages as compiled JavaScript
#
# The app's tsc (rootDir = the repo) also emits the workspace packages it
# imports under dist/packages/<pkg>/src; those replace the TypeScript sources
# `pnpm deploy` copies into node_modules/@narrative/<pkg>, and each
# package.json's ./src/*.ts entries are pointed at the .js. A workspace
# package without a compiled copy fails the build: the runtime Node cannot
# load .ts from node_modules.
#
# Pruned from third-party packages, as nothing at runtime reads them: type
# declarations, TypeScript sources, source maps and Markdown (licences stay;
# @narrative/* keeps everything — the playbooks are Markdown).
#
# Runs in the builder stage's /app with the workspace installed; the pnpm
# store is passed as PNPM_STORE (the cache mount `pnpm install` used).
set -eu

app="${1:?usage: runtime-tree.sh <app> <out>}"
out="${2:?usage: runtime-tree.sh <app> <out>}"
store="${PNPM_STORE:?PNPM_STORE must name the pnpm store the install used}"

deploy_dir="$(mktemp -d)"
rmdir "$deploy_dir"
pnpm --filter "@narrative/${app}" deploy --prod --ignore-scripts --frozen-lockfile \
  --store-dir "$store" "$deploy_dir"

mkdir -p "${out}/apps/${app}"
cp "apps/${app}/package.json" "${out}/apps/${app}/package.json"
cp -R "apps/${app}/dist" "${out}/apps/${app}/dist"
mv "${deploy_dir}/node_modules" "${out}/node_modules"
rm -rf "$deploy_dir"

# Workspace packages: compiled JavaScript instead of TypeScript.
compiled_root="${out}/apps/${app}/dist/packages"
if [ -d "${out}/node_modules/@narrative" ]; then
  for pkg_dir in "${out}/node_modules/@narrative"/*; do
    pkg="$(basename "$pkg_dir")"
    compiled="${compiled_root}/${pkg}/src"
    if [ ! -d "$compiled" ]; then
      echo "runtime-tree: @narrative/${pkg} has no compiled copy in apps/${app}/dist/packages" >&2
      exit 1
    fi
    # `pnpm deploy` copies the whole package directory (configs, scripts,
    # local leftovers such as .stryker-tmp/): keep package.json, the
    # compiled src/, the playbooks (commands: Markdown the MCP server
    # serves) and a nested node_modules (a dependency version pnpm could
    # not hoist), drop everything else.
    for entry in "$pkg_dir"/* "$pkg_dir"/.[!.]*; do
      [ -e "$entry" ] || continue
      case "$(basename "$entry")" in
        package.json | playbooks | node_modules) ;;
        *) rm -rf "$entry" ;;
      esac
    done
    cp -R "$compiled" "${pkg_dir}/src"
    # main / exports at the compiled .js; scripts and dev dependencies go.
    node - "${pkg_dir}/package.json" <<'NODE'
const fs = require('node:fs')
const file = process.argv[2]
const pkg = JSON.parse(fs.readFileSync(file, 'utf8'))
const toJs = (v) => {
  if (typeof v === 'string') {
    if (!/^\.\/src\/.+\.ts$/.test(v)) return v
    const js = v.replace(/\.ts$/, '.js')
    if (!fs.existsSync(require('node:path').join(require('node:path').dirname(file), js))) {
      throw new Error(`${pkg.name}: ${js} was not compiled`)
    }
    return js
  }
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, toJs(x)]))
  return v
}
pkg.main = toJs(pkg.main)
if (pkg.exports !== undefined) pkg.exports = toJs(pkg.exports)
delete pkg.scripts
delete pkg.devDependencies
const left = JSON.stringify([pkg.main, pkg.exports]).match(/"[^"]*\.ts"/)
if (left) throw new Error(`${pkg.name}: an entry still names ${left[0]}`)
fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n')
NODE
  done
fi
# The compiled packages live in node_modules now; the app's copy is unused.
rm -rf "$compiled_root"
# A copy of a workspace package nested deeper than node_modules/@narrative/
# would still be TypeScript: refuse it rather than ship it.
left_ts="$(find "${out}/node_modules" -path '*/@narrative/*' -name '*.ts' | head -n 5)"
if [ -n "$left_ts" ]; then
  echo "runtime-tree: TypeScript left in a workspace package:" >&2
  echo "$left_ts" >&2
  exit 1
fi

# Our own packages keep every file: the commands package's playbooks are
# Markdown the MCP server serves.
find "${out}/node_modules" -path "${out}/node_modules/@narrative" -prune -o -type f \( \
  -name '*.ts' -o -name '*.mts' -o -name '*.cts' -o -name '*.tsx' \
  -o -name '*.map' -o -iname '*.md' -o -iname '*.markdown' \
  -o -name 'tsconfig*.json' -o -name '.npmignore' -o -name '.eslintrc*' -o -name '.prettierrc*' \
  \) -exec rm -f {} +
# pnpm's own bookkeeping of the deploy.
rm -rf "${out}/node_modules/.pnpm" "${out}/node_modules/.modules.yaml" \
  "${out}/node_modules/.pnpm-workspace-state"*.json "${out}/node_modules/.cache"
