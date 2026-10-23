/**
 * state/useSlideNotes.test.tsx — the notes follow the document whenever its
 * changes land: between the hook's render and its subscription (the sync of
 * a deck painted from its local copy, ADR 0017), on a slide map replaced
 * under the same id, and on a slide that arrives after the hook mounted —
 * and a slide change costs no render more than it needs (present mode).
 */

import { describe, expect, it } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import * as Y from 'yjs'
import { addSlide, moveSlide, setSlideNotes } from '@narrative/slide-model'
import type { SlideMutationContext } from '@narrative/slide-model'
import { SlideDocContext, createMockSlideDocValue } from './slideDocContext.js'
import { ActiveSlideContext } from './ActiveSlideContext.js'
import { useSlideNotes } from './useSlideNotes.js'

function deckOf(doc: Y.Doc): SlideMutationContext {
  return { doc, slides: doc.getArray('slides') as SlideMutationContext['slides'] }
}

const notes = (text: string) => [{ type: 'paragraph', content: [{ text }] }]

/** A slide from before M19 phase 2: no notes fragment until notes are written. */
function addSlideWithoutNotes(doc: Y.Doc): string {
  const { id } = addSlide(deckOf(doc))
  const slides = deckOf(doc).slides
  slides.get(slides.length - 1).delete('notes')
  return id
}

/** What the server sends `local` that it lacks: the sync landing. */
function sync(server: Y.Doc, local: Y.Doc): void {
  Y.applyUpdate(local, Y.encodeStateAsUpdate(server, Y.encodeStateVector(local)))
}

function NotesReadout({ onFragment }: { onFragment?: { run: (() => void) | null } }) {
  const { fragment, hasSlide, text } = useSlideNotes()
  // Once, in the first render that has a fragment: before the commit that
  // subscribes to it.
  if (fragment !== null && onFragment !== undefined) {
    const run = onFragment.run
    onFragment.run = null
    run?.()
  }
  return (
    <div>
      <div data-testid="has-slide">{hasSlide ? 'yes' : 'no'}</div>
      <div data-testid="text">{text}</div>
    </div>
  )
}

/**
 * Runs `change` once, while rendering — after the readout before it has read
 * the document and before any effect subscribed.
 */
function ChangeDuringRender({ change }: { change: { run: (() => void) | null } }) {
  const run = change.run
  change.run = null
  run?.()
  return null
}

function renderNotes(
  local: Y.Doc,
  slideId: string,
  change: { run: (() => void) | null },
  onFragment?: { run: (() => void) | null },
) {
  render(
    <SlideDocContext value={createMockSlideDocValue({ deckCtx: deckOf(local) })}>
      <ActiveSlideContext value={{ activeSlideId: slideId, setActiveSlideId: () => undefined }}>
        <NotesReadout {...(onFragment !== undefined ? { onFragment } : {})} />
        <ChangeDuringRender change={change} />
      </ActiveSlideContext>
    </SlideDocContext>,
  )
}

describe('useSlideNotes', () => {
  it('shows notes the sync wrote between its render and its subscription', () => {
    const server = new Y.Doc()
    const { id } = addSlide(deckOf(server))
    // The local copy: the slide and its (empty) notes fragment.
    const local = new Y.Doc()
    sync(server, local)
    setSlideNotes(deckOf(server), id, notes('Hello notes'))

    renderNotes(local, id, { run: () => sync(server, local) })

    expect(screen.getByTestId('text').textContent).toBe('Hello notes')
  })

  it('shows a fragment the sync installed between its render and its subscription', () => {
    const server = new Y.Doc()
    const id = addSlideWithoutNotes(server)
    // The local copy: a slide without a notes fragment yet.
    const local = new Y.Doc()
    sync(server, local)
    setSlideNotes(deckOf(server), id, notes('Hello notes'))

    renderNotes(local, id, { run: () => sync(server, local) })

    expect(screen.getByTestId('text').textContent).toBe('Hello notes')
  })

  it('shows notes written after it found a new fragment and before it subscribed to it', () => {
    const server = new Y.Doc()
    const id = addSlideWithoutNotes(server)
    // The local copy: a slide without a notes fragment yet.
    const local = new Y.Doc()
    sync(server, local)
    // The fragment arrives first, empty; its text in a later update.
    setSlideNotes(deckOf(server), id, [])
    const withFragment = Y.encodeStateAsUpdate(server, Y.encodeStateVector(local))
    setSlideNotes(deckOf(server), id, notes('Hello notes'))

    renderNotes(
      local,
      id,
      { run: () => Y.applyUpdate(local, withFragment) },
      { run: () => sync(server, local) },
    )

    expect(screen.getByTestId('text').textContent).toBe('Hello notes')
  })

  it('shows a slide that arrives after it mounted', () => {
    const server = new Y.Doc()
    const { id } = addSlide(deckOf(server))
    setSlideNotes(deckOf(server), id, notes('Hello notes'))
    const local = new Y.Doc()

    renderNotes(local, id, { run: null })
    expect(screen.getByTestId('has-slide').textContent).toBe('no')

    act(() => sync(server, local))
    expect(screen.getByTestId('has-slide').textContent).toBe('yes')
    expect(screen.getByTestId('text').textContent).toBe('Hello notes')
  })

  it('follows the slide when its map is replaced under the same id', () => {
    const doc = new Y.Doc()
    const { id } = addSlide(deckOf(doc))
    addSlide(deckOf(doc))
    setSlideNotes(deckOf(doc), id, notes('Before'))

    renderNotes(doc, id, { run: null })
    expect(screen.getByTestId('text').textContent).toBe('Before')

    // A reorder clones the slide's map, notes fragment included.
    act(() => moveSlide(deckOf(doc), id, 1))
    act(() => {
      setSlideNotes(deckOf(doc), id, notes('After'))
    })
    expect(screen.getByTestId('text').textContent).toBe('After')
  })

  it('renders twice on a slide change, never a third time for the same text', () => {
    // The change itself, then the effect's new fragment and text. The re-read
    // after subscribing finds the text just set: a setState with it would
    // render once more and commit nothing (one empty commit per advance in
    // present mode, performance.md → F3).
    const doc = new Y.Doc()
    const a = addSlide(deckOf(doc)).id
    const b = addSlide(deckOf(doc)).id
    setSlideNotes(deckOf(doc), a, notes('First'))
    setSlideNotes(deckOf(doc), b, notes('Second'))
    const counter = { renders: 0 }
    function CountedNotes() {
      counter.renders++
      return <div data-testid="text">{useSlideNotes().text}</div>
    }
    const tree = (slideId: string) => (
      <SlideDocContext value={createMockSlideDocValue({ deckCtx: deckOf(doc) })}>
        <ActiveSlideContext value={{ activeSlideId: slideId, setActiveSlideId: () => undefined }}>
          <CountedNotes />
        </ActiveSlideContext>
      </SlideDocContext>
    )
    const view = render(tree(a))
    expect(screen.getByTestId('text').textContent).toBe('First')

    const before = counter.renders
    act(() => view.rerender(tree(b)))
    expect(screen.getByTestId('text').textContent).toBe('Second')
    expect(counter.renders - before).toBe(2)
  })
})
