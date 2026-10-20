#!/usr/bin/env node
// precompress.mjs — writes `<file>.br` and `<file>.gz` next to every
// compressible file of the production build (`dist/`), at the highest
// settings, once per build. Caddy serves them as they are
// (`file_server { precompressed br gzip }`, infra/caddy/Caddyfile), so no
// request pays for compression and brotli's best level costs nothing at
// runtime. A file whose compressed copy would not be smaller gets none.
//
//   node scripts/precompress.mjs [dist]

import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { brotliCompress, constants, gzip } from 'node:zlib'

const brotli = promisify(brotliCompress)
const gz = promisify(gzip)

const COMPRESSIBLE = new Set([
  '.js',
  '.mjs',
  '.css',
  '.html',
  '.svg',
  '.json',
  '.txt',
  '.xml',
  '.webmanifest',
  '.map',
])
const MIN_BYTES = 1024

const root = path.resolve(process.argv[2] ?? path.join(import.meta.dirname, '..', 'dist'))

async function* files(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) yield* files(full)
    else if (entry.isFile()) yield full
  }
}

let raw = 0
let br = 0
let count = 0
const jobs = []
for await (const file of files(root)) {
  if (!COMPRESSIBLE.has(path.extname(file))) continue
  if ((await stat(file)).size < MIN_BYTES) continue
  jobs.push(
    (async () => {
      const source = await readFile(file)
      const [b, g] = await Promise.all([
        brotli(source, {
          params: {
            [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY,
            [constants.BROTLI_PARAM_SIZE_HINT]: source.length,
            [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT,
          },
        }),
        gz(source, { level: 9 }),
      ])
      if (b.length < source.length) await writeFile(`${file}.br`, b)
      if (g.length < source.length) await writeFile(`${file}.gz`, g)
      raw += source.length
      br += Math.min(b.length, source.length)
      count += 1
    })(),
  )
}
await Promise.all(jobs)

const kb = (n) => `${(n / 1024).toFixed(0)} kB`
const relative = path.relative(process.cwd(), root)
const shown = relative.startsWith('..') ? root : relative || '.'
console.log(`precompress: ${count} files in ${shown}, ${kb(raw)} → ${kb(br)} brotli`)
