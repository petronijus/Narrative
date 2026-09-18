/**
 * components/DeckShell.folderGate.test.tsx
 *
 * Regression guard for the deck-open remount.
 *
 * `FolderDocGate` sits directly above SlideDocProvider, the Pixi canvas and
 * the slides panel. Its `folderId` is null for the first few hundred
 * milliseconds of every deck open and then flips to the real id when the
 * deck-role fetch lands. It used to return two *different* element trees
 * across that flip — `<TokensProvider>` while null, `<FolderFontsProvider>`
 * once known — so React unmounted and rebuilt the entire editor mid-load:
 * a second deck Y.Doc WebSocket, a duplicate deck fetch, and a slide sidebar
 * that populated, blanked and populated again.
 *
 * The invariant: children mount exactly once across the flip.
 *
 * The three folder-scoped providers are stubbed as pass-throughs — this test
 * is about the SHAPE of the tree the gate returns, and the real
 * FolderDocProvider would open a Hocuspocus WebSocket in jsdom.
 * `FolderFontsProvider`'s own null handling is covered in useFolderFonts.test.tsx.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, act } from '@testing-library/react'
import { useEffect, useState, type ReactNode } from 'react'

// --- Mocks (hoisted by vitest above the imports below) ---------------------

const roleState: { folderId: string | null } = { folderId: null }
const seenFolderIds: { fonts: Array<string | null>; doc: Array<string | null> } = {
  fonts: [],
  doc: [],
}

vi.mock('../state/DeckRoleContext.js', () => ({
  useDeckRole: () => ({ role: 'owner' as const, isLoading: false, folderId: roleState.folderId }),
  DeckRoleProvider: ({ children }: { children: ReactNode }) => children,
}))

vi.mock('../state/useFolderFonts.js', () => ({
  FolderFontsProvider: ({
    folderId,
    children,
  }: {
    folderId: string | null
    children: ReactNode
  }) => {
    seenFolderIds.fonts.push(folderId)
    return children
  },
}))

vi.mock('../state/FolderFontLoader.js', () => ({
  FolderFontLoader: () => null,
}))

vi.mock('../state/FolderDocProvider.js', () => ({
  FolderDocProvider: ({ folderId, children }: { folderId: string | null; children: ReactNode }) => {
    seenFolderIds.doc.push(folderId)
    return children
  },
  useFolderTokens: () => ({
    colors: {},
    textStyles: {},
    effectStyles: {},
    deletedComponentIds: new Set<string>(),
  }),
  useFolderTokensOptional: () => null,
}))

const { FolderDocGate } = await import('./DeckShell.js')

// --- Probe child -----------------------------------------------------------

let mountCount = 0

function MountCounter() {
  useEffect(() => {
    mountCount += 1
  }, [])
  return <div data-testid="editor-subtree" />
}

/** Re-renders the gate when `flip()` is called, so folderId can change. */
function Harness({ onReady }: { onReady: (flip: () => void) => void }) {
  const [, force] = useState(0)
  useEffect(() => {
    onReady(() => {
      force((n) => n + 1)
    })
  }, [onReady])
  return (
    <FolderDocGate>
      <MountCounter />
    </FolderDocGate>
  )
}

describe('FolderDocGate', () => {
  beforeEach(() => {
    mountCount = 0
    roleState.folderId = null
    seenFolderIds.fonts = []
    seenFolderIds.doc = []
  })

  it('keeps the editor subtree mounted when folderId arrives', () => {
    let flip = (): void => {}
    const { getByTestId } = render(
      <Harness
        onReady={(f) => {
          flip = f
        }}
      />,
    )

    const before = getByTestId('editor-subtree')
    expect(mountCount).toBe(1)

    // The deck-role fetch lands.
    act(() => {
      roleState.folderId = 'folder-123'
      flip()
    })

    // Same DOM node, still attached, mounted only once: no remount.
    const after = getByTestId('editor-subtree')
    expect(after).toBe(before)
    expect(before.isConnected).toBe(true)
    expect(mountCount).toBe(1)
  })

  it('passes the folderId straight through to both folder providers', () => {
    let flip = (): void => {}
    render(
      <Harness
        onReady={(f) => {
          flip = f
        }}
      />,
    )

    expect(seenFolderIds.fonts[0]).toBeNull()
    expect(seenFolderIds.doc[0]).toBeNull()

    act(() => {
      roleState.folderId = 'folder-123'
      flip()
    })

    expect(seenFolderIds.fonts.at(-1)).toBe('folder-123')
    expect(seenFolderIds.doc.at(-1)).toBe('folder-123')
  })
})
