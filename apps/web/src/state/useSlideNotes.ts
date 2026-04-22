/**
 * state/useSlideNotes.ts
 *
 * M19 phase 1: speaker notes hook.
 *
 * Resolves the active slide's notes Y.Text and exposes:
 *   - text: current plain-text snapshot (re-renders on any Yjs change)
 *   - yText: the Y.Text itself (so callers can run ytext.delete / insert
 *     inside doc.transact for collab-friendly edits)
 *   - setText(next): replaces the entire Y.Text content in one transaction
 *
 * Plain-text only for this phase — Tiptap rich text binding is phase 2.
 */

import { useEffect, useState } from 'react'
import type * as Y from 'yjs'
import { getSlideNotes, LOCAL_ORIGIN } from '@narrative/slide-model'
import { useSlideDoc } from './useSlideDoc.js'
import { useActiveSlide } from './ActiveSlideContext.js'

export interface UseSlideNotesResult {
  /** Plain-text snapshot of the active slide's notes. */
  text: string
  /** Y.Text handle, or null when no slide is active. */
  yText: Y.Text | null
  /** Replace the entire notes content. */
  setText(next: string): void
}

export function useSlideNotes(): UseSlideNotesResult {
  const { deckCtx } = useSlideDoc()
  const { activeSlideId } = useActiveSlide()

  const [yText, setYText] = useState<Y.Text | null>(() =>
    activeSlideId === null ? null : getSlideNotes(deckCtx, activeSlideId),
  )
  const [text, setTextSnapshot] = useState<string>(() => yText?.toString() ?? '')

  // Resolve the correct Y.Text whenever the active slide changes.
  useEffect(() => {
    const next = activeSlideId === null ? null : getSlideNotes(deckCtx, activeSlideId)
    setYText(next)
    setTextSnapshot(next?.toString() ?? '')
  }, [deckCtx, activeSlideId])

  // Subscribe to the current Y.Text and mirror its content into React state.
  useEffect(() => {
    if (yText === null) return
    const onChange = () => {
      setTextSnapshot(yText.toString())
    }
    yText.observe(onChange)
    return () => {
      yText.unobserve(onChange)
    }
  }, [yText])

  function setText(next: string): void {
    if (yText === null) return
    deckCtx.doc.transact(() => {
      yText.delete(0, yText.length)
      if (next.length > 0) yText.insert(0, next)
    }, LOCAL_ORIGIN)
  }

  return { text, yText, setText }
}
