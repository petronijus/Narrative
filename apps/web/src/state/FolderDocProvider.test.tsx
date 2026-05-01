/**
 * state/FolderDocProvider.test.tsx
 *
 * M16 P2 — Tests for useFolderTokens() hook.
 *
 * Strategy:
 *   - Mount a minimal FolderDocProvider variant that wraps FolderDocContext directly
 *     (bypasses HocuspocusProvider, which would open a real WebSocket).
 *   - Inject a real Y.Doc with a controlled tokens Y.Map.
 *   - Assert useFolderTokens() returns the correct snapshot.
 *   - Mutate the Y.Doc and assert the hook re-renders with updated values.
 *
 * We test the context + snapshot builder in isolation — Hocuspocus connectivity
 * is intentionally not covered (that requires a running server or a more complex mock).
 */

import { describe, it, expect } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import React from 'react'
import * as Y from 'yjs'
import { FolderDocContext, emptyTokensSnapshot } from './FolderDocContext.js'
import { useFolderTokens } from './FolderDocProvider.js'
import type { FolderDocContextValue } from './FolderDocContext.js'
import { useState, useEffect } from 'react'

// ---------------------------------------------------------------------------
// Test provider — wraps FolderDocContext with a real Y.Doc
// ---------------------------------------------------------------------------

/**
 * A test-only provider that subscribes to a Y.Doc's tokens map and feeds
 * updates into FolderDocContext — mirrors the core logic of FolderDocProvider
 * without the HocuspocusProvider dependency.
 */
function TestFolderDocProvider({ doc, children }: { doc: Y.Doc; children: React.ReactNode }) {
  const [tokens, setTokens] = useState(emptyTokensSnapshot)

  useEffect(() => {
    const tokensMap = doc.getMap<unknown>('tokens')

    function buildSnapshot() {
      const colorsMap = tokensMap.get('colors') as Y.Map<Y.Map<unknown>> | undefined
      const textStylesMap = tokensMap.get('textStyles') as Y.Map<Y.Map<unknown>> | undefined
      const effectStylesMap = tokensMap.get('effectStyles') as Y.Map<Y.Map<unknown>> | undefined

      const colors: Record<string, { id: string; name: string; value: string }> = {}
      if (colorsMap) {
        colorsMap.forEach((m, id) => {
          const v = m.get('value')
          const n = m.get('name')
          if (typeof v === 'string' && typeof n === 'string') {
            colors[id] = { id, name: n, value: v }
          }
        })
      }

      const textStyles: Record<string, { id: string; name: string }> = {}
      if (textStylesMap) {
        textStylesMap.forEach((m, id) => {
          const n = m.get('name')
          if (typeof n === 'string') textStyles[id] = { id, name: n }
        })
      }

      const effectStyles: Record<
        string,
        { id: string; name: string; kind: 'shadow' | 'blur'; params: Record<string, unknown> }
      > = {}
      if (effectStylesMap) {
        effectStylesMap.forEach((m, id) => {
          const n = m.get('name')
          const k = m.get('kind')
          if (typeof n === 'string' && (k === 'shadow' || k === 'blur')) {
            effectStyles[id] = { id, name: n, kind: k, params: {} }
          }
        })
      }

      return { colors, textStyles, effectStyles }
    }

    const handler = () => {
      setTokens(buildSnapshot())
    }

    tokensMap.observeDeep(handler)
    // Initial snapshot
    setTokens(buildSnapshot())

    return () => {
      tokensMap.unobserveDeep(handler)
    }
  }, [doc])

  const value: FolderDocContextValue = { doc, tokens }

  return <FolderDocContext.Provider value={value}>{children}</FolderDocContext.Provider>
}

// ---------------------------------------------------------------------------
// Test component that renders token data
// ---------------------------------------------------------------------------

