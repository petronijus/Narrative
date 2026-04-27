/**
 * state/dragLock.ts
 *
 * P14: prevents remote (peer) Y.Doc writes from interrupting a local
 * drag in progress.
 *
 * The bug: two clients dragging the same object — handlePointerMove
 * writes to Y.Doc on every pointer event (~60 Hz). Each write
 * propagates to the other client and triggers a Pixi re-render that
 * snaps the object to the peer's last position. From the local user's
 * perspective the object jumps back and forth between their cursor and
 * the peer's. Even with one user, a single client's local writes echo
 * through the observer pipeline and can briefly desync from the
 * pointer if a remote write lands between rAF ticks.
 *
 * Approach:
 *   - While a local drag is in progress, the ids being dragged are
 *     added to `localDragSet`.
 *   - The Canvas reconciler (apps/web/src/renderer/Canvas.tsx)
 *     filters out x/y/width/height/rotation/imageRect patch fields
 *     from `applyChanges` for ids in this set — so neither local
 *     echoes nor remote peers can move them.
 *   - The drag handler keeps writing to Y.Doc so peers still see the
 *     live position; visually the local user trusts the pointer.
 *   - On pointer-up, the lock clears and the consumer forces a
 *     resync from the current Y.Doc snapshot so any remote writes
 *     that arrived during the drag take effect.
 *
 * Module-level state is fine here — there's only ever one editor
 * canvas mounted at a time, and the lifecycle is bound to the editor
 * pointer handlers.
 */

const localDragIds = new Set<string>()

/** Add ids that are about to start dragging locally. */
export function lockLocalDrag(ids: Iterable<string>): void {
  for (const id of ids) localDragIds.add(id)
}

/** Drop the lock on the given ids (typically called on pointer-up). */
export function unlockLocalDrag(ids: Iterable<string>): void {
  for (const id of ids) localDragIds.delete(id)
}

/** True while the id is being dragged locally and remote writes for
 *  position/size should be ignored by the Pixi reconciler. */
export function isLocallyDragging(id: string): boolean {
  return localDragIds.has(id)
}

/** Clear every locked id — fail-safe for unmount paths. */
export function clearAllLocalDragLocks(): void {
  localDragIds.clear()
}
