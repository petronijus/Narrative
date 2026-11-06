/**
 * state/FolderFontLoader.test.tsx
 *
 * The loader against the real providers and the real pending registry
 * (renderer/fontChanges.ts), with the network and the browser's font API
 * faked: what a text held for its face waits for, and when it wakes
 * (ADR 0018 → Fonts). The registries are per module, so every test imports
 * them afresh.
 */

import { act, render } from '@testing-library/react'
import { useState } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const api = {
  getDeck: vi.fn(),
  listFolderFonts: vi.fn(),
  listDeckFonts: vi.fn(),
}
vi.mock('../api/client.js', () => ({ useApi: () => api }))
vi.mock('./AuthContext.js', () => ({ useAuth: () => ({ user: { id: 'u1' } }) }))

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** Lets the mocked requests and the effects they cause finish. */
const settle = (): Promise<void> =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5))
  })

class FakeFace {
  async load(): Promise<this> {
    return this
  }
}

/** Measures every family alike: nothing is installed on this system. */
class FakeOffscreenCanvas {
  getContext() {
    return { font: '', measureText: () => ({ width: 100 }) }
  }
}

const FONT = { assetId: 'x', family: 'Brand', weight: 400, style: 'normal', url: 'https://m/x' }
const fontResponse = () =>
  ({
    ok: true,
    status: 200,
    arrayBuffer: async () => new Uint8Array([0, 1, 0, 0, 0]).buffer,
  }) as unknown as Response

const addedFaces: unknown[] = []
const downloads: ReturnType<typeof deferred<Response>>[] = []

let fontChanges: typeof import('../renderer/fontChanges.js')
let renderWork: typeof import('../renderer/renderWork.js')
let FolderFontLoader: typeof import('./FolderFontLoader.js').FolderFontLoader
let FolderFontsProvider: typeof import('./useFolderFonts.js').FolderFontsProvider
let DeckFontsProvider: typeof import('./useDeckFonts.js').DeckFontsProvider
let DeckRoleProvider: typeof import('./DeckRoleContext.js').DeckRoleProvider
let useDeckRole: typeof import('./DeckRoleContext.js').useDeckRole

beforeEach(async () => {
  vi.resetModules()
  addedFaces.length = 0
  downloads.length = 0
  api.getDeck.mockReset()
  api.listFolderFonts.mockReset()
  api.listDeckFonts.mockReset()
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  vi.stubGlobal('FontFace', FakeFace)
  vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas)
  Object.defineProperty(document, 'fonts', {
    configurable: true,
    value: { add: (face: unknown) => addedFaces.push(face), delete: () => true },
  })
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      const download = deferred<Response>()
      downloads.push(download)
      return download.promise
    }),
  )
  fontChanges = await import('../renderer/fontChanges.js')
  renderWork = await import('../renderer/renderWork.js')
  ;({ FolderFontLoader } = await import('./FolderFontLoader.js'))
  ;({ FolderFontsProvider } = await import('./useFolderFonts.js'))
  ;({ DeckFontsProvider } = await import('./useDeckFonts.js'))
  ;({ DeckRoleProvider, useDeckRole } = await import('./DeckRoleContext.js'))
})

/** Watches a text held for `Brand`: `released()` says whether it woke. */
function holdText(): () => boolean {
  let released = false
  void fontChanges.whenFamiliesSettled(['Brand'], 60_000).then(() => {
    released = true
  })
  return () => released
}

function DeckLoader({ folderId }: { folderId: string | null }) {
  return (
    <DeckFontsProvider deckId="d1">
      <FolderFontsProvider folderId={folderId}>
        <FolderFontLoader />
      </FolderFontsProvider>
    </DeckFontsProvider>
  )
}

/** As DeckShell's gate: the loader under the folder the deck fetch reports. */
function FolderFromDeck() {
  const { folderId } = useDeckRole()
  return <DeckLoader folderId={folderId} />
}

