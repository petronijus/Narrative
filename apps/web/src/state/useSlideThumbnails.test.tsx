/**
 * state/useSlideThumbnails.test.tsx
 *
 * The hook's wiring of the thumbnail store (renderer/thumbnailStore.ts, which
 * has its own tests for what is rendered when): the deck's slides on a real
 * Y.Doc go in, edits after the debounce, a reorder costs no render, the
 * slide on the editor's canvas is drawn from it, and the renderer and the
 * URLs go with the hook.
 *
 * The renderer, the live capture and the deck-level observer are mocked (no
 * WebGL in jsdom; the observer's rAF batching replaced by `deckEvents.emit`).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, act } from '@testing-library/react'
import React, { useState } from 'react'
import { SlideDocContext, createMockSlideDocValue } from './slideDocContext.js'
import type * as SlideModel from '@narrative/slide-model'
import { addObject, addSlide, createSlideDoc, getSlideObjectsCtx } from '@narrative/slide-model'
import type { SlideObject } from '@narrative/shared'

const { mockCaptureLive, mockRenderSlide, mockRendererDestroy, deckEvents } = vi.hoisted(() => ({
  mockCaptureLive: vi.fn(),
  mockRenderSlide: vi.fn(),
  mockRendererDestroy: vi.fn(),
  /** The hook's deck-level listener: call it to report edited slides. */
  deckEvents: { emit: null as ((ids: Set<string>) => void) | null },
}))

vi.mock('../renderer/thumbnails.js', () => ({
  createThumbnailRenderer: vi
    .fn()
    .mockResolvedValue({ renderSlide: mockRenderSlide, destroy: mockRendererDestroy }),
}))

vi.mock('../renderer/liveThumbnail.js', () => ({
  captureLiveThumbnail: mockCaptureLive,
}))

vi.mock('@narrative/slide-model', async (importOriginal) => {
  const actual = await importOriginal<typeof SlideModel>()
  return {
    ...actual,
    subscribeToDeckSlideEvents: vi
      .fn()
      .mockImplementation((_ctx: unknown, callback: (ids: Set<string>) => void) => {
        deckEvents.emit = callback
        return () => {
          if (deckEvents.emit === callback) deckEvents.emit = null
        }
      }),
  }
})

import { useSlideThumbnails, type UseSlideThumbnailsOptions } from './useSlideThumbnails.js'
import { ActiveSlideContext } from './ActiveSlideContext.js'
import { CanvasInstanceContext } from '../renderer/CanvasInstanceContext.js'
import type { CanvasInstance } from '../renderer/CanvasInstanceContext.js'

function makeRect(id: string): SlideObject {
  return {
    id,
    type: 'rectangle',
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    fill: 0,
    rotation: 0,
    opacity: 1,
  }
}

type SetterRef = { setSlides?: (ids: string[]) => void }

function ThumbnailWrapper({
  initialSlideIds,
  setterRef,
  options,
}: {
  initialSlideIds: string[]
  setterRef: SetterRef
  options?: UseSlideThumbnailsOptions | undefined
}) {
  const [slideIds, setSlideIds] = useState(initialSlideIds)
  setterRef.setSlides = setSlideIds
  const thumbnails = useSlideThumbnails(slideIds, options)
  return (
    <div data-testid="output" data-thumbnails={JSON.stringify(Object.fromEntries(thumbnails))} />
  )
}

let urlCount = 0
const revoked: string[] = []

