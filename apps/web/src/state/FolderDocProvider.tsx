/**
 * state/FolderDocProvider.tsx
 *
 * M16 P2 — Provider that opens a Hocuspocus connection to `folder:<folderId>`
 * and exposes the live design-token Y.Doc to descendant components.
 *
 * Y.Doc schema:
 *   tokens: Y.Map
 *     ├─ colors:       Y.Map<id → Y.Map { id, name, value: hex }>
 *     ├─ textStyles:   Y.Map<id → Y.Map { id, name, family?, weight?, size?,
 *     │                                    lineHeight?, letterSpacing?, color? }>
 *     └─ effectStyles: Y.Map<id → Y.Map { id, name, kind, params: Y.Map }>
 *
 * Token ids are nanoid(10) strings generated client-side on creation.
 *
 * Mutation API (exported for editor-ui agent):
 *   addToken(category, init)              — creates a new token
 *   updateToken(category, id, patch)      — partial update
 *   deleteToken(category, id)             — removes by id
 *   listUsages(category, id)              — stub, returns [] (P4 polish)
 *
 * Hooks (exported for editor-ui agent):
 *   useFolderTokens()                     — live plain-JSON token snapshot
 *
 * Auth:
 *   JWT Bearer token is passed to HocuspocusProvider (same as SlideDocProvider).
 *   Share-token access is NOT supported for folder docs.
 */

import { createContext, useContext, useEffect, useRef, useState, useCallback } from 'react'
import * as Y from 'yjs'
import { HocuspocusProvider } from '@hocuspocus/provider'
import { nanoid } from 'nanoid'
import { useAuth } from './AuthContext.js'
import { FolderDocContext, emptyTokensSnapshot } from './FolderDocContext.js'
import type { FolderTokensSnapshot, FolderDocContextValue } from './FolderDocContext.js'
import type {
  ColorTokenSnapshot,
  TextStyleTokenSnapshot,
  EffectStyleTokenSnapshot,
} from '@narrative/slide-model'

const HOCUSPOCUS_URL = import.meta.env['VITE_HOCUSPOCUS_URL'] ?? 'ws://localhost:3002'

// ---------------------------------------------------------------------------
// Y.Doc helpers
// ---------------------------------------------------------------------------

/**
 * Returns (or lazily creates) the root `tokens` Y.Map on a folder Y.Doc.
 * Sub-maps `colors`, `textStyles`, `effectStyles` are created on demand.
 */
function getTokensMap(doc: Y.Doc): Y.Map<unknown> {
  return doc.getMap<unknown>('tokens')
}

function getCategoryMap(doc: Y.Doc, category: TokenCategory): Y.Map<Y.Map<unknown>> {
  const tokens = getTokensMap(doc)
  let cat = tokens.get(category) as Y.Map<Y.Map<unknown>> | undefined
  if (!cat) {
    cat = new Y.Map<Y.Map<unknown>>()
    doc.transact(() => {
      // Y.Map generics are invariant; cast through unknown to satisfy TypeScript.
      tokens.set(category, cat as unknown)
    })
  }
  return cat
}

// ---------------------------------------------------------------------------
// Snapshot builder
// ---------------------------------------------------------------------------

function yMapToRecord<T>(
  ymap: Y.Map<Y.Map<unknown>> | undefined,
  deserialize: (m: Y.Map<unknown>) => T | null,
): Record<string, T> {
  if (!ymap) return {}
  const result: Record<string, T> = {}
  ymap.forEach((entryMap, id) => {
    const value = deserialize(entryMap)
    if (value !== null) {
      result[id] = value
    }
  })
  return result
}

function deserializeColor(m: Y.Map<unknown>): ColorTokenSnapshot | null {
  const id = m.get('id')
  const name = m.get('name')
  const value = m.get('value')
  if (typeof id !== 'string' || typeof name !== 'string' || typeof value !== 'string') return null
  return { id, name, value }
}

