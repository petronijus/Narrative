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
import type { SlideObject, SlideObjectPatch } from '@narrative/shared'

interface ObjectContextMenuProps {
  children: React.ReactNode
}

export function ObjectContextMenu({ children }: ObjectContextMenuProps) {
  const { objects, objectsCtx: mutationCtx } = useSlideObjects()
  const { selectedIds, selectMany, clear } = useSelection()

  // ---------------------------------------------------------------------------
  // Derived state
  // ---------------------------------------------------------------------------

  const selectedObjects: SlideObject[] = [...selectedIds]
    .map((id) => objects.find((o) => o.id === id))
    .filter((o): o is SlideObject => o !== undefined)

  const hasSelection = selectedObjects.length > 0
  const singleSelected = selectedObjects.length === 1 ? selectedObjects[0] : undefined
  const isLocked = singleSelected?.locked === true

  // ---------------------------------------------------------------------------
  // Handlers — mirror the keyboard shortcut handlers in EditorLayout
  // ---------------------------------------------------------------------------

  const handleCut = () => {
    if (!hasSelection || mutationCtx === null) return
    setClipboard(selectedObjects)
    for (const obj of selectedObjects) {
      if (obj.locked === true) continue
      removeObject(mutationCtx, obj.id)
    }
    clear()
  }

  const handleCopy = () => {
    if (!hasSelection) return
    setClipboard(selectedObjects)
  }

  const handlePaste = () => {
    if (!hasClipboard() || mutationCtx === null) return
    const pasted = readClipboardForPaste({ x: 10, y: 10 })
    if (pasted === null || pasted.length === 0) return
    addObjects(mutationCtx, pasted)
    selectMany(pasted.map((o) => o.id))
  }

  const handleDuplicate = () => {
    if (!hasSelection || mutationCtx === null) return
    const newIds: string[] = []
    for (const obj of selectedObjects) {
      const dup = duplicateObject(mutationCtx, obj.id, { x: 20, y: 20 })
      if (dup !== null) newIds.push(dup.id)
    }
    if (newIds.length > 0) selectMany(newIds)
  }

  const handleLayerMove = (move: 'front' | 'forward' | 'backward' | 'back') => {
    if (!hasSelection || mutationCtx === null) return
    moveObjectsLayer(mutationCtx, [...selectedIds], move)
  }

  const handleToggleLock = () => {
    if (singleSelected === undefined || mutationCtx === null) return
    updateObject(mutationCtx, singleSelected.id, {
      locked: singleSelected.locked === true ? undefined : true,
    } as SlideObjectPatch<SlideObject>)
  }

  const handleDelete = () => {
    if (!hasSelection || mutationCtx === null) return
    for (const obj of selectedObjects) {
      if (obj.locked === true) continue
      removeObject(mutationCtx, obj.id)
    }
    clear()
  }

  const canPaste = hasClipboard()

  return (
    <ContextMenu>
      <ContextMenuTrigger style={{ display: 'contents' }}>{children}</ContextMenuTrigger>

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

        {/* Hyperlink: inspector section lands in P12 */}
        <ContextMenuItem disabled title="Hyperlinks not yet implemented (P12)">
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
