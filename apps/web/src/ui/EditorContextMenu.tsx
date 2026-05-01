/**
 * ui/EditorContextMenu.tsx
 *
 * P11c (rewrite): single right-click menu wrapping the canvas-backdrop.
 *
 * Replaces the previously nested CanvasContextMenu + ObjectContextMenu pair.
 * Two Radix Roots wrapped around overlapping DOM both fired on the same
 * contextmenu event and either stacked their portals or stole each other's
 * dismiss focus, so menu items refused to close / fire.
 *
 * Strategy:
 *   - One `<ContextMenu>` root, one `<ContextMenuTrigger>` wrapping the
 *     entire canvas-backdrop (display:contents so layout is unaffected).
 *   - On contextmenu, hit-test the click position against SceneGraph.
 *     · hit  → set mode='object', stash the targeted ids in a ref.
 *              If the hit object isn't already selected, promote it via
 *              SelectionContext.selectOne so transform handles + Inspector
 *              follow.
 *     · miss → set mode='canvas', stash the slide-space coords for the
 *              "Insert shape here" / "Paste at cursor" branches.
 *   - Content renders the appropriate item set based on `mode`.
 *
 * Every handler reads its targets / coords from refs to side-step React
 * state batching: by the time `onSelect` fires, the component has already
 * re-rendered with the promoted selection but the ref is the unambiguous
 * source.
 */

import { useRef, useState, useCallback, type RefObject } from 'react'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import {
  removeObject,
  duplicateObject,
  moveObjectsLayer,
  addObjects,
  updateObject,
  createObjectOfType,
  addObject,
} from '@narrative/slide-model'
import { setClipboard, hasClipboard, readClipboardForPaste } from '../state/clipboard.js'
import { applyShapeMask, isMaskableShape } from '../state/applyShapeMask.js'
import { useSlideObjects } from '../state/useSlideObjects.js'
import { useSelection } from '../state/SelectionContext.js'
import { useCanvasInstance } from '../renderer/CanvasInstanceContext.js'
import { useZoomLevel } from '../state/useZoomLevel.js'
import { SLIDE_WIDTH, SLIDE_HEIGHT } from '../renderer/constants.js'
import { useDefaultObjectFill } from '../state/useDefaultObjectFill.js'
import { useApi } from '../api/client.js'
import { useDeckRole } from '../state/DeckRoleContext.js'
import { nanoid } from 'nanoid'
import type { SlideObject, SlideObjectPatch, SlideObjectType } from '@narrative/shared'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SHAPE_ITEMS: { type: SlideObjectType; label: string }[] = [
  { type: 'rectangle', label: 'Rectangle' },
  { type: 'ellipse', label: 'Ellipse' },
  { type: 'triangle', label: 'Triangle' },
  { type: 'polygon', label: 'Polygon' },
  { type: 'line', label: 'Line' },
  { type: 'arrow', label: 'Arrow' },
  { type: 'text', label: 'Text' },
]

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface EditorContextMenuProps {
  /** The unscaled artboard div — used for clientX/Y → slide-space conversion. */
  canvasContainerRef: RefObject<HTMLDivElement | null>
  children: React.ReactNode
}

type Mode = 'object' | 'canvas'

