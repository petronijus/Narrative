/**
 * state/clipboard.ts
 *
 * P6: in-memory clipboard for Copy / Paste across slides within the
 * current deck. Cross-deck paste lands in P11 (plan: mirror to
 * localStorage on copy, read on paste when in-memory slot is empty).
 *
 * We store *plain objects* (not Y.Maps) so the clipboard is detached
 * from any particular deck context and a paste can stamp fresh Y.Maps
 * in the active slide.
 */

import { nanoid } from 'nanoid'
import type { SlideObject } from '@narrative/shared'

let clipboard: SlideObject[] | null = null

/**
 * Store a snapshot of the selected objects. Caller owns serialization —
 * pass plain JSON-safe records (the SlideObject union is already flat).
 */
export function setClipboard(objects: ReadonlyArray<SlideObject>): void {
  if (objects.length === 0) {
    clipboard = null
    return
  }
  clipboard = objects.map((o) => structuredClone(o))
}

export function hasClipboard(): boolean {
  return clipboard !== null && clipboard.length > 0
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
  if (clipboard === null) return null
  const groupIdMap = new Map<string, string>()
  return clipboard.map((src) => {
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
