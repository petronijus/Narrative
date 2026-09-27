/**
 * state/editorShow.ts
 *
 * `editor.show` on the web side (agentic A1, plan §4.5, ADR 0011): an agent
 * asks the server to point the calling user's open editors at a slide and
 * some objects. The server delivers it as a Hocuspocus stateless message to
 * that user's own connections only. `SlideDocProvider` parses it and
 * publishes it on a per-deck bus; the editor subscribes and switches slide,
 * selects and flashes the objects. Nothing here writes the document.
 *
 * The payload arrives from the network, so it is parsed defensively: any
 * other stateless message (or a malformed one) is ignored, never thrown.
 */

import { createContext, useContext, useEffect, useRef } from 'react'
import { EDITOR_SHOW_MESSAGE_TYPE, type EditorShowMessage } from '@narrative/commands'

/** Upper bound on highlighted objects; a longer list is truncated, not rejected. */
const MAX_OBJECT_IDS = 500
/** Ids are short nanoids; anything longer is not an object id. */
const MAX_ID_LENGTH = 128

function isId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH
}

/**
 * Parse a stateless payload into an `editor.show` message, or null when it
 * is not one (another message type, not JSON, wrong shapes).
 */
export function parseEditorShowMessage(payload: unknown): EditorShowMessage | null {
  if (typeof payload !== 'string') return null
  let raw: unknown
  try {
    raw = JSON.parse(payload)
  } catch {
    return null
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const m = raw as Record<string, unknown>
  if (m['type'] !== EDITOR_SHOW_MESSAGE_TYPE) return null
  if (!isId(m['slideId'])) return null

  const rawIds = m['objectIds'] ?? []
  if (!Array.isArray(rawIds)) return null
  const objectIds = [...new Set(rawIds.filter(isId))].slice(0, MAX_OBJECT_IDS)

  const message: EditorShowMessage = {
    type: EDITOR_SHOW_MESSAGE_TYPE,
    slideId: m['slideId'],
    objectIds,
  }
  if (isId(m['runId'])) message.runId = m['runId']
  return message
}

// ---------------------------------------------------------------------------
// Bus
// ---------------------------------------------------------------------------

export type EditorShowListener = (message: EditorShowMessage) => void

export interface EditorShowBus {
  emit(message: EditorShowMessage): void
  subscribe(listener: EditorShowListener): () => void
}

export function createEditorShowBus(): EditorShowBus {
  const listeners = new Set<EditorShowListener>()
  return {
    emit(message) {
      for (const listener of [...listeners]) listener(message)
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

/** A bus nothing ever emits on — the default outside a live deck connection. */
const SILENT_BUS: EditorShowBus = {
  emit() {},
  subscribe: () => () => {},
}

/**
 * The deck connection's `editor.show` bus. Provided by the Hocuspocus deck
 * provider; the component-master editor (no deck connection) and tests get
 * the silent default.
 */
export const EditorShowBusContext = createContext<EditorShowBus>(SILENT_BUS)

/**
 * Subscribe to `editor.show` messages for the open deck. The latest
 * `listener` is always the one called, without resubscribing per render.
 */
export function useEditorShowMessages(listener: EditorShowListener): void {
  const bus = useContext(EditorShowBusContext)
  const listenerRef = useRef(listener)
  useEffect(() => {
    listenerRef.current = listener
  })
  useEffect(() => bus.subscribe((message) => listenerRef.current(message)), [bus])
}
