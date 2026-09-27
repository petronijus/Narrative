/**
 * hocuspocus/awarenessOwnership.ts
 *
 * Which connection an awareness client id belongs to — so the server never
 * trusts an awareness state one connection publishes under another
 * connection's client id (security finding M9).
 *
 * Why it is needed
 * ----------------
 * Awareness is a CRDT with no notion of ownership: any connection on a
 * document may send an update for ANY client id with a higher clock, and
 * y-protocols applies it. Hocuspocus 2.15 records a client id against the
 * connection whose update first ADDED it (`document.getClients(socket)`),
 * but it keeps applying later updates for that id from any connection. So a
 * collaborator — or a read-only share-link viewer, whose awareness messages
 * are still processed — could overwrite a user's tab state, and
 * `editor.context` (services/editor.ts) would read the forged selection /
 * active slide as that user's own and point the user's agent at it.
 *
 * The rule
 * --------
 * Each client id is bound to the PRINCIPAL (the connection's
 * `context.userId`, set by onAuthenticate) of the connection that first
 * announced it, and to that connection's socket:
 *   - an update for a bound id from a connection of the same principal is
 *     trusted (and moves the binding to that socket). Same principal, not
 *     same socket, because HocuspocusProvider relays every awareness change
 *     it sees to the server, including states it received from another tab
 *     of the same browser over its BroadcastChannel, and that relay can reach
 *     the server first;
 *   - an update for a bound id from a connection of ANOTHER principal is a
 *     forgery: the id is marked tainted, a warning is logged (once per
 *     socket), and its state is not trusted again until its owner publishes
 *     a fresh one. Legitimate relays never trip this: a relayed state carries
 *     the clock the server already has, and y-protocols ignores it (no update
 *     event at all);
 *   - a removal releases the binding when it comes from the owner principal
 *     or from the server itself (Hocuspocus removing a closed connection's
 *     states, the 30-second awareness timeout), or when the owner socket is
 *     no longer connected. A removal sent by another principal does not
 *     release it — otherwise "remove, then re-add" would transfer ownership;
 *   - the document's own client id (the agent presence peer,
 *     agent/presence.ts) is never bound.
 *
 * The forged state has already been applied and broadcast by the time the
 * update event fires (Hocuspocus' own listener runs first); this module
 * cannot un-send it. What it guarantees is that nothing server-side acts on
 * it: `trustedAwarenessClientIds` is the only way services read whose state
 * is whose.
 *
 * Wiring: `awarenessOwnershipExtension()` in hocuspocus/index.ts starts
 * tracking every document in `afterLoadDocument`, before any connection can
 * send awareness (Hocuspocus only processes a connection's messages once its
 * document has loaded). A document that is not tracked yields no trusted
 * ids at all (fail closed).
 */

import type { Document, Extension, afterLoadDocumentPayload } from '@hocuspocus/server'

type Log = { warn: (obj: object, msg: string) => void }

interface Binding {
  principal: string
  /** The socket that last published this id's state on the owner's behalf. */
  socket: unknown
  /** Last applied update came from another principal: do not trust the state. */
  tainted: boolean
}

interface DocumentOwnership {
  bindings: Map<number, Binding>
  /** Principal of each socket, cached (it never changes after authentication). */
  principals: WeakMap<object, string | null>
  warned: WeakSet<object>
}

const tracked = new WeakMap<Document, DocumentOwnership>()

interface AwarenessChange {
  added: number[]
  updated: number[]
  removed: number[]
}

function principalOfContext(context: unknown): string | null {
  const userId = (context as { userId?: unknown } | undefined)?.userId
  return typeof userId === 'string' && userId !== '' ? userId : null
}

/** The live connection's principal for a socket, or undefined when the socket is not a connection of the document. */
function principalOfSocket(
  document: Document,
  state: DocumentOwnership,
  socket: unknown,
): string | null | undefined {
  if (typeof socket !== 'object' || socket === null) return undefined
  if (state.principals.has(socket)) return state.principals.get(socket)
  for (const connection of document.getConnections()) {
    if (connection.webSocket === socket) {
      const principal = principalOfContext(connection.context)
      // Only cache a resolved principal: context is populated by the time
      // messages flow, but never pin a transient null.
      if (principal !== null) state.principals.set(socket, principal)
      return principal
    }
  }
  return undefined
}

function socketIsLive(document: Document, socket: unknown): boolean {
  return document.getConnections().some((c) => c.webSocket === socket)
}

/**
 * Start tracking ownership of `document`'s awareness client ids. Idempotent.
 * Called from `afterLoadDocument`; exported for tests.
 */
export function trackAwarenessOwnership(document: Document, log?: Log): void {
  if (tracked.has(document)) return
  const state: DocumentOwnership = {
    bindings: new Map(),
    principals: new WeakMap(),
    warned: new WeakSet(),
  }
  tracked.set(document, state)
  const serverClientId = document.awareness.clientID

  document.awareness.on('update', (change: AwarenessChange, origin: unknown) => {
    const principal = principalOfSocket(document, state, origin)
    // `undefined`: not a connection (the server's own writes, Hocuspocus'
    // cleanup of a closed connection, the awareness timeout).
    const fromConnection = principal !== undefined

    for (const clientId of [...change.added, ...change.updated]) {
      if (clientId === serverClientId || !fromConnection) continue
      const binding = state.bindings.get(clientId)
      if (principal === null) {
        // A connection without a principal (not authenticated yet): it can
        // never own an id, and taints one it writes.
        if (binding !== undefined) binding.tainted = true
        continue
      }
      if (binding === undefined) {
        state.bindings.set(clientId, { principal, socket: origin, tainted: false })
      } else if (binding.principal === principal) {
        binding.socket = origin
        binding.tainted = false
      } else {
        binding.tainted = true
        if (typeof origin === 'object' && origin !== null && !state.warned.has(origin)) {
          state.warned.add(origin)
          log?.warn(
            {
              doc: document.name,
              clientId,
              owner: binding.principal,
              sender: principal,
            },
            'awareness update for a client id owned by another principal ignored',
          )
        }
      }
    }

    for (const clientId of change.removed) {
      const binding = state.bindings.get(clientId)
      if (binding === undefined) continue
      if (
        !fromConnection ||
        principal === binding.principal ||
        !socketIsLive(document, binding.socket)
      ) {
        state.bindings.delete(clientId)
      }
    }
  })
}

/**
 * The awareness client ids of `document` whose current state `principal`
 * published: bound to that principal, not tainted, owned through a socket
 * that is still connected, and with a state present. Empty for a document
 * that is not tracked.
 */
export function trustedAwarenessClientIds(document: Document, principal: string): number[] {
  const state = tracked.get(document)
  if (state === undefined) return []
  const states = document.awareness.getStates()
  const live = new Set<unknown>(document.getConnections().map((c) => c.webSocket))
  const out: number[] = []
  for (const [clientId, binding] of [...state.bindings]) {
    if (!live.has(binding.socket) && !states.has(clientId)) {
      // Owner gone and no state left (its removal arrived from another
      // principal, so it did not release the binding then): forget it.
      state.bindings.delete(clientId)
      continue
    }
    if (binding.principal !== principal || binding.tainted) continue
    if (!live.has(binding.socket) || !states.has(clientId)) continue
    out.push(clientId)
  }
  return out
}

/** The Hocuspocus extension that tracks every loaded document. */
export function awarenessOwnershipExtension(opts: { log?: Log } = {}): Extension {
  return {
    async afterLoadDocument({ document }: afterLoadDocumentPayload): Promise<void> {
      trackAwarenessOwnership(document, opts.log)
    },
  }
}
