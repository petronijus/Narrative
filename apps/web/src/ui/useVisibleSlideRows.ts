/**
 * ui/useVisibleSlideRows.ts — tell the thumbnail store which slide rows of
 * the panel are on screen, so their thumbnails are rendered first and the
 * rest of a long deck at idle (renderer/thumbnailStore.ts, performance.md →
 * B2).
 *
 * One IntersectionObserver over the rows (`[data-slide-id]` children of the
 * list), rooted at the panel's scroll container with a margin of about two
 * rows each way, so a short scroll finds its thumbnails drawn. Rows come and go with the deck (`rowsKey`); without
 * IntersectionObserver (jsdom) every row counts as visible.
 */

import { useEffect, type RefObject } from 'react'
import type { ThumbnailStore } from '../renderer/thumbnailStore.js'

const MARGIN_PX = 240
const MARGIN = `${MARGIN_PX}px 0px`

export function useVisibleSlideRows(
  listRef: RefObject<HTMLElement | null>,
  store: ThumbnailStore,
  /** Changes whenever the set of rows does (the deck's slide ids, joined). */
  rowsKey: string,
): void {
  useEffect(() => {
    const list = listRef.current
    if (list === null || typeof IntersectionObserver === 'undefined') {
      store.setVisible(null)
      return
    }
    const root = scrollParent(list)
    const rows = list.querySelectorAll<HTMLElement>('[data-slide-id]')
    // The observer reports a frame later; the first renders must not wait for
    // it (or run in list order before it): the rows on screen now, measured once.
    const visible = rowsInView(rows, root)
    store.setVisible(visible)
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const id = (entry.target as HTMLElement).dataset['slideId']
          if (id === undefined) continue
          if (entry.isIntersecting) visible.add(id)
          else visible.delete(id)
        }
        store.setVisible(visible)
      },
      { root, rootMargin: MARGIN },
    )
    for (const row of rows) observer.observe(row)
    return () => {
      observer.disconnect()
    }
  }, [listRef, store, rowsKey])
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