function DeckWithRoleFetch() {
  return (
    <MemoryRouter>
      <DeckRoleProvider deckId="d1">
        <FolderFromDeck />
      </DeckRoleProvider>
    </MemoryRouter>
  )
}

/** A deck's loader that a parent can re-render for reasons of its own. */
function RerenderableDeck({ expose }: { expose: (rerender: () => void) => void }) {
  const [, setCount] = useState(0)
  expose(() => setCount((count) => count + 1))
  return <DeckLoader folderId="f1" />
}

describe('FolderFontLoader: font lists on their way', () => {
  it('holds text while the deck fetch may still name a folder', async () => {
    api.getDeck.mockReturnValue(new Promise(() => undefined))
    api.listDeckFonts.mockResolvedValue([])
    render(<DeckWithRoleFetch />)
    await settle()
    expect(fontChanges.familiesOnTheWay(['Brand'])).toEqual(['Brand'])
  })

  it('releases text when the deck fetch fails: no list will come', async () => {
    const deck = deferred<unknown>()
    api.getDeck.mockReturnValue(deck.promise)
    api.listDeckFonts.mockResolvedValue([])
    render(<DeckWithRoleFetch />)
    await settle()
    const released = holdText()
    deck.reject(new Error('503'))
    await settle()
    expect(released()).toBe(true)
    expect(fontChanges.anyFaceOnTheWay()).toBe(false)
  })

  it('keeps holding through the commit that brings the folder id', async () => {
    const deck = deferred<unknown>()
    const list = deferred<unknown[]>()
    api.getDeck.mockReturnValue(deck.promise)
    api.listDeckFonts.mockResolvedValue([])
    api.listFolderFonts.mockReturnValue(list.promise)
    render(<DeckWithRoleFetch />)
    await settle()
    const released = holdText()
    deck.resolve({ viewerRole: 'owner', folderId: 'f1' })
    await settle()
    expect(released()).toBe(false)
    expect(fontChanges.familiesOnTheWay(['Brand'])).toEqual(['Brand'])
  })

  it('hands a text held for the list over to its face when the folder list comes last', async () => {
    const list = deferred<unknown[]>()
    api.listDeckFonts.mockResolvedValue([])
    api.listFolderFonts.mockReturnValue(list.promise)
    render(<DeckLoader folderId="f1" />)
    await settle()
    const released = holdText()
    list.resolve([FONT])
    await settle()
    expect(released()).toBe(false)

    downloads[0]!.resolve(fontResponse())
    await settle()
    expect(released()).toBe(true)
    expect(fontChanges.hasHtmlTextFaces('Brand')).toBe(true)
  })

  it('hands a text over when the deck list comes last', async () => {
    const deckList = deferred<unknown[]>()
    api.listDeckFonts.mockReturnValue(deckList.promise)
    api.listFolderFonts.mockResolvedValue([FONT])
    render(<DeckLoader folderId="f1" />)
    await settle()
    const released = holdText()
    deckList.resolve([])
    await settle()
    expect(released()).toBe(false)
  })

  it('releases a text in a family the lists do not name', async () => {
    api.listDeckFonts.mockResolvedValue([])
    api.listFolderFonts.mockResolvedValue([])
    render(<DeckLoader folderId="f1" />)
    await settle()
    expect(fontChanges.anyFaceOnTheWay()).toBe(false)
  })

  it('leaves nothing awaited after unmounting mid-load', async () => {
    api.listDeckFonts.mockResolvedValue([])
    api.listFolderFonts.mockResolvedValue([FONT])
    const view = render(<DeckLoader folderId="f1" />)
    await settle()
    view.unmount()
    downloads[0]!.resolve(fontResponse())
    await settle()
    expect(fontChanges.anyFaceOnTheWay()).toBe(false)
    expect(addedFaces).toHaveLength(0)
  })
})

