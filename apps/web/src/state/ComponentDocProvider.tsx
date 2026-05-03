/**
 * state/ComponentDocProvider.tsx
 *
 * M16 P5 / P6 — Provider that exposes a single component master Y.Doc to
 * descendant components.
 *
 * P6 refactor: this provider now wraps the module-level
 * {@link componentDocCache} singleton. One Hocuspocus connection is opened
 * per `componentId` regardless of how many providers / instances reference
 * it, so a slide with N instances of the same master only pays one WS.
 *
 * Auth: the provider also installs the auth-context-backed token getter
 * into the cache so renderer-side acquires (which don't have direct access
 * to React context) can pick up the current Bearer token at connect time.
 *
 * Y.Doc schema:
 *   slides: Y.Array<Y.Map>     — single-slide deck shape (master canvas)
 *   slides[0].objects/animations
 *
 * Usage:
 *   <ComponentDocProvider componentId="abc123">
 *     <YourEditorContent />
 *   </ComponentDocProvider>
 *
 *   const { doc, synced } = useComponentDoc('abc123')
 */

import { createContext, useContext, useEffect, useRef, useState } from 'react'
import * as Y from 'yjs'
import { useAuth } from './AuthContext.js'
import {
  acquireComponentDoc,
  releaseComponentDoc,
  getComponentDoc,
  getComponentDocSyncStatus,
  subscribeToComponentDoc,
  registerComponentDocTokenGetter,
} from './componentDocCache.js'

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

export function ComponentDocProvider({ componentId, children }: ComponentDocProviderProps) {
  const { token } = useAuth()
  const tokenRef = useRef<string | null>(token)
  tokenRef.current = token

  // Stable placeholder doc — handed out before the cache hands us a real
  // one so consumers always have a valid Y.Doc reference (just empty).
  const placeholderRef = useRef<Y.Doc | null>(null)
  if (placeholderRef.current === null) {
    placeholderRef.current = new Y.Doc()
  }

  const [value, setValue] = useState<ComponentDocContextValue>(() => ({
    // Non-null assertion safe: placeholderRef set in the line above.
    doc: placeholderRef.current as Y.Doc,
    synced: false,
  }))

  // Token getter registration — separate effect from componentId so the
  // getter stays installed for the full provider lifetime regardless of
  // componentId churn. Coexists with Canvas's getter via the cache's
  // registration set (first non-null wins).
  useEffect(() => {
    const unregister = registerComponentDocTokenGetter(() => tokenRef.current)
    return unregister
  }, [])

  useEffect(() => {
    acquireComponentDoc(componentId)

    const refresh = (): void => {
      const doc = getComponentDoc(componentId)
      if (doc === null) return
      const synced = getComponentDocSyncStatus(componentId) === 'synced'
      setValue({ doc, synced })
    }
    refresh()

    const unsubscribe = subscribeToComponentDoc(componentId, refresh)

    return () => {
      unsubscribe()
      releaseComponentDoc(componentId)
    }
  }, [componentId])

  // Tear down the placeholder on full unmount.
  useEffect(() => {
    return () => {
      try {
        placeholderRef.current?.destroy()
      } catch {
        // ignore
      }
      placeholderRef.current = null
    }
  }, [])

  return <ComponentDocContext.Provider value={value}>{children}</ComponentDocContext.Provider>
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

/**
 * Returns the live Y.Doc for the component master.
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
 */
export function useComponentDocOptional(): ComponentDocContextValue | null {
  return useContext(ComponentDocContext)
}
