/**
 * state/FolderDocProvider.tsx
 *
 * Opens a Hocuspocus connection to `folder:<folderId>` and gives the
 * subtree the folder's design tokens (slide-model folderDoc.ts has the
 * document's layout).
 *
 * Read-only since A2.12: the page never writes the folder document. New
 * folders get their default tokens on the server when they are created
 * (older ones by a one-time data migration), and tokens change through the
 * server — `useFolderTokenWriter()` (state/folderTokenWriter.ts), whose
 * pending changes show over the document's tokens until it catches up.
 * Until A2.12 the provider seeded and migrated a folder whenever someone
 * opened it, i.e. wrote the document because it was viewed.
 *
 * Hooks:
 *   useFolderTokens()             — the tokens (live, with pending changes)
 *   useFolderTokensOptional()     — the same, null outside a provider
 *   useFolderTokensForCommands()  — as `CommandContext.folderTokens` takes them
 *   useFolderTokensSettled()      — the tokens are final (synced, or refused)
 *   useFolderTokenWriter()        — create / update / remove / whenTokens
 *   useTokenUsages()              — where a token is used (server scan)
 *
 * Auth: the session cookie, or on a share-link visit the page's
 * `share_token` (as SlideDocProvider does): the server admits a folder's
 * members and, read-only, the guests of its decks, so a shared deck renders
 * with its folder's tokens (docs/plans/folder-sharing.md).
 */

import { HOCUSPOCUS_URL } from '../lib/endpoints.js'
import type { StylePack } from '@narrative/shared'
import { createContext, useContext, useEffect, useRef, useState, useMemo } from 'react'
import * as Y from 'yjs'
import { HocuspocusProvider } from '@hocuspocus/provider'
import { hasNoTokens, readFolderTokens, readStylePack } from '@narrative/slide-model'
import { useApi } from '../api/client.js'
import type { TokenUsage } from '../api/client.js'
import { FolderDocContext, emptyTokensSnapshot } from './FolderDocContext.js'
import type { FolderTokensSnapshot, FolderDocContextValue } from './FolderDocContext.js'
import { FolderTokenWriter, overlayTokens } from './folderTokenWriter.js'
import { hocuspocusAuthOptions } from './hocuspocusAuth.js'

/** The writer the subtree changes tokens with; null until the folder is known. */
const FolderTokenWriterContext = createContext<FolderTokenWriter | null>(null)

/**
 * The folder's style pack, read once per change for the whole subtree
 * (`useFolderStylePack`): every component that calls `useCommand` reads it,
 * and a listener and a JSON copy of the pack each would multiply with them.
 */
const FolderStylePackContext = createContext<StylePack | null | undefined>(undefined)