function TokenDisplay() {
  const tokens = useFolderTokens()
  const colorIds = Object.keys(tokens.colors).sort().join(',')
  const textStyleIds = Object.keys(tokens.textStyles).sort().join(',')
  return (
    <div>
      <span data-testid="color-ids">{colorIds}</span>
      <span data-testid="textstyle-ids">{textStyleIds}</span>
      {Object.values(tokens.colors).map((c) => (
        <span key={c.id} data-testid={`color-value-${c.id}`}>
          {c.value}
        </span>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Helpers: set up Y.Doc with tokens
// ---------------------------------------------------------------------------

function addColorToken(doc: Y.Doc, id: string, name: string, value: string) {
  const tokensMap = doc.getMap<unknown>('tokens')
  doc.transact(() => {
    let colorsMap = tokensMap.get('colors') as Y.Map<Y.Map<unknown>> | undefined
    if (!colorsMap) {
      colorsMap = new Y.Map()
      tokensMap.set('colors', colorsMap as unknown)
    }
    const m = new Y.Map<unknown>()
    m.set('id', id)
    m.set('name', name)
    m.set('value', value)
    colorsMap.set(id, m)
  })
}

function addTextStyleToken(doc: Y.Doc, id: string, name: string) {
  const tokensMap = doc.getMap<unknown>('tokens')
  doc.transact(() => {
    let textStylesMap = tokensMap.get('textStyles') as Y.Map<Y.Map<unknown>> | undefined
    if (!textStylesMap) {
      textStylesMap = new Y.Map()
      tokensMap.set('textStyles', textStylesMap as unknown)
    }
    const m = new Y.Map<unknown>()
    m.set('id', id)
    m.set('name', name)
    textStylesMap.set(id, m)
  })
}

function deleteColorToken(doc: Y.Doc, id: string) {
  const tokensMap = doc.getMap<unknown>('tokens')
  doc.transact(() => {
    const colorsMap = tokensMap.get('colors') as Y.Map<Y.Map<unknown>> | undefined
    if (colorsMap) colorsMap.delete(id)
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useFolderTokens', () => {
  it('returns empty snapshot when doc has no tokens', () => {
    const doc = new Y.Doc()

    render(
      <TestFolderDocProvider doc={doc}>
        <TokenDisplay />
      </TestFolderDocProvider>,
    )

    expect(screen.getByTestId('color-ids').textContent).toBe('')
    expect(screen.getByTestId('textstyle-ids').textContent).toBe('')
  })

  it('returns colors when tokens Y.Map has color entries', () => {
    const doc = new Y.Doc()
    addColorToken(doc, 'red', 'Red', '#ff0000')
    addColorToken(doc, 'blue', 'Blue', '#0000ff')

    render(
      <TestFolderDocProvider doc={doc}>
        <TokenDisplay />
      </TestFolderDocProvider>,
    )

    const colorIds = screen.getByTestId('color-ids').textContent
    expect(colorIds).toContain('blue')
    expect(colorIds).toContain('red')
    expect(screen.getByTestId('color-value-red').textContent).toBe('#ff0000')
    expect(screen.getByTestId('color-value-blue').textContent).toBe('#0000ff')
  })

  it('re-renders when a color token is added after initial mount', () => {
    const doc = new Y.Doc()

    render(
      <TestFolderDocProvider doc={doc}>
        <TokenDisplay />
      </TestFolderDocProvider>,
    )

    // Initially empty
    expect(screen.getByTestId('color-ids').textContent).toBe('')

    // Add token
    act(() => {
      addColorToken(doc, 'green', 'Green', '#00ff00')
    })

    expect(screen.getByTestId('color-ids').textContent).toContain('green')
    expect(screen.getByTestId('color-value-green').textContent).toBe('#00ff00')
  })

  it('re-renders when a color token is deleted', () => {
    const doc = new Y.Doc()
    addColorToken(doc, 'toDelete', 'To Delete', '#aaaaaa')

    render(
      <TestFolderDocProvider doc={doc}>
        <TokenDisplay />
      </TestFolderDocProvider>,
    )

    expect(screen.getByTestId('color-ids').textContent).toContain('toDelete')

    act(() => {
      deleteColorToken(doc, 'toDelete')
    })

    expect(screen.getByTestId('color-ids').textContent).toBe('')
  })

  it('re-renders when a textStyle token is added', () => {
    const doc = new Y.Doc()

    render(
      <TestFolderDocProvider doc={doc}>
        <TokenDisplay />
      </TestFolderDocProvider>,
    )

    act(() => {
      addTextStyleToken(doc, 'heading', 'Heading')
    })

    expect(screen.getByTestId('textstyle-ids').textContent).toContain('heading')
  })

  it('throws when useFolderTokens is used outside FolderDocProvider', () => {
    // Suppress React error boundary output
    const consoleError = console.error
    console.error = () => {}

    function BadComponent() {
      useFolderTokens()
      return null
    }

    expect(() => render(<BadComponent />)).toThrow(
      'useFolderTokens must be used inside <FolderDocProvider>',
    )

    console.error = consoleError
  })
})
