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
 *   dist/serverDialog.html + dist/serverDialogPreload.cjs
 *                        the "Custom Server…" window: its script inlined
 *                        into the page, which admits exactly that script by
 *                        its sha256 in the CSP;
 *   dist/build-info.json what was built: version, commit, whether the tree
 *                        was dirty and whether servers.json is the committed
 *                        default (a release refuses anything else).
 *
 * `node scripts/build.mjs [--out <dir>]` from apps/desktop (default dist/);
 * `just desktop` runs it, the build test writes to a temporary directory.
 */

import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outIndex = process.argv.indexOf('--out')
const dist =
  outIndex === -1 ? path.join(root, 'dist') : path.resolve(process.argv[outIndex + 1] ?? '')
const rel = (/** @type {string} */ file) => path.join(dist, file)

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

/** The dialog page with its script inlined and admitted by hash. */
async function buildServerDialog() {
  const out = await build({
    ...common,
    entryPoints: ['src/serverDialog/dialog.ts'],
    format: 'iife',
    platform: 'browser',
    target: 'chrome152',
    sourcemap: false,
    write: false,
  })
  const script = out.outputFiles?.[0]?.text
  if (script === undefined) throw new Error('the server dialog script was not built')
  const hash = `sha256-${createHash('sha256').update(script, 'utf8').digest('base64')}`
  const template = readFileSync(path.join(root, 'src/serverDialog/index.html'), 'utf8')
  const scriptTag = /<script>\s*__SCRIPT__\s*<\/script>/
  const hashes = template.split('__SCRIPT_HASH__').length - 1
  if (!scriptTag.test(template) || hashes !== 1) {
    throw new Error('serverDialog/index.html lost its __SCRIPT__ or __SCRIPT_HASH__ placeholder')
  }
  const html = template
    .replace('__SCRIPT_HASH__', hash)
    .replace(scriptTag, () => `<script>${script}</script>`)
  writeFileSync(path.join(dist, 'serverDialog.html'), html)
}

await Promise.all([
  buildServerDialog(),
  build({
    ...common,
    entryPoints: ['src/serverDialog/preload.ts'],
    outfile: rel('serverDialogPreload.cjs'),
    platform: 'browser',
    target: 'chrome152',
    plugins: [preloadImportGuard],
  }),
  build({
    ...common,
    entryPoints: ['src/main/index.ts'],
    outfile: rel('main.cjs'),
    platform: 'node',
    target: 'node24',
    external: ['electron'],
  }),
  build({
    ...common,
    entryPoints: ['src/preload/index.ts'],
    outfile: rel('preload.cjs'),
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