function FolderStylePackSnapshot({ children }: { children: React.ReactNode }) {
  const ctx = useContext(FolderDocContext)
  const doc = ctx !== null && ctx.synced ? ctx.doc : undefined
  const [pack, setPack] = useState<StylePack | null | undefined>(() =>
    doc === undefined ? undefined : (readStylePack(doc) as StylePack | null),
  )
  useEffect(() => {
    if (doc === undefined) {
      setPack(undefined)
      return
    }
    const map = doc.getMap('stylePack')
    const read = (): void => setPack(readStylePack(doc) as StylePack | null)
    read()
    map.observeDeep(read)
    return () => map.unobserveDeep(read)
  }, [doc])
  return <FolderStylePackContext value={pack}>{children}</FolderStylePackContext>
}

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
  const api = useApi()
  const [value, setValue] = useState<FolderDocContextValue | null>(null)
  const [writer, setWriter] = useState<FolderTokenWriter | null>(null)
  const providerRef = useRef<HocuspocusProvider | null>(null)

  useEffect(() => {
    if (folderId === null) return
    if (providerRef.current !== null) return

    const doc = new Y.Doc()
    let synced = false
    let refused = false
    // Assigned below; the refresh reads it for the pending changes.
    let tokenWriter: FolderTokenWriter | null = null
    const refresh = () => {
      const tokens = readFolderTokens(doc)
      setValue({
        doc,
        tokens: tokenWriter === null ? tokens : overlayTokens(tokens, tokenWriter.pending()),
        synced,
        refused,
      })
    }
    tokenWriter = new FolderTokenWriter(api, folderId, doc, refresh)
    setWriter(tokenWriter)
    setValue({ doc, tokens: emptyTokensSnapshot(), synced: false, refused: false })

    // The session cookie, or on a share-link visit the page's share_token,
    // exactly like the deck's document (state/hocuspocusAuth.ts).
    const authOptions = hocuspocusAuthOptions(HOCUSPOCUS_URL, window.location.search)
    const provider = new HocuspocusProvider({
      name: `folder:${folderId}`,
      document: doc,
      ...authOptions,
      onSynced() {
        synced = true
        refresh()
      },
      onAuthenticationFailed() {
        refused = true
        refresh()
      },
    })
    providerRef.current = provider

    // observeDeep on the root tokens Y.Map covers all nested changes.
    const tokensMap = doc.getMap<unknown>('tokens')
    tokensMap.observeDeep(refresh)

    return () => {
      tokensMap.unobserveDeep(refresh)
      tokenWriter?.dispose()
      provider.destroy()
      doc.destroy()
      providerRef.current = null
      setValue(null)
      setWriter(null)
    }
  }, [api, folderId])

  // Stable placeholder so we don't `new Y.Doc()` on every render before
  // the real provider's first sync.
  const placeholderRef = useRef<FolderDocContextValue | null>(null)
  if (placeholderRef.current === null) {
    placeholderRef.current = {
      doc: new Y.Doc(),
      tokens: emptyTokensSnapshot(),
      synced: false,
      refused: false,
    }
  }
  useEffect(() => {
    return () => {
      placeholderRef.current?.doc.destroy()
      placeholderRef.current = null
    }
  }, [])

  return (
    <FolderDocContext value={value ?? placeholderRef.current}>
      <FolderTokenWriterContext value={writer}>
        <FolderStylePackSnapshot>{children}</FolderStylePackSnapshot>
      </FolderTokenWriterContext>
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
 * The folder tokens as a command sees them (`CommandContext.folderTokens`):
 * the live snapshot once the folder document has synced (null when the
 * folder has no tokens at all, as the server host reports it), undefined
 * while they are not known — no provider (a shared deck whose folder the
 * user cannot open) or not synced yet.
 */
export function useFolderTokensForCommands(): FolderTokensSnapshot | null | undefined {
  const ctx = useContext(FolderDocContext)
  if (ctx === null || !ctx.synced) return undefined
  return hasNoTokens(ctx.tokens) ? null : ctx.tokens
}

/**
 * Whether the folder's tokens are as final as they will get — the folder
 * document synced, or the server refused it — so something rendered with
 * them may be kept (a thumbnail uploaded as a deck or component preview).
 * False while the folder is not known yet (the placeholder); true outside a
 * provider, where there is no folder to wait for.
 */
export function useFolderTokensSettled(): boolean {
  const ctx = useContext(FolderDocContext)
  return ctx === null || ctx.synced || ctx.refused
}

/**
 * Changing the folder's tokens (state/folderTokenWriter.ts); null while the
 * folder is not known yet or outside a provider — callers disable their
 * controls until it is there.
 */
export function useFolderTokenWriter(): FolderTokenWriter | null {
  return useContext(FolderTokenWriterContext)
}

// ---------------------------------------------------------------------------
// useTokenUsages — fetch on-demand usage scan (M16 P4)
// ---------------------------------------------------------------------------

/**
 * Fetches all references to a design token across decks, components, and text
 * styles in the given folder.  Returns loading state + results.
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

/**
 * The folder's style pack, live (agentic A4.3): null when the folder has
 * none, undefined while it is not known (no provider, not synced yet).
 * The editor's commands read it as `ctx.stylePack`.
 */
export function useFolderStylePack(): StylePack | null | undefined {
  return useContext(FolderStylePackContext)
}
