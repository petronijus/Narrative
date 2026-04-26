/**
 * ui/ObjectContextMenu.tsx
 *
 * P11: Right-click context menu for objects on the canvas artboard.
 *
 * Items:
 *  - Cut
 *  - Copy
 *  - Paste
 *  - Duplicate
 *  - Separator
 *  - Bring to front
 *  - Bring forward
 *  - Send back
 *  - Send backward
 *  - Separator
 *  - Lock / Unlock
 *  - Hide / Show  (visible flag — disabled, no schema field yet, P12)
 *  - Separator
 *  - Hyperlink…   (disabled, hyperlink inspector lands in P12)
 *  - Separator
 *  - Delete
 *
 * All handlers reuse the same mutation functions as the keyboard shortcuts in
 * EditorLayout. The component is intended to wrap the artboard div; Radix
 * ContextMenu wraps the entire artboard area but only shows when a selected
 * object is right-clicked (callers should set the `open` prop or just always
 * show it — Radix handles positioning automatically).
 *
 * Note: "Hide" and "Hyperlink…" are rendered disabled with a tooltip because
 * the underlying schema fields (visible, hyperlink) are out of scope for P11.
 */

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import {
  removeObject,
  duplicateObject,
  moveObjectsLayer,
  addObjects,
  updateObject,
} from '@narrative/slide-model'
import { setClipboard, hasClipboard, readClipboardForPaste } from '../state/clipboard.js'
import { useSlideObjects } from '../state/useSlideObjects.js'
import { useSelection } from '../state/SelectionContext.js'
import { useCanvasInstance } from '../renderer/CanvasInstanceContext.js'
import { useZoomLevel } from '../state/useZoomLevel.js'
import { useRef, type RefObject } from 'react'
import type { SlideObject, SlideObjectPatch } from '@narrative/shared'

interface ObjectContextMenuProps {
  children: React.ReactNode
  /** The artboard div — used to hit-test the right-click position so we
   *  can promote a non-selected hit object to the selection before the
   *  menu opens. Without this, right-clicking an unselected object
   *  yields hasSelection === false and Cut/Copy/Delete silently bail. */
  canvasContainerRef?: RefObject<HTMLDivElement | null>
}

