/**
 * state/FolderDocProvider.test.tsx — the folder token provider against a
 * stand-in for the sync server's client (HocuspocusProvider is replaced by
 * a fake that syncs when the test says so, so no WebSocket is opened).
 *
 *   - opening a folder writes NOTHING to its document (A2.12: seeding and
 *     migration happen on the server; the provider used to write both
 *     whenever a folder was viewed);
 *   - the tokens follow the document, and a change the page asked for shows
 *     over them until the document has it;
 *   - what commands get: nothing before the first sync, null for a folder
 *     without tokens.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import * as Y from 'yjs'
import { addFolderToken, updateFolderToken } from '@narrative/slide-model'

/** The fake provider instances, newest last. */
const providers: Array<{ document: Y.Doc; name: string; sync: () => void }> = []

vi.mock('@hocuspocus/provider', () => ({
  HocuspocusProvider: class {
    constructor(opts: { name: string; document: Y.Doc; onSynced?: () => void }) {
      providers.push({
        document: opts.document,
        name: opts.name,
        sync: () => opts.onSynced?.(),
      })
    }
    destroy() {}
  },
}))

const updateToken = vi.fn()
// One client for the page's lifetime, as the real useApi() gives.
const api = {
  createToken: vi.fn(),
  updateToken,
  deleteToken: vi.fn(),
  listTokenUsages: vi.fn(),
}
vi.mock('../api/client.js', () => ({ useApi: () => api }))

const { FolderDocProvider, useFolderTokens, useFolderTokensForCommands, useFolderTokenWriter } =
  await import('./FolderDocProvider.js')

function Probe() {
  const tokens = useFolderTokens()
  const forCommands = useFolderTokensForCommands()
  const writer = useFolderTokenWriter()
  return (
    <div>
      <span data-testid="brand">{tokens.colors['brand']?.value ?? '-'}</span>
      <span data-testid="commands">
        {forCommands === undefined ? 'unknown' : forCommands === null ? 'none' : 'tokens'}
      </span>
      <button
        type="button"
        onClick={() => void writer?.update('colors', 'brand', { value: '#00ff00' })}
      >
        green
      </button>
    </div>
  )
}

/** The document the provider opened, with `init` as the server's content, synced. */
function openFolder(init?: (doc: Y.Doc) => void) {
  render(
    <FolderDocProvider folderId="folder_1">
      <Probe />
    </FolderDocProvider>,
  )
  const provider = providers[providers.length - 1]!
  expect(provider.name).toBe('folder:folder_1')
  const writes: unknown[] = []
  const server = new Y.Doc()
  init?.(server)
  act(() => {
    Y.applyUpdate(provider.document, Y.encodeStateAsUpdate(server), 'remote')
  })
  provider.document.on('update', (_u: Uint8Array, origin: unknown) => writes.push(origin))
  act(() => provider.sync())
  return { doc: provider.document, writes }
}

afterEach(() => {
  cleanup()
  providers.length = 0
  updateToken.mockReset()
})

describe('FolderDocProvider', () => {
  it('writes nothing to a folder without tokens when it is opened', () => {
    const { writes } = openFolder()
    expect(writes).toEqual([])
    expect(screen.getByTestId('commands').textContent).toBe('none')
  })

  it('writes nothing to a folder seeded by an older build', () => {
    const { writes } = openFolder((doc) => {
      // The legacy name, without the `builtin` flag: the server migrates it.
      addFolderToken(doc, 'textStyles', 'fn', { name: 'Footnote', size: 12 })
    })
    expect(writes).toEqual([])
  })

  it('gives commands nothing before the first sync', () => {
    render(
      <FolderDocProvider folderId="folder_1">
        <Probe />
      </FolderDocProvider>,
    )
    expect(screen.getByTestId('commands').textContent).toBe('unknown')
  })

  it("follows the document's tokens", () => {
    const { doc } = openFolder((d) => {
      addFolderToken(d, 'colors', 'brand', { name: 'Brand', value: '#2040c0' })
    })
    expect(screen.getByTestId('brand').textContent).toBe('#2040c0')
    expect(screen.getByTestId('commands').textContent).toBe('tokens')
    act(() => {
      updateFolderToken(doc, 'colors', 'brand', { value: '#123456' })
    })
    expect(screen.getByTestId('brand').textContent).toBe('#123456')
  })

  it('shows a change the page asked for until the document has it', async () => {
    let finish: () => void = () => undefined
    updateToken.mockImplementation(
      () => new Promise((resolve) => (finish = () => resolve({ decks: 0 }))),
    )
    const { doc, writes } = openFolder((d) => {
      addFolderToken(d, 'colors', 'brand', { name: 'Brand', value: '#2040c0' })
    })
    act(() => screen.getByText('green').click())
    expect(screen.getByTestId('brand').textContent).toBe('#00ff00')
    expect(updateToken).toHaveBeenCalledWith('folder_1', 'colors', 'brand', { value: '#00ff00' })

    // The server's write arrives as a remote update; the page wrote nothing itself.
    const server = new Y.Doc()
    Y.applyUpdate(server, Y.encodeStateAsUpdate(doc))
    const before = Y.encodeStateVector(server)
    updateFolderToken(server, 'colors', 'brand', { value: '#00ff00' })
    await act(async () => {
      finish()
      Y.applyUpdate(doc, Y.encodeStateAsUpdate(server, before), 'remote')
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(screen.getByTestId('brand').textContent).toBe('#00ff00')
    expect(writes).toEqual(['remote'])
  })
})
