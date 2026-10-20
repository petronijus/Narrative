/**
 * SlidesPanel.test.tsx
 *
 * The slide sidebar against a real deck document: every gesture dispatches
 * a command (ADR 0010), so the tests assert on what the DOCUMENT looks like
 * afterwards — not on which function was called.
 *
 * - Renders one row per slide, 1-based numbers, the count, the empty state
 * - Click activates; + adds and activates a slide
 * - Delete lands on the nearest remaining slide above
 * - Duplicate puts the copy right after the original, as one undo step
 * - Copy + paste within the deck copies whole slides (slide.copyTo)
 * - Keyboard navigation clamps at the ends
 * - Dragging moves the slide (slide.move)
 */

import { beforeAll, describe, it, expect, vi } from 'vitest'
import { screen, fireEvent, act } from '@testing-library/react'
import { Route, Routes } from 'react-router-dom'
import * as Y from 'yjs'
import {
  addSlide,
  createUndoManager,
  hydrateSlideDoc,
  listSlides,
  setSlideName,
  type DeckMutationContext,
} from '@narrative/slide-model'
import { renderWithProviders } from '../test/renderWithProviders'
import { SlidesPanel } from './SlidesPanel'
import { createMockSlideDocValue } from '../state/slideDocContext'
import { ActiveSlideContext } from '../state/ActiveSlideContext'
import type { ActiveSlideContextValue } from '../state/ActiveSlideContext'
import { readSlideClipboard, setSlideClipboard } from '../state/slideClipboard'

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Thumbnails are a renderer concern.
vi.mock('../state/useSlideThumbnails', () => {
  const store = { setVisible: () => {} }
  return {
    useSlideThumbnails: () => new Map<string, string>(),
    useSlideThumbnailStore: () => store,
    useThumbnailUrl: () => undefined,
  }
})

// Owner, so the edit controls are shown.
vi.mock('../state/DeckRoleContext', () => ({
  useDeckRole: () => ({ role: 'owner', isLoading: false }),
}))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DECK_ID = 'deck-1'

/** A deck document holding slides with the given ids (none = an empty deck). */
function deckWith(ids: string[]): DeckMutationContext {
  const doc = new Y.Doc()
  const deck: DeckMutationContext = { doc, slides: doc.getArray<Y.Map<unknown>>('slides') }
  if (ids.length === 0) return deck
  hydrateSlideDoc(doc)
  for (let i = 1; i < ids.length; i++) addSlide(deck)
  ids.forEach((id, i) => deck.slides.get(i).set('id', id))
  return deck
}

const order = (deck: DeckMutationContext) => listSlides(deck).map((s) => s.id)

function renderPanel(
  deck: DeckMutationContext,
  activeSlideId: string | null = null,
): { setActiveSlideId: ReturnType<typeof vi.fn> } {
  const setActiveSlideId = vi.fn()
  const active: ActiveSlideContextValue = { activeSlideId, setActiveSlideId }
  renderWithProviders(
    <Routes>
      <Route
        path="/deck/:id"
        element={
          <ActiveSlideContext value={active}>
            <SlidesPanel />
          </ActiveSlideContext>
        }
      />
    </Routes>,
    {
      routerEntries: [`/deck/${DECK_ID}`],
      slideDocValue: createMockSlideDocValue({ deckCtx: deck }),
    },
  )
  return { setActiveSlideId }
}

