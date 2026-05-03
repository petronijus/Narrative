/**
 * state/clipboard.ts
 *
 * P6: in-memory clipboard for Copy / Paste across slides within the
 * current deck.
 *
 * P11: Cross-deck clipboard. On setClipboard we also write a serialized
 * payload to localStorage keyed `narrative:clipboard`. On hasClipboard
 * and readClipboardForPaste we fall back to the localStorage value when
 * in-memory is empty (e.g. after a page reload or switching browser tabs).
 *
 * We store *plain objects* (not Y.Maps) so the clipboard is detached
 * from any particular deck context and a paste can stamp fresh Y.Maps
 * in the active slide.
 */

import { nanoid } from 'nanoid'
import * as Y from 'yjs'
import type { SlideObject } from '@narrative/shared'
import { toDelta } from '@narrative/slide-model'

/**
 * Capture inline formatting on a TextObject's Y.Text body as a Quill
 * delta and return a JSON-safe plain snapshot. The delta rides along on
 * `_richTextOps` and is consumed by slide-model `addObject` on paste,
 * which replays it into a freshly-integrated Y.Text. Without this step
 * Y.Text is opaque to JSON.stringify and inline italics/underline/
 * weight/color silently disappear on paste.
 */
function snapshotForClipboard(o: SlideObject): SlideObject {
  if (o.type === 'text') {
    const t = (o as { text: unknown }).text
    if (t instanceof Y.Text) {
      return {
        ...(o as object),
        text: t.toString(),
        _richTextOps: toDelta(t),
      } as unknown as SlideObject
    }
  }
  return o
}

const LS_KEY = 'narrative:clipboard'

let clipboard: SlideObject[] | null = null

// ---------------------------------------------------------------------------
// localStorage helpers — failures are silently ignored so clipboard still
// works when storage is unavailable (private browsing, quota exhausted).
// ---------------------------------------------------------------------------

function writeLS(objects: SlideObject[]): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(objects))
  } catch {
    /* quota or unavailable */
  }
}

function readLS(): SlideObject[] | null {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (raw === null) return null
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed) || parsed.length === 0) return null
    // Basic structural guard: each entry must have an id and type string.
    for (const item of parsed) {
      if (typeof item !== 'object' || item === null) return null
      if (typeof (item as Record<string, unknown>).id !== 'string') return null
      if (typeof (item as Record<string, unknown>).type !== 'string') return null
    }
    return parsed as SlideObject[]
  } catch {
    return null
  }
}

function clearLS(): void {
  try {
    localStorage.removeItem(LS_KEY)
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Store a snapshot of the selected objects. Caller owns serialization —
 * pass plain JSON-safe records (the SlideObject union is already flat).
 */
export function setClipboard(objects: ReadonlyArray<SlideObject>): void {
  if (objects.length === 0) {
    clipboard = null
    clearLS()
    return
  }
  // Snapshot Y.Text bodies into a JSON-safe delta first, THEN JSON
  // round-trip. JSON round-trip (rather than structuredClone) because
  // text objects can carry transient non-serializable side data attached
  // by upstream code (e.g. font-face load callbacks) which breaks
  // structuredClone with DataCloneError. JSON silently drops functions/
  // symbols, leaving exactly the persistable state.
  clipboard = objects.map((o) => JSON.parse(JSON.stringify(snapshotForClipboard(o))) as SlideObject)
  writeLS(clipboard)
}

export function hasClipboard(): boolean {
  if (clipboard !== null && clipboard.length > 0) return true
  // Fall back to localStorage for cross-deck / post-reload paste.
  return readLS() !== null
}

/**
 * Read + re-id the clipboard. Every call produces objects with freshly
 * generated ids so repeated pastes don't collide. `offset` is applied
 * to x/y so pasted objects don't perfectly overlap the source.
 *
 * Group ids are remapped: if multiple clipboard entries share a
 * groupId, paste preserves the grouping but with a new id so the
 * pasted group is distinct from the original.
 */
export function readClipboardForPaste(
  offset: { x: number; y: number } = { x: 10, y: 10 },
): SlideObject[] | null {
  // Prefer in-memory, fall back to localStorage.
  const source: SlideObject[] | null =
    clipboard !== null && clipboard.length > 0 ? clipboard : readLS()

  if (source === null) return null

  const groupIdMap = new Map<string, string>()
  return source.map((src) => {
    const cloned = structuredClone(src) as SlideObject
    cloned.id = nanoid()
    cloned.x = (cloned.x ?? 0) + offset.x
    cloned.y = (cloned.y ?? 0) + offset.y
    if (cloned.groupId !== undefined && cloned.groupId !== '') {
      const oldGroupId = cloned.groupId
      let newGroupId = groupIdMap.get(oldGroupId)
      if (newGroupId === undefined) {
        newGroupId = nanoid()
        groupIdMap.set(oldGroupId, newGroupId)
      }
      cloned.groupId = newGroupId
    }
    return cloned
  })
}