describe('FolderFontLoader: downloads', () => {
  async function openDeck(): Promise<() => void> {
    api.listFolderFonts.mockResolvedValue([FONT])
    api.listDeckFonts.mockResolvedValue([])
    let rerender = (): void => undefined
    render(
      <RerenderableDeck
        expose={(next) => {
          rerender = next
        }}
      />,
    )
    await settle()
    return rerender
  }

  it('does not restart a download when a parent re-renders', async () => {
    const rerender = await openDeck()
    expect(downloads).toHaveLength(1)
    for (let i = 0; i < 3; i++) {
      act(() => rerender())
      await settle()
    }
    expect(downloads).toHaveLength(1)
  })

  it('lets a failed download go, reports the family and frees the slot', async () => {
    await openDeck()
    downloads[0]!.reject(new Error('403'))
    await settle()
    expect(fontChanges.familiesOnTheWay(['Brand'])).toEqual([])
    expect(renderWork.failedRenderFonts()).toEqual(['Brand'])
  })

  /** A list with new URLs cancels the load in flight and starts another. */
  async function openDeckAndReplaceLoad() {
    const refreshed = deferred<unknown[]>()
    api.listDeckFonts.mockResolvedValue([])
    api.listFolderFonts.mockResolvedValueOnce([FONT])
    api.listFolderFonts.mockReturnValueOnce(refreshed.promise)
    // A live load that fails asks for fresh URLs again.
    api.listFolderFonts.mockResolvedValue([{ ...FONT, url: 'https://m/x?retry' }])
    let refresh = (): Promise<void> => Promise.resolve()
    const { useFolderFonts } = await import('./useFolderFonts.js')
    function GrabRefresh() {
      refresh = useFolderFonts().refresh
      return null
    }
    render(
      <DeckFontsProvider deckId="d1">
        <FolderFontsProvider folderId="f1">
          <FolderFontLoader />
          <GrabRefresh />
        </FolderFontsProvider>
      </DeckFontsProvider>,
    )
    await settle()
    void refresh()
    refreshed.resolve([{ ...FONT, url: 'https://m/x?fresh' }])
    await settle()
    expect(downloads).toHaveLength(2)
    return { stale: downloads[0]!, live: downloads[1]! }
  }

  it('keeps text waiting for the live load when a cancelled one fails', async () => {
    const { stale } = await openDeckAndReplaceLoad()
    stale.reject(new Error('403'))
    await settle()
    expect(fontChanges.familiesOnTheWay(['Brand'])).toEqual(['Brand'])
    expect(renderWork.failedRenderFonts()).toEqual([])
  })

  it('leaves an installed face alone when a cancelled load fails later', async () => {
    const { stale, live } = await openDeckAndReplaceLoad()
    live.resolve(fontResponse())
    await settle()
    stale.reject(new Error('403'))
    await settle()
    expect(addedFaces).toHaveLength(1)
    expect(fontChanges.hasHtmlTextFaces('Brand')).toBe(true)
    expect(renderWork.failedRenderFonts()).toEqual([])
  })

  it('keeps the failure of the live load when a cancelled load succeeds later', async () => {
    const { stale, live } = await openDeckAndReplaceLoad()
    live.reject(new Error('403'))
    await settle()
    stale.resolve(fontResponse())
    await settle()
    expect(renderWork.failedRenderFonts()).toEqual(['Brand'])
    expect(addedFaces).toHaveLength(0)
  })

  it('holds no text for a face already registered when the loader remounts', async () => {
    api.listDeckFonts.mockResolvedValue([])
    api.listFolderFonts.mockResolvedValue([FONT])
    const first = render(<DeckLoader folderId="f1" />)
    await settle()
    downloads[0]!.resolve(fontResponse())
    await settle()
    first.unmount()

    render(<DeckLoader folderId="f1" />)
    await settle()
    expect(downloads).toHaveLength(2)
    expect(fontChanges.familiesOnTheWay(['Brand'])).toEqual([])
  })
})