export function EditorContextMenu({ canvasContainerRef, children }: EditorContextMenuProps) {
  const { objects, objectsCtx: mutationCtx } = useSlideObjects()
  const { selectedIds, selectOne, selectMany, clear } = useSelection()
  const canvasInstance = useCanvasInstance()
  const { zoom, setZoom } = useZoomLevel()
  const defaults = useDefaultObjectFill()
  const api = useApi()
  const { folderId } = useDeckRole()

  // Promote status — used to show a brief feedback toast text
  const [promoteStatus, setPromoteStatus] = useState<'idle' | 'promoting' | 'done' | 'error'>(
    'idle',
  )

  /** Mode flips on contextmenu and is read at render time to choose items. */
  const [mode, setMode] = useState<Mode>('canvas')

  /** Resolved object ids for object-mode handlers. Snapshotted in
   *  onContextMenu so handlers don't depend on the React selection batch. */
  const targetIdsRef = useRef<string[]>([])

  /** Slide-space coords for canvas-mode insert/paste. */
  const cursorCoordsRef = useRef<{ x: number; y: number }>({ x: 400, y: 300 })

  // ---------------------------------------------------------------------------
  // Right-click hit-test — runs synchronously during the contextmenu event
  // before Radix opens the menu.
  // ---------------------------------------------------------------------------

  const handleContextMenu = (e: React.MouseEvent<HTMLDivElement>): void => {
    const container = canvasContainerRef.current
    if (container === null) return
    const rect = container.getBoundingClientRect()
    const z = zoom === 0 ? 1 : zoom
    const slideX = (e.clientX - rect.left) / z
    const slideY = (e.clientY - rect.top) / z

    cursorCoordsRef.current = {
      x: Math.max(0, Math.min(SLIDE_WIDTH, slideX)),
      y: Math.max(0, Math.min(SLIDE_HEIGHT, slideY)),
    }

    if (canvasInstance !== null) {
      const hitId = canvasInstance.sceneGraph.hitTest(slideX, slideY)
      if (hitId !== null) {
        if (selectedIds.has(hitId)) {
          targetIdsRef.current = [...selectedIds]
        } else {
          selectOne(hitId)
          targetIdsRef.current = [hitId]
        }
        setMode('object')
        return
      }
    }
    targetIdsRef.current = []
    setMode('canvas')
  }

  // ---------------------------------------------------------------------------
  // Resolved targets for object-mode handlers
  // ---------------------------------------------------------------------------

  const resolveTargets = (): SlideObject[] =>
    targetIdsRef.current
      .map((id) => objects.find((o) => o.id === id))
      .filter((o): o is SlideObject => o !== undefined)

  // ---------------------------------------------------------------------------
  // Object-mode handlers
  // ---------------------------------------------------------------------------

  const handleCut = (): void => {
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

  const handleCopy = (): void => {
    const targets = resolveTargets()
    if (targets.length === 0) return
    setClipboard(targets)
  }

  const handleDuplicate = (): void => {
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

  const handleLayerMove = (move: 'front' | 'forward' | 'backward' | 'back'): void => {
    if (mutationCtx === null) return
    const ids = targetIdsRef.current
    if (ids.length === 0) return
    moveObjectsLayer(mutationCtx, ids, move)
  }

  const handleToggleLock = (): void => {
    if (mutationCtx === null) return
    const targets = resolveTargets()
    const target = targets[0]
    if (target === undefined) return
    updateObject(mutationCtx, target.id, {
      locked: target.locked === true ? undefined : true,
    } as SlideObjectPatch<SlideObject>)
  }

  const handleHyperlink = (): void => {
    window.dispatchEvent(new CustomEvent('narrative:focus-link-inspector'))
  }

  /**
   * Mask-with-shape: only valid when the right-click selection contains
   * exactly 1 image and 1 maskable shape with the shape z-above the image.
   * Returns the resolved pair (image + shape) or null otherwise. Used both
   * to disable the menu entry and to drive the action handler.
   */
  const resolveMaskPair = (): { imageId: string; shapeId: string } | null => {
    const targets = resolveTargets()
    if (targets.length !== 2) return null
    const a = targets[0]!
    const b = targets[1]!
    const aIdx = objects.indexOf(a)
    const bIdx = objects.indexOf(b)
    if (a.type === 'image' && isMaskableShape(b) && bIdx > aIdx) {
      return { imageId: a.id, shapeId: b.id }
    }
    if (b.type === 'image' && isMaskableShape(a) && aIdx > bIdx) {
      return { imageId: b.id, shapeId: a.id }
    }
    return null
  }

  const handleMaskWithShape = (): void => {
    if (mutationCtx === null) return
    const pair = resolveMaskPair()
    if (pair === null) return
    applyShapeMask(mutationCtx, pair.imageId, pair.shapeId)
    // After the action the shape is gone — collapse selection to the
    // surviving image so the user lands on it for further crop edits.
    selectOne(pair.imageId)
  }

  /**
   * Promote the current selection to a shared component.
   *
   * Strategy for P5:
   * 1. Compute the bounding box of the selection (union of x/y/width/height).
   * 2. Call api.createComponent() to mint a server-side component record.
   * 3. In a single Yjs transaction on the slide's objects map:
   *    - Remove the promoted objects from the slide.
   *    - Insert a single `componentInstance` node at the bbox top-left,
   *      sized to the bbox.
   * 4. Select the new instance.
   *
   * The actual subtree write into the component Y.Doc (via ComponentDocProvider
   * + promoteToComponent from slide-model) is left as a TODO because
   * those exports are not yet available from state-sync.
   *
   * TODO(P5: state-sync) — once useComponentDoc + promoteToComponent land,
   * open the component doc here and write the subtree in the same transaction.
   */
  const handlePromoteToComponent = useCallback((): void => {
    if (mutationCtx === null || folderId === null) return
    const targets = resolveTargets()
    if (targets.length === 0) return

    // Compute union bounding box
    const left = Math.min(...targets.map((o) => o.x))
    const top = Math.min(...targets.map((o) => o.y))
    const right = Math.max(...targets.map((o) => o.x + o.width))
    const bottom = Math.max(...targets.map((o) => o.y + o.height))
    const bboxW = right - left
    const bboxH = bottom - top

    setPromoteStatus('promoting')

    void api
      .createComponent(folderId, { name: 'Untitled component' })
      .then((component) => {
        // Generate a stable id for the instance slide-node
        const instanceId = nanoid()

        // Atomic Yjs transaction: remove originals, insert instance
        mutationCtx.doc.transact(() => {
          // Remove promoted objects from the slide
          for (const obj of targets) {
            removeObject(mutationCtx, obj.id)
          }
          // Insert the component instance at the bbox origin
          addObject(mutationCtx, {
            id: instanceId,
            type: 'componentInstance',
            componentId: component.id,
            componentName: component.name,
            x: left,
            y: top,
            width: Math.max(bboxW, 1),
            height: Math.max(bboxH, 1),
            rotation: 0,
            opacity: 1,
          })
        })

        // Select the new instance
        selectOne(instanceId)
        setPromoteStatus('done')

        // Reset status after 2 s
        window.setTimeout(() => setPromoteStatus('idle'), 2000)
      })
      .catch((err: unknown) => {
        console.error('[EditorContextMenu] promote to component failed:', err)
        setPromoteStatus('error')
        window.setTimeout(() => setPromoteStatus('idle'), 2000)
      })
  }, [api, folderId, mutationCtx, selectOne])

  const handleDelete = (): void => {
    if (mutationCtx === null) return
    const targets = resolveTargets()
    if (targets.length === 0) return
    for (const obj of targets) {
      if (obj.locked === true) continue
      removeObject(mutationCtx, obj.id)
    }
    clear()
  }

  // ---------------------------------------------------------------------------
  // Canvas-mode handlers
  // ---------------------------------------------------------------------------

  const handlePasteAtCursor = (): void => {
    if (!hasClipboard() || mutationCtx === null) return
    const { x, y } = cursorCoordsRef.current
    const pasted = readClipboardForPaste({ x: 0, y: 0 })
    if (pasted === null || pasted.length === 0) return
    const w = pasted[0]?.width ?? 160
    const h = pasted[0]?.height ?? 120
    const cx = x - w / 2
    const cy = y - h / 2
    const positioned = pasted.map((o) => ({ ...o, x: o.x + cx, y: o.y + cy }))
    addObjects(mutationCtx, positioned)
    selectMany(positioned.map((o) => o.id))
  }

  const handleInsertShape = (type: SlideObjectType): void => {
    if (mutationCtx === null) return
    const { x, y } = cursorCoordsRef.current
    const DEFAULT_W = type === 'text' ? 200 : 160
    const DEFAULT_H = type === 'text' ? 60 : 120
    const colorDefaults =
      type === 'line' || type === 'arrow'
        ? defaults.strokeDefaults
        : type === 'text'
          ? defaults.textColorDefaults
          : defaults.fillDefaults
    createObjectOfType(mutationCtx, type, {
      x: x - DEFAULT_W / 2,
      y: y - DEFAULT_H / 2,
      ...colorDefaults,
    } as Parameters<typeof createObjectOfType>[2])
  }

  const handleSelectAll = (): void => {
    selectMany(objects.map((o) => o.id))
  }

  const handleResetZoom = (): void => {
    setZoom(1)
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const canPaste = hasClipboard()
  const target = resolveTargets()[0]
  const isLocked = target?.locked === true
  const hasObjectTarget = targetIdsRef.current.length > 0
  const canPromote =
    hasObjectTarget && mutationCtx !== null && folderId !== null && promoteStatus === 'idle'

  return (
    <ContextMenu>
      {/* asChild merges trigger props onto the user-provided root div.
          Avoids the extra <span> + display:contents combo which was
          intermittently failing to receive bubbled contextmenu events
          (likely due to Pixi canvas' `oncontextmenu = preventDefault`
          stopping propagation in some browsers). */}
      <ContextMenuTrigger asChild>
        <div
          onContextMenu={handleContextMenu}
          data-testid="editor-context-menu-trigger"
          style={{ display: 'contents' }}
        >
          {children}
        </div>
      </ContextMenuTrigger>

      <ContextMenuContent
        className="w-52"
        data-testid="editor-context-menu-content"
        data-mode={mode}
      >
        {mode === 'object' && hasObjectTarget && (
          <>
            <ContextMenuItem disabled={mutationCtx === null} onSelect={handleCut}>
              Cut
            </ContextMenuItem>
            <ContextMenuItem onSelect={handleCopy}>Copy</ContextMenuItem>
            <ContextMenuItem
              disabled={!canPaste || mutationCtx === null}
              onSelect={handlePasteAtCursor}
            >
              Paste
            </ContextMenuItem>
            <ContextMenuItem disabled={mutationCtx === null} onSelect={handleDuplicate}>
              Duplicate
            </ContextMenuItem>

            <ContextMenuSeparator />

            <ContextMenuItem
              disabled={mutationCtx === null}
              onSelect={() => handleLayerMove('front')}
            >
              Bring to front
            </ContextMenuItem>
            <ContextMenuItem
              disabled={mutationCtx === null}
              onSelect={() => handleLayerMove('forward')}
            >
              Bring forward
            </ContextMenuItem>
            <ContextMenuItem
              disabled={mutationCtx === null}
              onSelect={() => handleLayerMove('backward')}
            >
              Send back
            </ContextMenuItem>
            <ContextMenuItem
              disabled={mutationCtx === null}
              onSelect={() => handleLayerMove('back')}
            >
              Send backward
            </ContextMenuItem>

            <ContextMenuSeparator />

            <ContextMenuItem
              disabled={target === undefined || mutationCtx === null}
              onSelect={handleToggleLock}
            >
              {isLocked ? 'Unlock' : 'Lock'}
            </ContextMenuItem>
            <ContextMenuItem disabled title="Hide not yet implemented (P12)">
              Hide
            </ContextMenuItem>

            <ContextMenuSeparator />

            <ContextMenuItem disabled={target === undefined} onSelect={handleHyperlink}>
              Hyperlink…
            </ContextMenuItem>

            <ContextMenuItem
              disabled={mutationCtx === null || resolveMaskPair() === null}
              onSelect={handleMaskWithShape}
            >
              Mask with shape
            </ContextMenuItem>

            {/* M16 P5 — promote selection to a shared component */}
            <ContextMenuItem
              disabled={!canPromote}
              onSelect={handlePromoteToComponent}
              data-testid="promote-to-component"
            >
              {promoteStatus === 'promoting'
                ? 'Promoting…'
                : promoteStatus === 'done'
                  ? 'Promoted to component'
                  : promoteStatus === 'error'
                    ? 'Promote failed'
                    : 'Promote to shared component'}
            </ContextMenuItem>

            <ContextMenuSeparator />

            <ContextMenuItem
              disabled={mutationCtx === null}
              onSelect={handleDelete}
              className="text-destructive focus:text-destructive"
            >
              Delete
            </ContextMenuItem>
          </>
        )}

        {mode === 'canvas' && (
          <>
            <ContextMenuItem
              disabled={!canPaste || mutationCtx === null}
              onSelect={handlePasteAtCursor}
            >
              Paste
            </ContextMenuItem>
            <ContextMenuSub>
              <ContextMenuSubTrigger disabled={mutationCtx === null}>
                Insert shape here
              </ContextMenuSubTrigger>
              <ContextMenuSubContent>
                {SHAPE_ITEMS.map(({ type, label }) => (
                  <ContextMenuItem key={type} onSelect={() => handleInsertShape(type)}>
                    {label}
                  </ContextMenuItem>
                ))}
              </ContextMenuSubContent>
            </ContextMenuSub>

            <ContextMenuSeparator />

            <ContextMenuItem onSelect={handleSelectAll}>Select all</ContextMenuItem>
            <ContextMenuItem onSelect={handleResetZoom}>Reset zoom</ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  )
}
