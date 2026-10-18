#!/usr/bin/env node
/**
 * scripts/routeSizes.mjs — the first-paint payload of each route, against
 * its budget (`just size`, after size-limit's per-chunk budgets;
 * docs/plans/performance.md → L1).
 *
 * A route's first paint is what the browser must download before the page
 * can render: the entry chunk and everything index.html preloads, plus the
 * lazy route modules the page renders at once (a deck route's DeckShell and
 * its page) with their static imports — Vite's preload helper fetches those
 * together with the route chunk. Lazily loaded parts of a page (dialogs,
 * the notes panel) are not first paint. The chunk graph is read from the
 * build's manifest (`build.manifest`, written when NARRATIVE_BUILD_MANIFEST=1
 * — the root `size` script sets it).
 *
 * Sizes are gzip level 9, what the precompressed `.gz` next to each file
 * weighs (scripts/precompress.mjs); brotli, which Caddy prefers, is smaller.
 * Budgets only ever go down (AGENTS.md → When to run what). Measured on
 * 2026-10-18 (L1/L2): login 125.0, home 179.2, folder 259.5, editor 708.4,
 * present 583.9 kB — before L1 every route but the deck's paid 603.9, the
 * editor 912.0 and present 822.9.
 *
 * Usage: node scripts/routeSizes.mjs [distDir] [--json]
 */

import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { gzipSync, constants } from 'node:zlib'

/**
 * The routes, the lazy modules each renders at first paint (manifest keys:
 * source paths relative to apps/web), and the budget of JS + CSS in kB gz.
 * The share link is the editor's route with a `share_token` (a viewer): the
 * same chunks, listed so its budget is explicit.
 */
const ROUTES = [
  { name: 'login (/auth/login)', modules: [], budgetKb: 135 },
  { name: 'folders home (/)', modules: ['src/pages/FoldersHome.tsx'], budgetKb: 190 },
  { name: 'folder (/folder/:id)', modules: ['src/pages/FolderDecks.tsx'], budgetKb: 275 },
  {
    name: 'editor (/deck/:id)',
    modules: ['src/components/DeckShell.tsx', 'src/pages/DeckEditor.tsx'],
    budgetKb: 740,
  },
  {
    name: 'present (/deck/:id/present)',
    modules: ['src/components/DeckShell.tsx', 'src/pages/DeckPresent.tsx'],
    budgetKb: 615,
  },
  {
    name: 'share link (/deck/:id?share_token)',
    modules: ['src/components/DeckShell.tsx', 'src/pages/DeckEditor.tsx'],
    budgetKb: 740,
  },
]

const args = process.argv.slice(2)
const json = args.includes('--json')
const dist = path.resolve(args.find((a) => !a.startsWith('--')) ?? 'dist')
const manifestFile = path.join(dist, '.vite', 'manifest.json')
if (!existsSync(manifestFile)) {
  console.error(
    `routeSizes: no ${path.relative(process.cwd(), manifestFile)} — build with NARRATIVE_BUILD_MANIFEST=1 (just size does)`,
  )
  process.exit(2)
}
/** @type {Record<string, { file: string, imports?: string[], css?: string[], isEntry?: boolean }>} */
const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'))

const warnings = new Set()
const gzCache = new Map()
function gzBytes(file) {
  let size = gzCache.get(file)
  if (size === undefined) {
    size = gzipSync(readFileSync(path.join(dist, file)), {
      level: constants.Z_BEST_COMPRESSION,
    }).length
    gzCache.set(file, size)
  }
  return size
}

/** Every file a manifest entry needs at once: its chunk, static imports and CSS, recursively. */
function closure(keys) {
  const js = new Set()
  const css = new Set()
  const seen = new Set()
  const visit = (key) => {
    if (seen.has(key)) return
    seen.add(key)
    const chunk = manifest[key]
    if (chunk === undefined) {
      // Not a chunk of its own: a module bundled into the entry (an eager
      // page) — or a typo, which the warning shows.
      warnings.add(`${key} is no chunk of its own in this build (eager, or renamed)`)
      return
    }
    js.add(chunk.file)
    for (const file of chunk.css ?? []) css.add(file)
    for (const dep of chunk.imports ?? []) visit(dep)
  }
  for (const key of keys) visit(key)
  return { js: [...js], css: [...css] }
}

const kb = (bytes) => bytes / 1024
const results = ROUTES.map((route) => {
  const files = closure(['index.html', ...route.modules])
  const jsBytes = files.js.reduce((sum, f) => sum + gzBytes(f), 0)
  const cssBytes = files.css.reduce((sum, f) => sum + gzBytes(f), 0)
  const largest = files.js
    .map((f) => ({ file: f, kb: kb(gzBytes(f)) }))
    .sort((a, b) => b.kb - a.kb)
    .slice(0, 6)
  return {
    name: route.name,
    jsKb: kb(jsBytes),
    cssKb: kb(cssBytes),
    totalKb: kb(jsBytes + cssBytes),
    budgetKb: route.budgetKb,
    chunks: files.js.length,
    largest,
  }
})

if (json) {
  console.log(JSON.stringify(results, null, 2))
} else {
  console.log('First-paint payload per route (gzip -9, JS + CSS):')
  for (const r of results) {
    const mark = r.totalKb > r.budgetKb ? 'OVER' : 'ok'
    console.log(
      `  ${mark.padEnd(4)} ${r.name.padEnd(36)} ${r.totalKb.toFixed(1).padStart(6)} kB` +
        ` (JS ${r.jsKb.toFixed(1)}, CSS ${r.cssKb.toFixed(1)}, ${r.chunks} chunks)` +
        `  budget ${r.budgetKb} kB`,
    )
    console.log(
      `       largest: ${r.largest.map((c) => `${path.basename(c.file)} ${c.kb.toFixed(1)}`).join(', ')}`,
    )
  }
}
for (const warning of warnings) console.warn(`routeSizes: ${warning}`)
const over = results.filter((r) => r.totalKb > r.budgetKb)
if (over.length > 0) {
  console.error(`routeSizes: over budget: ${over.map((r) => r.name).join(', ')}`)
  process.exit(1)
}
