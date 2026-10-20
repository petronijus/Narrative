/**
 * ui/editorReady.ts — "the editor has drawn the deck": when the code its
 * first paint left out may load (docs/plans/performance.md → L1 / L2).
 *
 * The notes editor (Tiptap), the dialogs and the overlays are chunks of their
 * own; fetched and evaluated while the deck is still syncing and its canvas
 * and thumbnails are drawn, they compete with that work (the first A/B put
 * the slide thumbnails — the editor's LCP — 0.4 s later). The editor pages
 * mark the moment their canvas painted the first frame (its `onReady`); the
 * loaders wait for it, then `EDITOR_SETTLE_MS` for the thumbnails, then an
 * idle moment (`whenEditorSettled`). Measured on 2026-10-18 (Lighthouse,
 * desktop preset): started right after the canvas paint they took the LCP
 * from 1.61 to 1.99 s; with none at all it was 1.67 s.
 */

import { preloadWhenIdle } from './lazyPart.js'

/** How long after the canvas' first frame the editor's deferred code waits (the thumbnails' time). */
export const EDITOR_SETTLE_MS = 3000

let ready = false
const waiters = new Set<() => void>()

/** The editor's canvas drew its first frame (once per page; later decks find it set). */
export function markEditorCanvasReady(): void {
  if (ready) return
  ready = true
  for (const run of [...waiters]) run()
  waiters.clear()
}

/** Run `fn` once the editor's canvas is ready (now if it is); returns the cancel. */
export function afterEditorCanvasReady(fn: () => void): () => void {
  if (ready) {
    fn()
    return () => undefined
  }
  waiters.add(fn)
  return () => {
    waiters.delete(fn)
  }
}

/**
 * Preload `parts` once the editor drew its deck, `EDITOR_SETTLE_MS` passed
 * and the browser is idle; returns the cancel.
 */
export function whenEditorSettled(parts: readonly { preload(): Promise<void> }[]): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null
  let cancelIdle: (() => void) | null = null
  const cancelReady = afterEditorCanvasReady(() => {
    timer = setTimeout(() => {
      timer = null
      cancelIdle = preloadWhenIdle(parts)
    }, EDITOR_SETTLE_MS)
  })
  return () => {
    cancelReady()
    if (timer !== null) clearTimeout(timer)
    cancelIdle?.()
  }
}
