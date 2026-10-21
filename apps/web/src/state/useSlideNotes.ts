/**
 * state/useSlideNotes.ts
 *
 * M19 phase 2: resolves the active slide's Y.XmlFragment for speaker notes.
 * The fragment is co-edited across peers via y-prosemirror bound to a Tiptap
 * editor inside SlideNotesPanel.
 *
 * Also exposes a plain-text snapshot (read-only) for non-editor surfaces
 * (e.g. presenter view's "next slide notes preview" in phase 3).
 */

import { useEffect, useState } from 'react'
import * as Y from 'yjs'
import { getSlideNotesFragment } from '@narrative/slide-model'
import { useSlideDoc } from './useSlideDoc.js'
import { useActiveSlide } from './ActiveSlideContext.js'

export interface UseSlideNotesResult {
  /**
   * Y.XmlFragment handle for Tiptap binding. Null when no slide is active,
   * or when the active slide has no notes fragment yet (a slide from before
   * M19 phase 2: `slide.notes.set` installs one; looking never does).
   */
  fragment: Y.XmlFragment | null
  /** The active slide exists in the deck (so a null fragment means "no notes yet"). */
  hasSlide: boolean
  /** Plain-text snapshot (re-renders on any fragment change). */
  text: string
}

function serialiseFragment(frag: Y.XmlFragment | null): string {
  if (frag === null) return ''
  // XmlFragment.toString() serialises to XML-ish source; not ideal for a
  // plain preview. Walk children and concatenate text nodes instead.
  const parts: string[] = []
  const walk = (node: Y.XmlElement | Y.XmlText | Y.XmlHook | Y.XmlFragment): void => {
    if (node instanceof Y.XmlText) {
      parts.push(node.toString())
      return
    }
    if (node instanceof Y.XmlElement || node instanceof Y.XmlFragment) {
      for (const child of node.toArray() as Array<
        Y.XmlElement | Y.XmlText | Y.XmlHook | Y.XmlFragment
      >) {
        walk(child)
      }
      // Insert a newline after block-ish elements to make the preview readable.
      if (node instanceof Y.XmlElement && isBlockLike(node.nodeName)) parts.push('\n')
    }
  }
  walk(frag)
  return parts
    .join('')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function isBlockLike(name: string): boolean {
  return (
    name === 'paragraph' ||
    name === 'heading' ||
    name === 'blockquote' ||
    name === 'bulletList' ||
    name === 'orderedList' ||
    name === 'listItem'
  )
}

export function useSlideNotes(): UseSlideNotesResult {
  const { deckCtx } = useSlideDoc()
  const { activeSlideId } = useActiveSlide()

  const [fragment, setFragment] = useState<Y.XmlFragment | null>(() =>
    activeSlideId === null ? null : getSlideNotesFragment(deckCtx, activeSlideId),
  )
  const [hasSlide, setHasSlide] = useState(() => findSlide(deckCtx, activeSlideId) !== undefined)
  const [text, setText] = useState<string>(() => serialiseFragment(fragment))

  useEffect(() => {
    // The slide's Y.Map is not fixed for an id: a reorder (moveSlide clones
    // it), a collaborator's replacement or a sync landing on a deck painted
    // from its local copy (ADR 0017) puts a new map — with a new fragment —
    // under the same id, and the slide may not be there yet at all. So the
    // slide list is watched too, and the map is looked up again on each of
    // its changes; the one found is watched for its fragment, which it
    // gains when someone writes its first notes (slide.notes.set, here or
    // in a collaborator's editor).
    let slide: Y.Map<unknown> | undefined
    const onSlideChange = (event: Y.YMapEvent<unknown>): void => {
      if (event.keysChanged.has('notes')) resolve()
    }
    const resolve = (): void => {
      const nextSlide = findSlide(deckCtx, activeSlideId)
      if (nextSlide !== slide) {
        slide?.unobserve(onSlideChange)
        slide = nextSlide
        slide?.observe(onSlideChange)
      }
      const notes = slide?.get('notes')
      const next = notes instanceof Y.XmlFragment ? notes : null
      setHasSlide(slide !== undefined)
      setFragment(next)
      setText(serialiseFragment(next))
    }
    const onSlidesChange = (): void => resolve()
    deckCtx.slides.observe(onSlidesChange)
    // Subscribed first, read second: nothing that lands between the
    // render's read and this effect goes unseen.
    resolve()
    return () => {
      deckCtx.slides.unobserve(onSlidesChange)
      slide?.unobserve(onSlideChange)
    }
  }, [deckCtx, activeSlideId])

  useEffect(() => {
    if (fragment === null) return
    const onChange = () => {
      setText(serialiseFragment(fragment))
    }
    fragment.observeDeep(onChange)
    // The text was read when the fragment was resolved, a commit earlier; an
    // update applied in between (the server's sync landing on a document a
    // local copy painted, ADR 0017) fired no observer. Read it again now that
    // one is subscribed.
    onChange()
    return () => {
      fragment.unobserveDeep(onChange)
    }
  }, [fragment])

  return { fragment, hasSlide, text }
}

function findSlide(
  deckCtx: ReturnType<typeof useSlideDoc>['deckCtx'],
  slideId: string | null,
): Y.Map<unknown> | undefined {
  if (slideId === null) return undefined
  for (let i = 0; i < deckCtx.slides.length; i++) {
    const m = deckCtx.slides.get(i)
    if (m.get('id') === slideId) return m
  }
  return undefined
}
