/**
 * scripts/build.mjs
 *
 * Bundles the desktop shell (docs/plans/desktop-d0-spec.md §1, §2):
 *   dist/main.cjs        the main process — everything it imports inlined
 *                        (servers.json, @narrative/shared, zod, later
 *                        electron-updater), only `electron` and Node's
 *                        built-ins left as requires, so the packaged app
 *                        needs no node_modules;
 *   dist/preload.cjs     the main window's preload — one CommonJS file whose
 *                        only require is `electron`, because a sandboxed
 *                        preload may load nothing else;
 *   dist/build-info.json what was built: version, commit, whether the tree
 *                        was dirty and whether servers.json is the committed
 *                        default (a release refuses anything else).
 *
 * `node scripts/build.mjs` from apps/desktop; `just desktop` runs it.
 */

import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dist = path.join(root, 'dist')

/** @param {string[]} args */
function git(args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
}

/**
 * A sandboxed preload can require `electron` and nothing else: refuse any
 * other import that would be left unbundled, by name, instead of letting
 * the window fail to start.
 * @type {import('esbuild').Plugin}
 */
const preloadImportGuard = {
  name: 'preload-import-guard',
  setup(b) {
    b.onResolve({ filter: /^(node:|[a-z@])/ }, (args) => {
      if (args.path === 'electron') return { path: 'electron', external: true }
      if (args.path.startsWith('node:')) {
        return { errors: [{ text: `a preload cannot import ${args.path} (sandboxed preload)` }] }
      }
      return undefined
    })
  },
}

/** @type {import('esbuild').BuildOptions} */
const common = {
  bundle: true,
  format: 'cjs',
  sourcemap: 'linked',
  legalComments: 'none',
  logLevel: 'warning',
  absWorkingDir: root,
}

rmSync(dist, { recursive: true, force: true })
mkdirSync(dist, { recursive: true })

await Promise.all([
  build({
    ...common,
    entryPoints: ['src/main/index.ts'],
    outfile: 'dist/main.cjs',
    platform: 'node',
    target: 'node24',
    external: ['electron'],
  }),
  build({
    ...common,
    entryPoints: ['src/preload/index.ts'],
    outfile: 'dist/preload.cjs',
    platform: 'browser',
    target: 'chrome152',
    plugins: [preloadImportGuard],
  }),
])

const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
const info = {
  version: pkg.version,
  commit: git(['rev-parse', 'HEAD']),
  dirty: git(['status', '--porcelain']) !== '',
  serversJsonDefault:
    git(['status', '--porcelain', '--', 'servers.json']) === '' &&
    git(['ls-files', '--error-unmatch', 'servers.json']) !== '',
}
writeFileSync(path.join(dist, 'build-info.json'), `${JSON.stringify(info, null, 2)}\n`)
