/**
 * lib/tusClient.ts — tus-js-client, loaded when an upload starts.
 *
 * The folder pages (PPTX import) and the editor (media uploads) import it
 * only to start an upload, so it is its own chunk instead of part of their
 * first paint (docs/plans/performance.md → L1). One promise per page: the
 * first upload fetches it, the rest share it. `preloadTus` warms it on an
 * upload intent (a file dragged over, a picker opened) or when idle.
 */

import type * as Tus from 'tus-js-client'

type TusModule = typeof Tus

let tusModule: Promise<TusModule> | null = null

/** tus-js-client; a failed fetch is forgotten, so the next upload tries again. */
export function loadTus(): Promise<TusModule> {
  tusModule ??= import('tus-js-client').catch((error: unknown) => {
    tusModule = null
    throw error
  })
  return tusModule
}

/** Start loading tus-js-client ahead of an upload (errors surface on the upload). */
export function preloadTus(): void {
  loadTus().catch(() => undefined)
}