function deserializeTextStyle(m: Y.Map<unknown>): TextStyleTokenSnapshot | null {
  const id = m.get('id')
  const name = m.get('name')
  if (typeof id !== 'string' || typeof name !== 'string') return null
  const out: TextStyleTokenSnapshot = { id, name }
  const family = m.get('family')
  const weight = m.get('weight')
  const size = m.get('size')
  const lineHeight = m.get('lineHeight')
  const letterSpacing = m.get('letterSpacing')
  const color = m.get('color')
  if (typeof family === 'string') out.family = family
  if (typeof weight === 'number') out.weight = weight
  if (typeof size === 'number') out.size = size
  if (typeof lineHeight === 'number') out.lineHeight = lineHeight
  if (typeof letterSpacing === 'number') out.letterSpacing = letterSpacing
  // color may be a hex string or a serialized TokenRef object
  if (typeof color === 'string') out.color = color
  else if (
    typeof color === 'object' &&
    color !== null &&
    '$token' in (color as object) &&
    typeof (color as Record<string, unknown>)['$token'] === 'string'
  ) {
    out.color = color as { $token: string }
  }
  return out
}

function deserializeEffectStyle(m: Y.Map<unknown>): EffectStyleTokenSnapshot | null {
  const id = m.get('id')
  const name = m.get('name')
  const kind = m.get('kind')
  if (typeof id !== 'string' || typeof name !== 'string' || (kind !== 'shadow' && kind !== 'blur'))
    return null
  const paramsMap = m.get('params') as Y.Map<unknown> | undefined
  const params: Record<string, unknown> = {}
  if (paramsMap) {
    paramsMap.forEach((v, k) => {
      params[k] = v
    })
  }
  return { id, name, kind, params }
}

function buildSnapshot(doc: Y.Doc): FolderTokensSnapshot {
  const tokensMap = getTokensMap(doc)
  const colorsMap = tokensMap.get('colors') as Y.Map<Y.Map<unknown>> | undefined
  const textStylesMap = tokensMap.get('textStyles') as Y.Map<Y.Map<unknown>> | undefined
  const effectStylesMap = tokensMap.get('effectStyles') as Y.Map<Y.Map<unknown>> | undefined

  return {
    colors: yMapToRecord(colorsMap, deserializeColor),
    textStyles: yMapToRecord(textStylesMap, deserializeTextStyle),
    effectStyles: yMapToRecord(effectStylesMap, deserializeEffectStyle),
  }
}

// ---------------------------------------------------------------------------
// Types for mutation API
// ---------------------------------------------------------------------------

export type TokenCategory = 'colors' | 'textStyles' | 'effectStyles'

export type ColorTokenInit = Omit<ColorTokenSnapshot, 'id'>
export type TextStyleTokenInit = Omit<TextStyleTokenSnapshot, 'id'>
export type EffectStyleTokenInit = Omit<EffectStyleTokenSnapshot, 'id'>

export type TokenInit = ColorTokenInit | TextStyleTokenInit | EffectStyleTokenInit

// ---------------------------------------------------------------------------
// Mutation context — internal React context for mutation functions
// ---------------------------------------------------------------------------

interface FolderMutationsContextValue {
  addToken(category: TokenCategory, init: TokenInit): string
  updateToken(category: TokenCategory, id: string, patch: Partial<TokenInit>): void
  deleteToken(category: TokenCategory, id: string): void
  listUsages(category: TokenCategory, id: string): string[]
}

const FolderMutationsContext = createContext<FolderMutationsContextValue | null>(null)

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

interface FolderDocProviderProps {
  folderId: string
  children: React.ReactNode
}

