/**
 * ui/useVisibleSlideRows.ts — which slide rows of the panel are on screen
 * (performance.md → B2, B3):
 *
 *   - the thumbnail store renders their thumbnails first and the rest of a
 *     long deck at idle (renderer/thumbnailStore.ts);
 *   - each row shows its picture only while it is near the view
 *     (`RowVisibility`): a row off screen mounts no `<img>` and does not
 *     re-render when its picture lands. The idle pass still draws every
 *     picture, so a row scrolled into view finds its own ready — a 300-slide
 *     deck keeps the pictures of a screenful of rows decoded, not 300.
 *
 * One IntersectionObserver over the rows (`[data-slide-id]` children of the
 * list), rooted at the panel's scroll container with a margin of about two
 * rows each way, so a short scroll finds its thumbnails drawn and mounted.
 * Rows come and go with the deck (`rowsKey`). The rows on screen are measured
 * before the first paint, so a row in view never shows its placeholder for a
 * frame while the observer's first report is on its way. Without
 * IntersectionObserver (jsdom) every row counts as visible.
 */

import { useLayoutEffect, useState, type RefObject } from 'react'
import type { ThumbnailStore } from '../renderer/thumbnailStore.js'

const MARGIN_PX = 240
const MARGIN = `${MARGIN_PX}px 0px`

/**
 * The slide rows near the view, with a subscription per row: a row hears
 * only about its own changes (a scroll that brings ten rows in renders those
 * ten). None before the first measurement — which comes before the first
 * paint, so the rows on screen re-render once and the rest not at all —
 * and every row where nothing can measure (`set(null)`).
 */
export class RowVisibility {
  private visible: ReadonlySet<string> | null = new Set()
  private readonly listeners = new Map<string, Set<() => void>>()

  /** Whether the row of `slideId` is near the view. */
  has(slideId: string): boolean {
    return this.visible === null || this.visible.has(slideId)
  }

  /** Be told when the row of `slideId` comes near the view or leaves it. */
  subscribe(slideId: string, listener: () => void): () => void {
    let set = this.listeners.get(slideId)
    if (set === undefined) {
      set = new Set()
      this.listeners.set(slideId, set)
    }
    set.add(listener)
    return () => {
      const current = this.listeners.get(slideId)
      if (current === undefined) return
      current.delete(listener)
      if (current.size === 0) this.listeners.delete(slideId)
    }
  }

  /** The rows near the view now (null: unknown — every row visible). Tells the rows that changed. */
  set(next: ReadonlySet<string> | null): void {
    const prev = this.visible
    this.visible = next === null ? null : new Set(next)
    for (const [slideId, set] of [...this.listeners]) {
      const was = prev === null || prev.has(slideId)
      const is = next === null || next.has(slideId)
      if (was === is) continue
      for (const listener of [...set]) listener()
    }
  }
}

export function useVisibleSlideRows(
  listRef: RefObject<HTMLElement | null>,
  store: ThumbnailStore,
  /** Changes whenever the set of rows does (the deck's slide ids, joined). */
  rowsKey: string,
): RowVisibility {
  const [visibility] = useState(() => new RowVisibility())
  useLayoutEffect(() => {
    const list = listRef.current
    if (list === null || typeof IntersectionObserver === 'undefined') {
      store.setVisible(null)
      // No list (no slides yet: the panel shows its empty state) has no row
      // near the view — the rows that arrive with the slides are measured
      // when they mount. Only where nothing can measure is every row visible.
      visibility.set(list === null ? new Set() : null)
      return
    }
    const root = scrollParent(list)
    const rows = list.querySelectorAll<HTMLElement>('[data-slide-id]')
    // The observer reports a frame later; the first renders must not wait for
    // it (or run in list order before it): the rows on screen now, measured once.
    const visible = rowsInView(rows, root)
    store.setVisible(visible)
    visibility.set(visible)
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const id = (entry.target as HTMLElement).dataset['slideId']
          if (id === undefined) continue
          if (entry.isIntersecting) visible.add(id)
          else visible.delete(id)
        }
        store.setVisible(visible)
        visibility.set(visible)
      },
      { root, rootMargin: MARGIN },
    )
    for (const row of rows) observer.observe(row)
    return () => {
      observer.disconnect()
    }
  }, [listRef, store, rowsKey, visibility])
  return visibility
}

/** The list itself or its nearest ancestor that scrolls vertically (null: the viewport). */
function scrollParent(el: HTMLElement): HTMLElement | null {
  for (let node: HTMLElement | null = el; node !== null; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowY
    if (overflow === 'auto' || overflow === 'scroll') return node
  }
  return null
}

/** The ids of the rows within `root` (the viewport for null), MARGIN_PX each way. */
function rowsInView(rows: Iterable<HTMLElement>, root: HTMLElement | null): Set<string> {
  const top = (root?.getBoundingClientRect().top ?? 0) - MARGIN_PX
  const bottom = (root?.getBoundingClientRect().bottom ?? window.innerHeight) + MARGIN_PX
  const out = new Set<string>()
  for (const row of rows) {
    const id = row.dataset['slideId']
    if (id === undefined) continue
    const r = row.getBoundingClientRect()
    if (r.bottom >= top && r.top <= bottom) out.add(id)
  }
  return out
}
