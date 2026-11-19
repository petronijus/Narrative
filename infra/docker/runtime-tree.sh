#!/bin/sh
# runtime-tree.sh <app> <out> — the runtime tree of one Node app image,
# assembled in its Dockerfile's builder stage after `bun run --cwd apps/<app>
# build` (performance plan D2). The runtime stage copies <out> to /app and
# nothing else: no Bun, no package cache, no sources, no dev dependencies.
#
#   <out>/apps/<app>/package.json   (the server reads its version from it)
#   <out>/apps/<app>/dist/apps/<app>/src/…   the compiled app (entry unchanged)
#   <out>/node_modules/…            the app's production dependencies only
#                                   (a production install filtered to the
#                                   app, below), its workspace packages as
#                                   compiled JavaScript
#
# The app's tsc (rootDir = the repo) also emits the workspace packages it
# imports under dist/packages/<pkg>/src; those become node_modules/@narrative/
# <pkg> (with the package's package.json and, for commands, its playbooks) in
# place of the install's symlink to the TypeScript package, and each
# package.json's ./src/*.ts entries are pointed at the .js. A workspace
# package without a compiled copy fails the build: the runtime Node cannot
# load .ts from node_modules.
#
# Pruned from third-party packages, as nothing at runtime reads them: type
# declarations, TypeScript sources, source maps and Markdown (licences stay;
# @narrative/* keeps everything — the playbooks are Markdown).
#
# Runs in the builder stage's /app with the workspace installed and Bun on
# PATH; Bun's package cache is the builder's cache mount
# (BUN_INSTALL_CACHE_DIR), which this install reuses.
set -eu

app="${1:?usage: runtime-tree.sh <app> <out>}"
out="${2:?usage: runtime-tree.sh <app> <out>}"

# The app's production dependencies: a second install, in a directory holding
# only the manifests (the same pruned workspace the builder installed from;
# Bun refuses a lockfile workspace whose dependents are present without it),
# with --production and filtered to the app. --backend=copyfile: real files,
# never hard links into the cache mount, which is not part of the image.
deploy_dir="$(mktemp -d)"
cp package.json bun.lock bunfig.toml "$deploy_dir/"
cp -R patches "$deploy_dir/patches"
for manifest in apps/*/package.json packages/*/package.json; do
  [ -f "$manifest" ] || continue
  mkdir -p "${deploy_dir}/$(dirname "$manifest")"
  cp "$manifest" "${deploy_dir}/${manifest}"
done
(cd "$deploy_dir" && bun install --frozen-lockfile --production --ignore-scripts \
  --backend=copyfile --filter "@narrative/${app}")

mkdir -p "${out}/apps/${app}"
cp "apps/${app}/package.json" "${out}/apps/${app}/package.json"
cp -R "apps/${app}/dist" "${out}/apps/${app}/dist"
mv "${deploy_dir}/node_modules" "${out}/node_modules"
# A dependency version Bun could not hoist sits in the app's own node_modules:
# next to dist/, where the compiled entry still resolves it.
if [ -d "${deploy_dir}/apps/${app}/node_modules" ]; then
  mv "${deploy_dir}/apps/${app}/node_modules" "${out}/apps/${app}/node_modules"
fi
# The install links every workspace member into node_modules/@narrative,
# the app itself included: the app runs from apps/<app>, not from there.
rm -f "${out}/node_modules/@narrative/${app}"

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
    # The install left a symlink to the workspace directory (configs,
    # scripts, local leftovers such as .stryker-tmp/). In its place: the
    # package.json, the compiled src/, the playbooks (commands: Markdown the
    # MCP server serves) and a nested node_modules (a dependency version Bun
    # could not hoist), nothing else.
    ws_dir="packages/${pkg}"
    [ -f "${ws_dir}/package.json" ] || ws_dir="apps/${pkg}"
    rm -f "$pkg_dir"
    mkdir -p "$pkg_dir"
    cp "${ws_dir}/package.json" "${pkg_dir}/package.json"
    [ -d "${ws_dir}/playbooks" ] && cp -R "${ws_dir}/playbooks" "${pkg_dir}/playbooks"
    [ -d "${deploy_dir}/${ws_dir}/node_modules" ] && mv "${deploy_dir}/${ws_dir}/node_modules" "${pkg_dir}/node_modules"
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
# The install's bin links (they point into packages nobody runs from the
# image) and any tool cache.
rm -rf "${out}/node_modules/.bin" "${out}/node_modules/.cache" "$deploy_dir"
