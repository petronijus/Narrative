/**
 * state/useFolderFonts.test.tsx
 *
 * FolderFontsProvider takes `folderId: string | null` because DeckShell's
 * FolderDocGate mounts it before the deck's folder is known — see
 * components/DeckShell.folderGate.test.tsx for why the gate must not swap
 * providers in and out instead.
 *
 * A null id has to be inert: no request, no spinner, an empty list. Once the
 * real id arrives on a re-render the provider fetches exactly as it always did.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { Mock } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import {
  FolderFontsProvider,
  useFolderFonts,
  invalidateFolderFontsCache,
} from './useFolderFonts.js'
import type { FolderFontSummary } from '../api/client.js'

let listFolderFontsMock: Mock<(folderId: string) => Promise<FolderFontSummary[]>>
// One stable object, as the real `useApi()` returns — a fresh literal per
// render would change every `useCallback([api, …])` identity downstream.
const apiStub = {
  listFolderFonts: (folderId: string) => listFolderFontsMock(folderId),
}
vi.mock('../api/client.js', async () => {
  const actual = await vi.importActual<typeof import('../api/client.js')>('../api/client.js')
  return {
    ...actual,
    useApi: () => apiStub,
  }
})

const sample = [
  {
    id: 'font-1',
    folderId: 'folder-a',
    family: 'Inter',
    weight: '400',
    style: 'normal',
    url: 'https://example.test/inter.woff2',
  },
] as unknown as FolderFontSummary[]

function Probe() {
  const { fonts, loading, folderId } = useFolderFonts()
  return (
    <div>
      <span data-testid="folder">{folderId ?? 'none'}</span>
      <span data-testid="loading">{loading ? 'yes' : 'no'}</span>
      <span data-testid="count">{String(fonts.length)}</span>
    </div>
  )
}

function tree(folderId: string | null): ReactNode {
  return (
    <FolderFontsProvider folderId={folderId}>
      <Probe />
    </FolderFontsProvider>
  )
}

beforeEach(() => {
  invalidateFolderFontsCache('folder-a')
  listFolderFontsMock = vi.fn<(folderId: string) => Promise<FolderFontSummary[]>>()
  listFolderFontsMock.mockResolvedValue(sample)
})

describe('FolderFontsProvider', () => {
  it('stays inert while the folder is unknown', async () => {
    render(tree(null))

    await waitFor(() => {
      expect(screen.getByTestId('loading')).toHaveTextContent('no')
    })
    expect(listFolderFontsMock).not.toHaveBeenCalled()
    expect(screen.getByTestId('folder')).toHaveTextContent('none')
    expect(screen.getByTestId('count')).toHaveTextContent('0')
  })

  it('fetches once the folder id arrives, without being remounted', async () => {
    const { rerender } = render(tree(null))
    expect(listFolderFontsMock).not.toHaveBeenCalled()

    rerender(tree('folder-a'))

    await waitFor(() => {
      expect(screen.getByTestId('count')).toHaveTextContent('1')
    })
    expect(listFolderFontsMock).toHaveBeenCalledWith('folder-a')
    expect(screen.getByTestId('folder')).toHaveTextContent('folder-a')
  })
})