export function FolderDocProvider({ folderId, children }: FolderDocProviderProps) {
  const { token } = useAuth()
  const [value, setValue] = useState<FolderDocContextValue | null>(null)
  const providerRef = useRef<HocuspocusProvider | null>(null)
  const docRef = useRef<Y.Doc | null>(null)

  useEffect(() => {
    if (providerRef.current !== null) return

    const doc = new Y.Doc()
    docRef.current = doc

    let tokens = emptyTokensSnapshot()
    setValue({ doc, tokens })

    const provider = new HocuspocusProvider({
      url: HOCUSPOCUS_URL,
      name: `folder:${folderId}`,
      document: doc,
      ...(token !== null ? { token } : { token: null }),
      onSynced() {
        // After server sync, rebuild snapshot and subscribe to live updates.
        tokens = buildSnapshot(doc)
        setValue({ doc, tokens })
      },
    })

    providerRef.current = provider

    // Subscribe to all Y.Doc mutations so the snapshot stays live.
    const observer = () => {
      setValue((prev) => ({
        doc,
        tokens: buildSnapshot(doc),
        // preserve any other fields if the shape grows
        ...(prev !== null ? {} : {}),
      }))
    }

    // observeDeep on the root tokens Y.Map covers all nested changes.
    const tokensMap = getTokensMap(doc)
    tokensMap.observeDeep(observer)

    return () => {
      tokensMap.unobserveDeep(observer)
      provider.destroy()
      doc.destroy()
      providerRef.current = null
      docRef.current = null
      setValue(null)
    }
  }, [folderId, token])

  // ---------------------------------------------------------------------------
  // Mutation helpers
  // ---------------------------------------------------------------------------

  const addToken = useCallback((category: TokenCategory, init: TokenInit): string => {
    const doc = docRef.current
    if (!doc) throw new Error('FolderDocProvider: doc not ready')
    const id = nanoid(10)
    const catMap = getCategoryMap(doc, category)
    doc.transact(() => {
      const m = new Y.Map<unknown>()
      m.set('id', id)
      // Spread all init fields into the Y.Map
      const entries = Object.entries(init) as Array<[string, unknown]>
      for (const [k, v] of entries) {
        if (v !== undefined) {
          m.set(k, v)
        }
      }
      catMap.set(id, m)
    })
    return id
  }, [])

  const updateToken = useCallback(
    (category: TokenCategory, id: string, patch: Partial<TokenInit>): void => {
      const doc = docRef.current
      if (!doc) return
      const catMap = getCategoryMap(doc, category)
      const m = catMap.get(id)
      if (!m) return
      doc.transact(() => {
        const entries = Object.entries(patch) as Array<[string, unknown]>
        for (const [k, v] of entries) {
          if (v === undefined) {
            m.delete(k)
          } else {
            m.set(k, v)
          }
        }
      })
    },
    [],
  )

  const deleteToken = useCallback((category: TokenCategory, id: string): void => {
    const doc = docRef.current
    if (!doc) return
    const catMap = getCategoryMap(doc, category)
    if (!catMap.has(id)) return
    doc.transact(() => {
      catMap.delete(id)
    })
  }, [])

  /**
   * Lists slide objects that reference a given token.
   * Stub for P2 — returns [] until P4 usage indexing.
   */
  const listUsages = useCallback((_category: TokenCategory, _id: string): string[] => {
    return []
  }, [])

  const mutations: FolderMutationsContextValue = {
    addToken,
    updateToken,
    deleteToken,
    listUsages,
  }

  if (value === null) {
    // Render children even before sync so they mount (avoids layout flash).
    const emptyValue: FolderDocContextValue = {
      doc: new Y.Doc(), // placeholder; replaced on sync
      tokens: emptyTokensSnapshot(),
    }
    return (
      <FolderDocContext.Provider value={emptyValue}>
        <FolderMutationsContext.Provider value={mutations}>
          {children}
        </FolderMutationsContext.Provider>
      </FolderDocContext.Provider>
    )
  }

  return (
    <FolderDocContext.Provider value={value}>
      <FolderMutationsContext.Provider value={mutations}>
        {children}
      </FolderMutationsContext.Provider>
    </FolderDocContext.Provider>
  )
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

/**
 * Returns the live folder token snapshot.
 * Triggers a re-render whenever the folder Y.Doc changes.
 *
 * Must be used inside `<FolderDocProvider>`.
 */
export function useFolderTokens(): FolderTokensSnapshot {
  const ctx = useContext(FolderDocContext)
  if (!ctx) {
    throw new Error('useFolderTokens must be used inside <FolderDocProvider>')
  }
  return ctx.tokens
}

/**
 * Returns the folder mutation helpers.
 * Must be used inside `<FolderDocProvider>`.
 */
export function useFolderMutations(): FolderMutationsContextValue {
  const ctx = useContext(FolderMutationsContext)
  if (!ctx) {
    throw new Error('useFolderMutations must be used inside <FolderDocProvider>')
  }
  return ctx
}

// ---------------------------------------------------------------------------
// Convenience named re-exports for editor-ui agent
// ---------------------------------------------------------------------------

export type { FolderTokensSnapshot, FolderDocContextValue } from './FolderDocContext.js'
