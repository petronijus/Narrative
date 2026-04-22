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
import { getSlideNotes } from '@narrative/slide-model'
import { useSlideDoc } from './useSlideDoc.js'
import { useActiveSlide } from './ActiveSlideContext.js'

export interface UseSlideNotesResult {
  /** Y.XmlFragment handle for Tiptap binding. Null when no slide is active. */
  fragment: Y.XmlFragment | null
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
    activeSlideId === null ? null : getSlideNotes(deckCtx, activeSlideId),
  )
  const [text, setText] = useState<string>(() => serialiseFragment(fragment))

  useEffect(() => {
    const next = activeSlideId === null ? null : getSlideNotes(deckCtx, activeSlideId)
    setFragment(next)
    setText(serialiseFragment(next))
  }, [deckCtx, activeSlideId])

  useEffect(() => {
    if (fragment === null) return
    const onChange = () => {
      setText(serialiseFragment(fragment))
    }
    fragment.observeDeep(onChange)
    return () => {
      fragment.unobserveDeep(onChange)
    }
  }, [fragment])

  return { fragment, text }
}
