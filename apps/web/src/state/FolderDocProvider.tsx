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

import { createContext, useContext, useEffect, useRef, useState, useCallback, useMemo } from 'react'
import * as Y from 'yjs'
import { HocuspocusProvider } from '@hocuspocus/provider'
import { nanoid } from 'nanoid'
import { useApi } from '../api/client.js'
import type { TokenUsage } from '../api/client.js'
import { FolderDocContext, emptyTokensSnapshot } from './FolderDocContext.js'
import type { FolderTokensSnapshot, FolderDocContextValue } from './FolderDocContext.js'
import type {
  ColorTokenSnapshot,
  TextStyleTokenSnapshot,
  EffectStyleTokenSnapshot,
} from '@narrative/slide-model'
import { DEFAULT_COLORS, DEFAULT_TEXT_STYLES } from './defaultTokens.js'

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

/**
 * Returns the `deletedComponentIds` Y.Array on the folder Y.Doc.
 * The array is created on demand (its mere existence is harmless on docs
 * that pre-date M16 P8 because Yjs allocates the root map slot lazily).
 *
 * Each element is a componentId string. Duplicates are possible when two
 * peers delete the same master concurrently — consumers deduplicate via Set.
 */
function getDeletedComponentIdsArray(doc: Y.Doc): Y.Array<string> {
  return doc.getArray<string>('deletedComponentIds')
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

/**
 * Seed a fresh folder doc with the default design-system palette + text
 * styles. Idempotent — only fires when both `colors` and `textStyles`
 * sub-maps are completely empty, so a user who deletes everything is not
 * fighting the seeder.
 */
function seedDefaultsIfEmpty(doc: Y.Doc): void {
  const colorsMap = getCategoryMap(doc, 'colors')
  const textStylesMap = getCategoryMap(doc, 'textStyles')
  if (colorsMap.size > 0 || textStylesMap.size > 0) return

  doc.transact(() => {
    const idByKey: Record<string, string> = {}
    for (const c of DEFAULT_COLORS) {
      const id = nanoid(10)
      idByKey[c.key] = id
      const m = new Y.Map<unknown>()
      m.set('id', id)
      m.set('name', c.name)
      m.set('value', c.value)
      colorsMap.set(id, m)
    }

    for (const ts of DEFAULT_TEXT_STYLES) {
      const id = nanoid(10)
      const colorId = idByKey[ts.colorKey]
      const m = new Y.Map<unknown>()
      m.set('id', id)
      m.set('name', ts.name)
      m.set('family', ts.family)
      m.set('weight', ts.weight)
      m.set('size', ts.size)
      m.set('lineHeight', ts.lineHeight)
      m.set('letterSpacing', ts.letterSpacing)
      // Mark seeded styles as builtin so the UI prevents deletion. The
      // editor relies on at least "Body" surviving for default text
      // styling on new objects.
      m.set('builtin', true)
      if (colorId !== undefined) {
        m.set('color', { $token: `colors.${colorId}` })
      }
      textStylesMap.set(id, m)
    }
  })
}

/**
 * Rename the seeded "Footnote" text style to "Footnotes and pages" on
 * existing folder docs that were seeded before the rename. Only touches
 * builtin entries (or unflagged entries whose name still matches the
 * old label) so user-created styles named "Footnote" are left alone.
 * Idempotent.
 */
function renameLegacyFootnoteStyle(doc: Y.Doc): void {
  const textStylesMap = getCategoryMap(doc, 'textStyles')
  if (textStylesMap.size === 0) return
  doc.transact(() => {
    textStylesMap.forEach((m) => {
      const name = m.get('name')
      if (typeof name !== 'string') return
      if (name.toLowerCase() !== 'footnote') return
      // Builtin or legacy unflagged seed → safe to rename.
      const builtin = m.get('builtin')
      if (builtin === true || builtin === undefined) {
        m.set('name', 'Footnotes and pages')
        m.set('builtin', true)
      }
    })
  })
}

/**
 * Migrate older folder docs that were seeded before `builtin` existed.
 * Any text style whose name matches a {@link DEFAULT_TEXT_STYLES} entry
 * and has no explicit `builtin` flag is upgraded to `builtin: true` —
 * matches the intent of the original seed without needing a server-side
 * migration. Idempotent.
 */
function backfillBuiltinTextStyles(doc: Y.Doc): void {
  const textStylesMap = getCategoryMap(doc, 'textStyles')
  if (textStylesMap.size === 0) return
  const builtinNames = new Set(DEFAULT_TEXT_STYLES.map((s) => s.name.toLowerCase()))
  doc.transact(() => {
    textStylesMap.forEach((m) => {
      if (m.has('builtin')) return
      const name = m.get('name')
      if (typeof name === 'string' && builtinNames.has(name.toLowerCase())) {
        m.set('builtin', true)
      }
    })
  })
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
  const builtin = m.get('builtin')
  if (builtin === true) out.builtin = true
  const textTransform = m.get('textTransform')
  if (
    textTransform === 'uppercase' ||
    textTransform === 'lowercase' ||
    textTransform === 'capitalize' ||
    textTransform === 'none'
  ) {
    out.textTransform = textTransform
  }
  const paragraphSpaceBefore = m.get('paragraphSpaceBefore')
  if (typeof paragraphSpaceBefore === 'number') out.paragraphSpaceBefore = paragraphSpaceBefore
  const paragraphSpaceAfter = m.get('paragraphSpaceAfter')
  if (typeof paragraphSpaceAfter === 'number') out.paragraphSpaceAfter = paragraphSpaceAfter
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

  const deletedArr = getDeletedComponentIdsArray(doc)
  const deletedComponentIds = new Set<string>()
  deletedArr.forEach((id) => deletedComponentIds.add(id))

  return {
    colors: yMapToRecord(colorsMap, deserializeColor),
    textStyles: yMapToRecord(textStylesMap, deserializeTextStyle),
    effectStyles: yMapToRecord(effectStylesMap, deserializeEffectStyle),
    deletedComponentIds,
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
  /**
   * Records `componentId` in the folder's CRDT-replicated `deletedComponentIds`
   * array. Call this immediately after `api.deleteComponent` succeeds so every
   * peer with the folder doc open learns about the deletion and can sweep
   * matching component instances from their open deck.
   *
   * Idempotency note: duplicate entries are allowed; consumers deduplicate via
   * a Set when reading. This avoids a read-before-write that would otherwise
   * require a transaction scan.
   */
  markComponentDeleted(componentId: string): void
}

const FolderMutationsContext = createContext<FolderMutationsContextValue | null>(null)

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

interface FolderDocProviderProps {
  /**
   * The folder whose token doc to open, or null while it is still
   * unknown. With a null id the provider stays mounted and serves the
   * empty-token placeholder snapshot, so the caller never has to swap
   * element types once the real id arrives — doing so would unmount and
   * rebuild the entire editor subtree (deck Y.Doc, Pixi canvas, slide
   * panel) in the middle of loading a deck.
   */
  folderId: string | null
  children: React.ReactNode
}

export function FolderDocProvider({ folderId, children }: FolderDocProviderProps) {
  const [value, setValue] = useState<FolderDocContextValue | null>(null)
  const providerRef = useRef<HocuspocusProvider | null>(null)
  const docRef = useRef<Y.Doc | null>(null)

  useEffect(() => {
    if (folderId === null) return
    if (providerRef.current !== null) return

    const doc = new Y.Doc()
    docRef.current = doc

    let tokens = emptyTokensSnapshot()
    setValue({ doc, tokens })

    const provider = new HocuspocusProvider({
      url: HOCUSPOCUS_URL,
      name: `folder:${folderId}`,
      document: doc,
      // Sentinel triggers HocuspocusProvider's auth-frame; server reads
      // the real session from the `narrative_session` cookie on the WS
      // upgrade. See `docs/adr/0005-server-side-session-cookies.md`.
      token: 'cookie',
      onSynced() {
        // First sync after server roundtrip — if the doc is brand new
        // (colors AND textStyles both empty), seed the design-system
        // defaults inside a single transaction. Idempotent.
        seedDefaultsIfEmpty(doc)
        // Older folders predate the `builtin` flag — tag any text style
        // matching a default name so the UI can keep them undeletable.
        backfillBuiltinTextStyles(doc)
        // Pre-existing folders carry the legacy "Footnote" label — bump
        // them to the new name so the picker matches what's documented.
        renameLegacyFootnoteStyle(doc)
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

    // Also observe the deletedComponentIds array so snapshot re-fires when
    // any peer writes a deletion signal (CRDT-replicated cascade trigger).
    const deletedArr = getDeletedComponentIdsArray(doc)
    deletedArr.observe(observer)

    return () => {
      tokensMap.unobserveDeep(observer)
      deletedArr.unobserve(observer)
      provider.destroy()
      doc.destroy()
      providerRef.current = null
      docRef.current = null
      setValue(null)
    }
  }, [folderId])

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
    const entry = catMap.get(id)
    if (!entry) return
    // Builtin text styles are part of the seeded minimum set — the
    // editor seeds new text objects from "Body" and falls back across
    // the others, so the UI must always have them available. Block
    // deletion at the mutation layer too as defense in depth.
    if (category === 'textStyles' && entry.get('builtin') === true) return
    doc.transact(() => {
      catMap.delete(id)
    })
  }, [])

  /**
   * @deprecated P4: use the async `useTokenUsages(folderId, category, id)`
   * hook instead. Calling this throws so silent empty lists don't hide
   * real references.
   */
  const listUsages = useCallback((_category: TokenCategory, _id: string): string[] => {
    throw new Error('listUsages is deprecated; use the useTokenUsages(folderId, category, id) hook')
  }, [])

  /**
   * Appends `componentId` to the folder's CRDT-replicated `deletedComponentIds`
   * Y.Array. Every peer observing this folder doc will see the write and can
   * sweep matching ComponentInstance objects from their open deck.
   *
   * Call immediately after `api.deleteComponent` succeeds. Duplicate entries
   * are acceptable — consumers read via a Set.
   */
  const markComponentDeleted = useCallback((componentId: string): void => {
    const doc = docRef.current
    if (!doc) return
    const arr = getDeletedComponentIdsArray(doc)
    doc.transact(() => {
      arr.push([componentId])
    })
  }, [])

  const mutations: FolderMutationsContextValue = {
    addToken,
    updateToken,
    deleteToken,
    listUsages,
    markComponentDeleted,
  }

  // Stable placeholder so we don't `new Y.Doc()` on every render before
  // the real provider's first sync.
  const placeholderRef = useRef<FolderDocContextValue | null>(null)
  if (placeholderRef.current === null) {
    placeholderRef.current = { doc: new Y.Doc(), tokens: emptyTokensSnapshot() }
  }
  useEffect(() => {
    return () => {
      placeholderRef.current?.doc.destroy()
      placeholderRef.current = null
    }
  }, [])

  if (value === null) {
    return (
      <FolderDocContext value={placeholderRef.current}>
        <FolderMutationsContext value={mutations}>{children}</FolderMutationsContext>
      </FolderDocContext>
    )
  }

  return (
    <FolderDocContext value={value}>
      <FolderMutationsContext value={mutations}>{children}</FolderMutationsContext>
    </FolderDocContext>
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
 * Like {@link useFolderTokens} but returns null when no provider is
 * mounted. Use from shared widgets (color pickers, etc.) that should
 * gracefully degrade outside the editor / folder context.
 */
export function useFolderTokensOptional(): FolderTokensSnapshot | null {
  const ctx = useContext(FolderDocContext)
  return ctx ? ctx.tokens : null
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
// useTokenUsages — fetch on-demand usage scan (M16 P4)
// ---------------------------------------------------------------------------

/**
 * Fetches all references to a design token across decks, components, and text
 * styles in the given folder.  Returns loading state + results.
 *
 * Design decision (option b from P4 spec): separate hook rather than making
 * `listUsages` async, so the synchronous stub in FolderMutationsContext
 * stays intact for callers that don't need loading state.
 *
 * `category` and `tokenId` are used to build the token key — pass null for
 * either to skip the fetch (modal not yet open).
 *
 * Usage:
 *   const { usages, loading, error } = useTokenUsages(folderId, 'colors', id)
 *
 * Must be used inside a component tree that renders <FolderDocProvider>.
 * Does NOT require FolderDocProvider itself — only the API client is used.
 */
export interface TokenUsagesState {
  usages: TokenUsage[]
  loading: boolean
  error: string | null
}

export function useTokenUsages(
  folderId: string,
  category: string | null,
  tokenId: string | null,
): TokenUsagesState {
  const api = useApi()
  const [state, setState] = useState<TokenUsagesState>({
    usages: [],
    loading: false,
    error: null,
  })

  // Stable key so the effect re-fires only when the target actually changes.
  const key = useMemo(
    () => (category !== null && tokenId !== null ? `${category}.${tokenId}` : null),
    [category, tokenId],
  )

  useEffect(() => {
    if (key === null || category === null || tokenId === null) {
      setState({ usages: [], loading: false, error: null })
      return
    }

    let cancelled = false

    setState({ usages: [], loading: true, error: null })

    api
      .listTokenUsages(folderId, category, tokenId)
      .then((usages) => {
        if (!cancelled) {
          setState({ usages, loading: false, error: null })
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setState({
            usages: [],
            loading: false,
            error: err instanceof Error ? err.message : 'Failed to scan usages',
          })
        }
      })

    return () => {
      cancelled = true
    }
  }, [api, folderId, key, category, tokenId])

  return state
}

// ---------------------------------------------------------------------------
// Convenience named re-exports for editor-ui agent
// ---------------------------------------------------------------------------

export type { FolderTokensSnapshot, FolderDocContextValue } from './FolderDocContext.js'
export type { TokenUsage } from '../api/client.js'