function openSlideMenu(index: number): void {
  const menuButtons = screen.getAllByRole('button', { name: 'Slide options' })
  fireEvent.click(menuButtons[index] as HTMLElement)
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

describe('SlidesPanel — rendering', () => {
  it('shows the empty state for a deck without slides', () => {
    renderPanel(deckWith([]))
    expect(screen.getByText('No slides')).toBeInTheDocument()
  })

  it('renders one row per slide, numbered from 1, with the count in the header', () => {
    renderPanel(deckWith(['s1', 's2', 's3']))
    expect(document.querySelectorAll('[data-slide-id]')).toHaveLength(3)
    expect(screen.getByText('(3)')).toBeInTheDocument()
    expect(screen.getByText('1')).toBeInTheDocument()
    expect(screen.getByText('3')).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// Gestures → document
// ---------------------------------------------------------------------------

describe('SlidesPanel — click to activate', () => {
  it('activates the clicked slide', () => {
    const { setActiveSlideId } = renderPanel(deckWith(['s1', 's2']), 's1')
    const s2 = document.querySelector('[data-slide-id="s2"]') as HTMLElement
    fireEvent.click(s2.querySelector('[aria-hidden="true"]') as HTMLElement)
    expect(setActiveSlideId).toHaveBeenCalledWith('s2')
  })
})

describe('SlidesPanel — add slide', () => {
  it('adds a slide to the deck and activates it', () => {
    const deck = deckWith(['s1'])
    const { setActiveSlideId } = renderPanel(deck, 's1')
    fireEvent.click(screen.getByRole('button', { name: 'Add slide' }))
    const ids = order(deck)
    expect(ids).toHaveLength(2)
    expect(setActiveSlideId).toHaveBeenCalledWith(ids[1])
  })
})

describe('SlidesPanel — delete slide', () => {
  it('deletes the slide and lands on the nearest one above it', () => {
    const deck = deckWith(['s1', 's2', 's3'])
    const { setActiveSlideId } = renderPanel(deck, 's2')
    openSlideMenu(1)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }))
    expect(order(deck)).toEqual(['s1', 's3'])
    expect(setActiveSlideId).toHaveBeenCalledWith('s1')
  })
})

describe('SlidesPanel — duplicate slide', () => {
  it('puts the copy right after the original, as one undo step', () => {
    const deck = deckWith(['s1', 's2'])
    const undo = createUndoManager(deck)
    const { setActiveSlideId } = renderPanel(deck, 's1')
    openSlideMenu(0)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Duplicate' }))
    const ids = order(deck)
    expect(ids).toHaveLength(3)
    expect([ids[0], ids[2]]).toEqual(['s1', 's2'])
    expect(setActiveSlideId).toHaveBeenCalledWith(ids[1])
    expect(undo.undoStack).toHaveLength(1)
  })
})

describe('SlidesPanel — copy and paste within the deck', () => {
  it('pastes whole copies after the slide the paste was aimed at', () => {
    const deck = deckWith(['s1', 's2', 's3'])
    setSlideName(deck, 's1', 'Opening')
    renderPanel(deck, 's1')
    fireEvent.contextMenu(document.querySelector('[data-slide-id="s1"]') as HTMLElement)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy slide' }))
    expect(readSlideClipboard()).toEqual({ deckId: DECK_ID, slideIds: ['s1'] })

    fireEvent.contextMenu(document.querySelector('[data-slide-id="s2"]') as HTMLElement)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Paste slide' }))
    const slides = listSlides(deck)
    expect(slides.map((s) => s.id).slice(0, 2)).toEqual(['s1', 's2'])
    expect(slides[2]!.name).toBe('Opening')
    expect(slides[3]!.id).toBe('s3')
  })

  it('reports copied slides that were deleted since, and changes nothing', () => {
    const deck = deckWith(['s1', 's2'])
    setSlideClipboard(DECK_ID, ['gone'])
    renderPanel(deck, 's1')
    fireEvent.contextMenu(document.querySelector('[data-slide-id="s2"]') as HTMLElement)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Paste slide' }))
    expect(order(deck)).toEqual(['s1', 's2'])
    expect(screen.getByText(/deleted since they were copied/)).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// Keyboard navigation
// ---------------------------------------------------------------------------

describe('SlidesPanel — keyboard navigation', () => {
  it('ArrowDown on the last slide stays there', () => {
    const { setActiveSlideId } = renderPanel(deckWith(['s1', 's2']), 's2')
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'ArrowDown' })
    for (const [id] of setActiveSlideId.mock.calls) expect(id).toBe('s2')
  })

  it('ArrowUp on the first slide stays there', () => {
    const { setActiveSlideId } = renderPanel(deckWith(['s1', 's2']), 's1')
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'ArrowUp' })
    for (const [id] of setActiveSlideId.mock.calls) expect(id).toBe('s1')
  })
})

// ---------------------------------------------------------------------------
// Drag-to-reorder
// ---------------------------------------------------------------------------

describe('SlidesPanel — drag to reorder', () => {
  // jsdom implements neither PointerEvent (fireEvent would then send a bare
  // Event without coordinates) nor pointer capture, which the panel takes
  // on pointerdown.
  beforeAll(() => {
    if (typeof window.PointerEvent === 'undefined') {
      class PointerEventPolyfill extends MouseEvent {
        readonly pointerId: number
        constructor(type: string, init: PointerEventInit = {}) {
          super(type, init)
          this.pointerId = init.pointerId ?? 0
        }
      }
      window.PointerEvent = PointerEventPolyfill as unknown as typeof PointerEvent
    }
    HTMLElement.prototype.setPointerCapture ??= () => {}
  })

  it('moves the dragged slide two rows down', () => {
    const deck = deckWith(['s1', 's2', 's3'])
    renderPanel(deck, 's1')
    const card = document
      .querySelector('[data-slide-id="s1"]')
      ?.querySelector('[aria-hidden="true"]') as HTMLElement
    // jsdom has no layout: give the rows the panel's — 90 px thumbnails, an
    // 8 px gap — since the drop is read off the rows' positions. 200 px is
    // past s2 (98–188) and above the middle of s3 (196–286, middle 241): the
    // slide lands between them.
    for (const [i, id] of ['s1', 's2', 's3'].entries()) {
      const row = document.querySelector(`[data-slide-id="${id}"]`) as HTMLElement
      row.getBoundingClientRect = () => new DOMRect(0, i * 98, 200, 90)
    }
    act(() => {
      fireEvent.pointerDown(card, { button: 0, clientX: 0, clientY: 0, pointerId: 1 })
    })
    act(() => {
      fireEvent.pointerMove(card, { clientX: 0, clientY: 200, pointerId: 1 })
    })
    act(() => {
      fireEvent.pointerUp(card, { clientX: 0, clientY: 200, pointerId: 1 })
    })
    expect(order(deck)).toEqual(['s2', 's1', 's3'])
  })
})
