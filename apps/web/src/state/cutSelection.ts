/**
 * state/cutSelection.ts
 *
 * Cut, the one way the editor does it — the context menu's Cut, the Mod+X
 * shortcut and the desktop app's Edit ▸ Cut (which runs that shortcut): copy
 * every target into the editor's clipboard as a cut, then delete the ones a
 * person may change. Locks are an editor-only guard (AGENTS.md), so a locked
 * object is copied but stays where it is.
 */

export interface CutTarget {
  id: string
  locked?: boolean
}

export interface CutDeps {
  /** Fill the editor's clipboard; false when nothing could be copied. */
  copy(ids: string[], opts: { cut: true }): boolean
  /** Delete objects through the command layer (`object.delete`). */
  remove(ids: string[]): void
  /** Clear the selection. */
  clear(): void
}

/** Cut `targets`; whether anything was cut. */
export function cutSelection(targets: readonly CutTarget[], deps: CutDeps): boolean {
  if (targets.length === 0) return false
  if (
    !deps.copy(
      targets.map((o) => o.id),
      { cut: true },
    )
  )
    return false
  const unlocked = targets.filter((o) => o.locked !== true).map((o) => o.id)
  if (unlocked.length > 0) deps.remove(unlocked)
  deps.clear()
  return true
}