beforeEach(() => {
  vi.useFakeTimers()
  mockRenderSlide.mockReset()
  mockRenderSlide.mockImplementation(() =>
    Promise.resolve(new Blob(['png'], { type: 'image/png' })),
  )
  mockRendererDestroy.mockReset()
  mockCaptureLive.mockReset()
  mockCaptureLive.mockResolvedValue(new Blob(['live'], { type: 'image/png' }))
  urlCount = 0
  revoked.length = 0
  // jsdom has no object URLs.
  vi.stubGlobal(
    'URL',
    Object.assign(URL, {
      createObjectURL: () => `blob:test-${++urlCount}`,
      revokeObjectURL: (url: string) => revoked.push(url),
    }),
  )
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

/** A deck of `count` slides, the hook tracking all of them. */
function renderDeck(count: number, options?: UseSlideThumbnailsOptions) {
  const { doc, slides } = createSlideDoc()
  const deckCtx = { doc, slides }
  while (slides.length < count) addSlide(deckCtx)
  const ids = Array.from({ length: count }, (_, i) => slides.get(i).get('id') as string)
  // Each slide its own content (empty slides would share one picture).
  ids.forEach((id, i) => addObject(getSlideObjectsCtx(deckCtx, id)!, makeRect(`seed-${i}`)))
  const setterRef: SetterRef = {}
  const canvas = { sceneGraph: { id: 'scene' }, compositor: {} } as unknown as CanvasInstance

  const tree = (
    <SlideDocContext value={createMockSlideDocValue({ deckCtx })}>
      <ThumbnailWrapper initialSlideIds={ids} setterRef={setterRef} options={options} />
    </SlideDocContext>
  )
  const { unmount } = render(
    options?.liveActiveSlide === true ? (
      <ActiveSlideContext value={{ activeSlideId: ids[0]!, setActiveSlideId: () => {} }}>
        <CanvasInstanceContext value={canvas}>{tree}</CanvasInstanceContext>
      </ActiveSlideContext>
    ) : (
      tree
    ),
  )
  const thumbnails = (): Record<string, string> =>
    JSON.parse(
      document.querySelector('[data-testid="output"]')?.getAttribute('data-thumbnails') ?? '{}',
    ) as Record<string, string>
  /** Put an object on a slide, as an edit would, and report the slide changed. */
  const edit = (slideId: string, objectId: string) => {
    addObject(getSlideObjectsCtx(deckCtx, slideId)!, makeRect(objectId))
    act(() => deckEvents.emit?.(new Set([slideId])))
  }
  return { deckCtx, ids, edit, thumbnails, setterRef, unmount }
}

const advance = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })

/** The ids of the objects each renderSlide call drew, in call order. */
const drawn = () =>
  mockRenderSlide.mock.calls.map((call) => (call[0] as { id: string }[]).map((o) => o.id))

describe('useSlideThumbnails', () => {
  it('renders every slide of the deck once it opens', async () => {
    const { ids, thumbnails } = renderDeck(3)
    await advance(1_000)
    expect(mockRenderSlide).toHaveBeenCalledTimes(3)
    expect(Object.keys(thumbnails()).sort()).toEqual([...ids].sort())
    expect(Object.values(thumbnails()).every((u) => u.startsWith('blob:'))).toBe(true)
  })

  it('renders an edited slide with its latest objects once the debounce ends', async () => {
    const { ids, edit } = renderDeck(2)
    await advance(1_000)
    mockRenderSlide.mockClear()

    edit(ids[1]!, 'a')
    edit(ids[1]!, 'b')
    await advance(499)
    expect(mockRenderSlide).not.toHaveBeenCalled()
    await advance(1)
    expect(drawn()).toEqual([['seed-1', 'a', 'b']])
  })

  it('re-reads every slide on a deck change, and renders none whose picture is the same', async () => {
    const { ids } = renderDeck(4)
    await advance(1_000)
    mockRenderSlide.mockClear()

    // What a slide moved or added reports: every slide affected.
    act(() => deckEvents.emit?.(new Set(ids)))
    await advance(1_000)
    expect(mockRenderSlide).not.toHaveBeenCalled()
  })

  it('renders a slide added after the deck opened, and forgets one removed', async () => {
    const { deckCtx, ids, setterRef, thumbnails } = renderDeck(2)
    await advance(1_000)
    mockRenderSlide.mockClear()

    addSlide(deckCtx)
    const added = deckCtx.slides.get(2).get('id') as string
    addObject(getSlideObjectsCtx(deckCtx, added)!, makeRect('new'))
    act(() => setterRef.setSlides?.([ids[0]!, added]))
    await advance(0)
    expect(drawn()).toEqual([['new']])
    expect(Object.keys(thumbnails()).sort()).toEqual([ids[0]!, added].sort())
  })

  it('draws the active slide from the canvas and every other slide in the renderer', async () => {
    const { ids, thumbnails } = renderDeck(2, { liveActiveSlide: true })
    await advance(1_000)
    expect(mockCaptureLive).toHaveBeenCalledTimes(1)
    expect(mockCaptureLive).toHaveBeenCalledWith({ id: 'scene' }, ['seed-0'], 200)
    expect(mockRenderSlide).toHaveBeenCalledTimes(1)
    expect(Object.keys(thumbnails()).sort()).toEqual([...ids].sort())
  })

  it('never reads the canvas unless asked to (the presenter and the component editor)', async () => {
    renderDeck(1)
    await advance(1_000)
    expect(mockCaptureLive).not.toHaveBeenCalled()
  })

  it('destroys its renderer and revokes its URLs on unmount', async () => {
    const { unmount } = renderDeck(2)
    await advance(1_000)
    unmount()
    expect(mockRendererDestroy).toHaveBeenCalledTimes(1)
    expect(revoked.sort()).toEqual(['blob:test-1', 'blob:test-2'])
  })
})
