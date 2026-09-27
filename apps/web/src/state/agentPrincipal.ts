/**
 * state/agentPrincipal.ts
 *
 * This editor's own agent principal key (PeerAgentInfo.principalKey in
 * @narrative/shared, ADR 0011 point 8): the value an agent peer working for
 * the signed-in user carries, so the peer chips can say "working for you".
 *
 * The key is an HMAC keyed with a server secret, so the browser cannot
 * compute it; the server sends it over the deck's WebSocket right after the
 * connection is established (a `narrative.agentPrincipal` stateless message,
 * apps/server/src/hocuspocus/agentPrincipal.ts). `SlideDocProvider` parses
 * it and keeps it in a small store scoped to the provider — a store rather
 * than a field of the SlideDoc context, so its arrival does not re-render
 * every `useSlideDoc()` consumer, only the few that ask for it.
 *
 * Share-link viewers never receive one (no agent works for them), and a
 * local-only document (the component master editor) has no server at all:
 * the key stays null and agent peers are labelled by their display name.
 */

import { createContext, useContext, useSyncExternalStore } from 'react'
import type { AgentPrincipalMessage } from '@narrative/shared'

export interface AgentPrincipalStore {
  /** The latest key the server sent, with the document it is scoped to. */
  get(): AgentPrincipalMessage | null
  set(message: AgentPrincipalMessage | null): void
  subscribe(listener: () => void): () => void
}

export function createAgentPrincipalStore(): AgentPrincipalStore {
  let current: AgentPrincipalMessage | null = null
  const listeners = new Set<() => void>()
  return {
    get: () => current,
    set(message) {
      if (
        message?.documentName === current?.documentName &&
        message?.principalKey === current?.principalKey
      )
        return
      current = message
      for (const listener of [...listeners]) listener()
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

/** Provided by the deck's SlideDocProvider; null outside one (and for local-only documents). */
export const AgentPrincipalStoreContext = createContext<AgentPrincipalStore | null>(null)

const noSubscription = (): (() => void) => () => undefined
const nothing = (): null => null

/**
 * The key the server told this editor for `documentName`, or null. A key for
 * another document (a stale message from the previous deck) is never
 * returned.
 */
export function useAgentPrincipalKeyFor(documentName: string | null): string | null {
  const store = useContext(AgentPrincipalStoreContext)
  const message = useSyncExternalStore(
    store?.subscribe ?? noSubscription,
    store?.get ?? nothing,
    store?.get ?? nothing,
  )
  if (documentName === null || message === null) return null
  return message.documentName === documentName ? message.principalKey : null
}
