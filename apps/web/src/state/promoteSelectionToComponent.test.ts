/**
 * state/promoteSelectionToComponent.test.ts — the editor's promote runs on
 * the server (`component.promote`) and only once the server holds the
 * slide's latest changes: a rename or a page-number flag made a moment
 * before must be in the master the server builds.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { addObjects, createSlideDoc, getSlideObjectsCtx } from '@narrative/slide-model'
import type { RectangleObject } from '@narrative/shared'
import type { ApiClient, PromotedComponent } from '../api/client.js'

const invalidateFolderComponentsCache = vi.fn()
vi.mock('./useFolderComponents.js', () => ({
  invalidateFolderComponentsCache: (id: string) => invalidateFolderComponentsCache(id),
}))
const renderSlide = vi.fn().mockResolvedValue('data:image/png;base64,AAAA')
vi.mock('../renderer/thumbnails.js', () => ({
  createThumbnailRenderer: vi.fn(async () => ({ renderSlide, destroy: vi.fn() })),
}))

const { promoteSelectionToComponent } = await import('./promoteSelectionToComponent.js')

const rect: RectangleObject = {
  id: 'r1',
  type: 'rectangle',
  x: 10,
  y: 20,
  width: 100,
  height: 50,
  rotation: 0,
  opacity: 1,
  fill: 0x336699,
}

const PROMOTED: PromotedComponent = {
  component: {
    id: 'cmp1',
    folderId: 'f1',
    name: 'Card',
    createdAt: '2026-09-30T00:00:00.000Z',
    updatedAt: '2026-09-30T00:00:00.000Z',
  },
  objectCount: 1,
  mediaCopied: 0,
  skippedImages: 0,
  droppedLinks: 0,
}

function setup() {
  const deck = createSlideDoc()
  const slideId = deck.slides.get(0).get('id') as string
  addObjects(getSlideObjectsCtx(deck, slideId)!, [rect])
  const promoteComponent = vi.fn().mockResolvedValue(PROMOTED)
  const uploadComponentThumbnail = vi.fn().mockResolvedValue(PROMOTED.component)
  const api = { promoteComponent, uploadComponentThumbnail } as unknown as ApiClient
  return { deck, slideId, api, promoteComponent, uploadComponentThumbnail }
}

describe('promoteSelectionToComponent', () => {
  beforeEach(() => {
    invalidateFolderComponentsCache.mockClear()
    renderSlide.mockClear()
  })

  it('asks the server only after it holds the latest changes', async () => {
    const { deck, slideId, api, promoteComponent } = setup()
    let saved!: () => void
    const whenSaved = vi.fn(() => new Promise<void>((resolve) => (saved = resolve)))

    const run = promoteSelectionToComponent({
      api,
      deckId: 'deck1',
      folderId: 'f1',
      deckCtx: deck,
      whenSaved,
      activeSlideId: slideId,
      targetIds: ['r1'],
      name: 'Card',
    })
    await Promise.resolve()
    expect(whenSaved).toHaveBeenCalledOnce()
    expect(promoteComponent).not.toHaveBeenCalled()

    saved()
    await expect(run).resolves.toEqual({ componentId: 'cmp1' })
    expect(promoteComponent).toHaveBeenCalledWith('deck1', {
      slideId,
      objectIds: ['r1'],
      name: 'Card',
    })
    expect(invalidateFolderComponentsCache).toHaveBeenCalledWith('f1')
  })

  it('renders the first thumbnail from the promoted objects and uploads it', async () => {
    const { deck, slideId, api, uploadComponentThumbnail } = setup()
    await promoteSelectionToComponent({
      api,
      deckId: 'deck1',
      folderId: 'f1',
      deckCtx: deck,
      whenSaved: async () => {},
      activeSlideId: slideId,
      targetIds: ['r1'],
      name: 'Card',
    })
    await vi.waitFor(() =>
      expect(uploadComponentThumbnail).toHaveBeenCalledWith('cmp1', 'data:image/png;base64,AAAA'),
    )
    const [objects] = renderSlide.mock.calls[0]! as [Array<{ id: string }>]
    expect(objects.map((o) => o.id)).toEqual(['r1'])
  })

  it('promotes nothing when the latest changes cannot be saved', async () => {
    const { deck, slideId, api, promoteComponent } = setup()
    await expect(
      promoteSelectionToComponent({
        api,
        deckId: 'deck1',
        folderId: 'f1',
        deckCtx: deck,
        whenSaved: () => Promise.reject(new Error('offline')),
        activeSlideId: slideId,
        targetIds: ['r1'],
        name: 'Card',
      }),
    ).rejects.toThrow('offline')
    expect(promoteComponent).not.toHaveBeenCalled()
  })
})