export function ObjectContextMenu({ children, canvasContainerRef }: ObjectContextMenuProps) {
  const { objects, objectsCtx: mutationCtx } = useSlideObjects()
  const { selectedIds, selectOne, selectMany, clear } = useSelection()
  const canvasInstance = useCanvasInstance()
  const { zoom } = useZoomLevel()
  /** Snapshot of the right-click hit-test result so menu handlers can
   *  bypass React-state-dependent reads of selectedIds. The selection
   *  promotion in handleContextMenuCapture races React's state batch;
   *  by the time onSelect fires, selectedIds may or may not reflect
   *  the promoted id. The ref always does. */
  const lastHitIdsRef = useRef<string[] | null>(null)

  // ---------------------------------------------------------------------------
  // Derived state
  // ---------------------------------------------------------------------------

  /** Resolve the effective target ids at handler time. Prefer the live
   *  React selection; fall back to the hit-test snapshot taken on the
   *  contextmenu event if the React state hasn't caught up yet. */
  const resolveTargetIds = (): string[] => {
    if (selectedIds.size > 0) return [...selectedIds]
    return lastHitIdsRef.current ?? []
  }
  const resolveTargets = (): SlideObject[] =>
    resolveTargetIds()
      .map((id) => objects.find((o) => o.id === id))
      .filter((o): o is SlideObject => o !== undefined)

  // Reactive state for menu item disabled flags. Recomputed each render —
  // OK because handlers use resolveTargets() instead of these.
  const selectedObjects: SlideObject[] = [...selectedIds]
    .map((id) => objects.find((o) => o.id === id))
    .filter((o): o is SlideObject => o !== undefined)
  const hasSelection = selectedObjects.length > 0 || (lastHitIdsRef.current?.length ?? 0) > 0
  const singleSelected = selectedObjects.length === 1 ? selectedObjects[0] : undefined
  const isLocked = singleSelected?.locked === true

  // ---------------------------------------------------------------------------
  // Handlers — mirror the keyboard shortcut handlers in EditorLayout
  // ---------------------------------------------------------------------------

  const handleCut = () => {
    if (mutationCtx === null) return
    const targets = resolveTargets()
    if (targets.length === 0) return
    setClipboard(targets)
    for (const obj of targets) {
      if (obj.locked === true) continue
      removeObject(mutationCtx, obj.id)
    }
    clear()
  }

  const handleCopy = () => {
    const targets = resolveTargets()
    if (targets.length === 0) return
    setClipboard(targets)
  }

  const handlePaste = () => {
    if (!hasClipboard() || mutationCtx === null) return
    const pasted = readClipboardForPaste({ x: 10, y: 10 })
    if (pasted === null || pasted.length === 0) return
    addObjects(mutationCtx, pasted)
    selectMany(pasted.map((o) => o.id))
  }

  const handleDuplicate = () => {
    if (mutationCtx === null) return
    const targets = resolveTargets()
    if (targets.length === 0) return
    const newIds: string[] = []
    for (const obj of targets) {
      const dup = duplicateObject(mutationCtx, obj.id, { x: 20, y: 20 })
      if (dup !== null) newIds.push(dup.id)
    }
    if (newIds.length > 0) selectMany(newIds)
  }

  const handleLayerMove = (move: 'front' | 'forward' | 'backward' | 'back') => {
    if (mutationCtx === null) return
    const ids = resolveTargetIds()
    if (ids.length === 0) return
    moveObjectsLayer(mutationCtx, ids, move)
  }

  const handleToggleLock = () => {
    if (mutationCtx === null) return
    const targets = resolveTargets()
    const target = targets.length === 1 ? targets[0] : singleSelected
    if (target === undefined) return
    updateObject(mutationCtx, target.id, {
      locked: target.locked === true ? undefined : true,
    } as SlideObjectPatch<SlideObject>)
  }

  const handleDelete = () => {
    if (mutationCtx === null) return
    const targets = resolveTargets()
    if (targets.length === 0) return
    for (const obj of targets) {
      if (obj.locked === true) continue
      removeObject(mutationCtx, obj.id)
    }
    clear()
  }

  const canPaste = hasClipboard()

  /**
   * Pixi handles object selection on its own pointerdown — but a contextmenu
   * event from a right-click never reaches Pixi's selection logic, so the
   * React selection state stays whatever it was before the right-click.
   * Result: Cut / Copy / Delete silently bail because hasSelection is false.
   *
   * Hit-test the right-click position against the SceneGraph BEFORE Radix
   * opens the menu and promote the hit object to the selection. If the
   * click misses everything, leave the existing selection alone (the menu
   * still opens; items become disabled).
   */
  const handleContextMenuCapture = (e: React.MouseEvent<HTMLDivElement>): void => {
    if (canvasInstance === null || canvasContainerRef?.current == null) {
      // Best-effort: keep the existing selection in the snapshot so menu
      // handlers don't lose it to the React-state-batching race.
      lastHitIdsRef.current = [...selectedIds]
      return
    }
    const rect = canvasContainerRef.current.getBoundingClientRect()
    const z = zoom === 0 ? 1 : zoom
    const x = (e.clientX - rect.left) / z
    const y = (e.clientY - rect.top) / z
    const hitId = canvasInstance.sceneGraph.hitTest(x, y)
    if (hitId === null) {
      lastHitIdsRef.current = [...selectedIds]
      return
    }
    // If the right-click landed on something already in the selection,
    // operate on the whole multi-select. Otherwise promote just the hit.
    if (selectedIds.has(hitId)) {
      lastHitIdsRef.current = [...selectedIds]
    } else {
      selectOne(hitId)
      lastHitIdsRef.current = [hitId]
    }
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger style={{ display: 'contents' }} onContextMenu={handleContextMenuCapture}>
        {children}
      </ContextMenuTrigger>

      <ContextMenuContent className="w-52">
        <ContextMenuItem disabled={!hasSelection || mutationCtx === null} onSelect={handleCut}>
          Cut
        </ContextMenuItem>
        <ContextMenuItem disabled={!hasSelection} onSelect={handleCopy}>
          Copy
        </ContextMenuItem>
        <ContextMenuItem disabled={!canPaste || mutationCtx === null} onSelect={handlePaste}>
          Paste
        </ContextMenuItem>
        <ContextMenuItem
          disabled={!hasSelection || mutationCtx === null}
          onSelect={handleDuplicate}
        >
          Duplicate
        </ContextMenuItem>

        <ContextMenuSeparator />

        <ContextMenuItem
          disabled={!hasSelection || mutationCtx === null}
          onSelect={() => handleLayerMove('front')}
        >
          Bring to front
        </ContextMenuItem>
        <ContextMenuItem
          disabled={!hasSelection || mutationCtx === null}
          onSelect={() => handleLayerMove('forward')}
        >
          Bring forward
        </ContextMenuItem>
        <ContextMenuItem
          disabled={!hasSelection || mutationCtx === null}
          onSelect={() => handleLayerMove('backward')}
        >
          Send back
        </ContextMenuItem>
        <ContextMenuItem
          disabled={!hasSelection || mutationCtx === null}
          onSelect={() => handleLayerMove('back')}
        >
          Send backward
        </ContextMenuItem>

        <ContextMenuSeparator />

        <ContextMenuItem
          disabled={singleSelected === undefined || mutationCtx === null}
          onSelect={handleToggleLock}
        >
          {isLocked ? 'Unlock' : 'Lock'}
        </ContextMenuItem>
        {/* Hide / Show: no `visible` schema field yet — P12 follow-up */}
        <ContextMenuItem disabled title="Hide not yet implemented (P12)">
          Hide
        </ContextMenuItem>

        <ContextMenuSeparator />

        {/* P11: Hyperlink — focuses the Inspector's Link section. */}
        <ContextMenuItem
          disabled={singleSelected === undefined}
          onSelect={() => {
            window.dispatchEvent(new CustomEvent('narrative:focus-link-inspector'))
          }}
        >
          Hyperlink…
        </ContextMenuItem>

        <ContextMenuSeparator />

        <ContextMenuItem
          disabled={!hasSelection || mutationCtx === null}
          onSelect={handleDelete}
          className="text-destructive focus:text-destructive"
        >
          Delete
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
