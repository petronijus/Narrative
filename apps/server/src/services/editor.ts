/**
 * services/editor.ts — server implementation of `EditorService`
 * (packages/commands/src/services/editor.ts).
 *
 * Reads and addresses the calling user's OPEN editor tabs on a deck, straight
 * from the live Hocuspocus documents (the same ground truth presence.ts
 * uses for the folder view's avatar chips):
 *   - a connection belongs to the user when `connection.context.userId` is
 *     theirs (set by `onAuthenticate`; share-link connections carry a
 *     `share:` display id and never match a real user);
 *   - which awareness states are the user's comes from
 *     hocuspocus/awarenessOwnership.ts, NOT from Hocuspocus'
 *     `document.getClients`: a client id counts only while it is bound to
 *     the user (first announced by one of their connections), untainted by
 *     an update from anyone else, and owned through a connection that is
 *     still open. Any connection can write an awareness update for any
 *     client id, so trusting whatever state sits under an id the user once
 *     announced would let a collaborator or a share-link viewer steer the
 *     user's agent with a forged selection (finding M9). The states are the
 *     `PeerAwarenessState` each tab publishes (selection, and since A1 the
 *     active slide);
 *   - `editor.show` is a Hocuspocus stateless message sent only to the
 *     user's own connections, never broadcast.
 * A deck may be open under its bare id (what the editor uses) or a legacy
 * `deck:<id>` name; both are checked. Nothing here loads a document: when no
 * one has the deck open there is nothing to read or point at.
 */

import type { Connection, Document, Hocuspocus } from '@hocuspocus/server'
import {
  CommandError,
  EDITOR_SHOW_MESSAGE_TYPE,
  type EditorService,
  type EditorShowMessage,
  type OpenEditorState,
} from '@narrative/commands'
import type { PeerAwarenessState } from '@narrative/shared'
import { getHocuspocusInstance } from '../hocuspocus/presence.js'
import { trustedAwarenessClientIds } from '../hocuspocus/awarenessOwnership.js'
import type { ServiceDeps } from './deps.js'

/** The Hocuspocus document names a deck can be open under. */
export function deckDocumentNames(deckId: string): string[] {
  return [deckId, `deck:${deckId}`]
}

interface UserConnection {
  document: Document
  connection: Connection
}

function userConnections(
  hocuspocus: Hocuspocus | null,
  deckId: string,
  userId: string,
): UserConnection[] {
  if (hocuspocus === null) return []
  const out: UserConnection[] = []
  for (const name of deckDocumentNames(deckId)) {
    const document = hocuspocus.documents.get(name)
    if (document === undefined || document.isLoading || document.isDestroyed) continue
    for (const connection of document.getConnections()) {
      const ctx = connection.context as { userId?: unknown } | undefined
      if (ctx?.userId === userId) out.push({ document, connection })
    }
  }
  return out
}

function isPeerState(value: unknown): value is PeerAwarenessState {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Partial<PeerAwarenessState>
  return typeof v.user === 'object' && v.user !== null && Array.isArray(v.selectedObjectIds)
}

function slideIndexOf(document: Document, slideId: string): number | null {
  const slides = document.getArray<unknown>('slides')
  for (let i = 0; i < slides.length; i++) {
    const slide = slides.get(i) as { get?: (k: string) => unknown } | undefined
    if (slide?.get?.('id') === slideId) return i
  }
  return null
}

export function createEditorService(deps: ServiceDeps): EditorService {
  const hocuspocus = (): Hocuspocus | null => (deps.hocuspocus ?? getHocuspocusInstance)()
  return {
    async context({ userId, deckId }) {
      const tabs: Array<OpenEditorState & { at: number }> = []
      // Each document the user has open, once (they may have several tabs on it).
      const documents = new Set(
        userConnections(hocuspocus(), deckId, userId).map(({ document }) => document),
      )
      for (const document of documents) {
        const states = document.awareness.getStates()
        for (const clientId of trustedAwarenessClientIds(document, userId)) {
          const state = states.get(clientId)
          if (!isPeerState(state)) continue
          const at = document.awareness.meta.get(clientId)?.lastUpdated ?? 0
          const activeSlideId = typeof state.activeSlideId === 'string' ? state.activeSlideId : null
          const activeSlideIndex =
            activeSlideId === null ? null : slideIndexOf(document, activeSlideId)
          tabs.push({
            // A slide deleted since the tab reported it is not "active" any more.
            activeSlideId: activeSlideIndex === null ? null : activeSlideId,
            activeSlideIndex,
            selectedObjectIds: state.selectedObjectIds.filter(
              (id): id is string => typeof id === 'string',
            ),
            lastActiveAt: new Date(at).toISOString(),
            at,
          })
        }
      }
      tabs.sort((a, b) => b.at - a.at)
      return tabs.map(({ at: _at, ...tab }) => tab)
    },

    async show({ userId, deckId, slideId, objectIds, runId }) {
      const message: EditorShowMessage = {
        type: EDITOR_SHOW_MESSAGE_TYPE,
        slideId,
        objectIds,
        ...(runId === undefined ? {} : { runId }),
      }
      const payload = JSON.stringify(message)
      let delivered = 0
      for (const { connection } of userConnections(hocuspocus(), deckId, userId)) {
        connection.sendStateless(payload)
        delivered++
      }
      return { delivered }
    },

    presentUrl({ deckId, slideNumber }) {
      if (deps.appOrigin === undefined) {
        throw new CommandError(
          'failed',
          'the server does not know the web app address (SPA_ORIGIN)',
        )
      }
      const url = new URL(`/deck/${encodeURIComponent(deckId)}/present`, deps.appOrigin)
      url.searchParams.set('slide', String(slideNumber))
      return url.toString()
    },
  }
}
