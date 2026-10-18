/**
 * node/photos.ts — the photos the browser scenes place (scenes.ts): six JPEGs
 * of 3200 × 2133, generated once with ImageMagick from fixed seeds into the
 * harness's cache, or the *.jpg of PERF_PHOTOS (the old probe's knob).
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { perfHome } from './store.js'

/** JPEGs to upload: PERF_PHOTOS, or six generated once (fixed seed) into the harness cache. */
export function photoFiles(): string[] {
  let dir = process.env['PERF_PHOTOS']
  if (dir === undefined || dir === '') {
    dir = path.join(perfHome(), 'photos-v1')
    mkdirSync(dir, { recursive: true })
    for (let i = 1; i <= 6; i++) {
      const file = path.join(dir, `photo${i}.jpg`)
      if (!existsSync(file)) {
        execFileSync('magick', [
          ...['-seed', String(i), '-size', '3200x2133', 'plasma:fractal'],
          ...['-attenuate', '0.6', '+noise', 'Gaussian', '-quality', '82', file],
        ])
      }
    }
  }
  return readdirSync(dir)
    .filter((f) => f.endsWith('.jpg'))
    .sort()
    .map((f) => path.join(dir, f))
}
