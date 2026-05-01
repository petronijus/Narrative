/**
 * state/ComponentDocProvider.tsx
 *
 * M16 P5 — Provider that opens a Hocuspocus connection to `component:<componentId>`
 * and exposes the live master Y.Doc to descendant components.
 *
 * Y.Doc schema (component master):
 *   slides: Y.Array<Y.Map>   — same multi-slide schema as a deck doc, except
 *                               the component only ever has one slide (the master canvas).
 *   animations: Y.Array<Y.Map> — animation steps for the master objects.
 *
 * For P5 the provider exposes read access only — write helpers (for editing the
 * master) land in P6/P7. The `doc` ref is available for consumers that need
 * to subscribe to changes directly.
 *
 * Auth:
 *   JWT Bearer token injected from AuthContext (same as FolderDocProvider).
 *   Share-token access is NOT supported for component docs.
 *
 * Usage:
 *   <ComponentDocProvider componentId="abc123">
 *     <YourEditorContent />
 *   </ComponentDocProvider>
 *
 *   // Inside a descendant:
 *   const doc = useComponentDoc('abc123')
 */

import { createContext, useContext, useEffect, useRef, useState } from 'react'
import * as Y from 'yjs'
import { HocuspocusProvider } from '@hocuspocus/provider'
import { useAuth } from './AuthContext.js'

const HOCUSPOCUS_URL = import.meta.env['VITE_HOCUSPOCUS_URL'] ?? 'ws://localhost:3002'

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

export interface ComponentDocContextValue {
  /** The live Hocuspocus Y.Doc for `component:<componentId>`. */
  doc: Y.Doc
  /** True after the first server sync round-trip. */
  synced: boolean
}

const ComponentDocContext = createContext<ComponentDocContextValue | null>(null)

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

interface ComponentDocProviderProps {
  componentId: string
  children: React.ReactNode
}

/**
 * Opens a WebSocket connection to the component master Y.Doc and makes it
 * available to all descendants via `useComponentDoc`.
 *
 * One provider per component editor view. Unmounting destroys the WS
 * connection and the local Y.Doc replica.
 */
export function ComponentDocProvider({ componentId, children }: ComponentDocProviderProps) {
  const { token } = useAuth()
  const [value, setValue] = useState<ComponentDocContextValue | null>(null)
  const providerRef = useRef<HocuspocusProvider | null>(null)
  const docRef = useRef<Y.Doc | null>(null)

  useEffect(() => {
    if (providerRef.current !== null) return

    const doc = new Y.Doc()
    docRef.current = doc

    setValue({ doc, synced: false })

    const provider = new HocuspocusProvider({
      url: HOCUSPOCUS_URL,
      name: `component:${componentId}`,
      document: doc,
      ...(token !== null ? { token } : { token: null }),
      onSynced() {
        setValue({ doc, synced: true })
      },
    })

    providerRef.current = provider

    return () => {
      provider.destroy()
      doc.destroy()
      providerRef.current = null
      docRef.current = null
      setValue(null)
    }
  }, [componentId, token])

  // Stable placeholder doc reused across renders before the real one is
  // wired up. Without this we'd `new Y.Doc()` every render and never
  // destroy the orphan instances — a slow memory leak.
  const placeholderRef = useRef<ComponentDocContextValue | null>(null)
  if (placeholderRef.current === null) {
    placeholderRef.current = { doc: new Y.Doc(), synced: false }
  }
  useEffect(() => {
    return () => {
      placeholderRef.current?.doc.destroy()
      placeholderRef.current = null
    }
  }, [])

  return (
    <ComponentDocContext.Provider value={value ?? placeholderRef.current}>
      {children}
    </ComponentDocContext.Provider>
  )
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Returns the live Y.Doc for the component master.
 * Triggers a re-render when the `synced` flag changes (i.e. on first server
 * round-trip). For fine-grained reactivity, subscribe to specific Y.Map / Y.Array
 * entries using `observeDeep` inside a `useEffect`.
 *
 * Must be used inside `<ComponentDocProvider componentId={...}>`.
 */
export function useComponentDoc(componentId: string): ComponentDocContextValue {
  const ctx = useContext(ComponentDocContext)
  if (!ctx) {
    throw new Error(
      `useComponentDoc('${componentId}') must be used inside <ComponentDocProvider componentId="${componentId}">`,
    )
  }
  return ctx
}

/**
 * Like {@link useComponentDoc} but returns null when no provider is mounted.
 * Use from shared widgets that should gracefully degrade outside the component
 * editor context.
 */
export function useComponentDocOptional(): ComponentDocContextValue | null {
  return useContext(ComponentDocContext)
}
