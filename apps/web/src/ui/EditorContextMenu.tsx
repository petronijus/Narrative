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

import { useEffect, useRef, useState, useCallback, type RefObject } from 'react'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import { getTableMergeInfo, isMaskableShape, type LayerMove } from '@narrative/slide-model'
import { useCommand } from '../state/useCommand.js'
import { promoteSelectionToComponent } from '../state/promoteSelectionToComponent.js'
import { useObjectClipboard } from '../state/useObjectClipboard.js'
import { useSlideObjects } from '../state/useSlideObjects.js'
import { useSelection } from '../state/SelectionContext.js'
import { useTableEdit } from '../state/TableEditContext.js'
import { useCanvasInstance } from '../renderer/CanvasInstanceContext.js'
import { useZoomLevel } from '../state/useZoomLevel.js'
import { SLIDE_WIDTH, SLIDE_HEIGHT } from '../renderer/constants.js'
import { useDefaultObjectFill } from '../state/useDefaultObjectFill.js'
import { useDeckRole } from '../state/DeckRoleContext.js'
import { useSlideDoc } from '../state/useSlideDoc.js'
import { useActiveSlide } from '../state/ActiveSlideContext.js'
import { PromoteComponentDialog } from './PromoteComponentDialog.js'
import { useApi } from '../api/client.js'
import { formatKeyCombo } from '../state/useShortcuts.js'
import type { ActionId } from '../actions/catalog.js'
import type { SlideObject, SlideObjectType, TableObject } from '@narrative/shared'

/**
 * Layer-order items, in menu order. `keys` is the canvas shortcut bound
 * to the same move in EditorLayout's useShortcuts.
 */
const LAYER_MENU_ITEMS: ReadonlyArray<{
  move: LayerMove
  label: string
  keys: string
  action: ActionId
}> = [
  { move: 'front', label: 'Bring to front', keys: 'Mod+]', action: 'object.bringToFront' },
  { move: 'forward', label: 'Bring forward', keys: ']', action: 'object.bringForward' },
  { move: 'backward', label: 'Send backward', keys: '[', action: 'object.sendBackward' },
  { move: 'back', label: 'Send to back', keys: 'Mod+[', action: 'object.sendToBack' },
]

/**
 * Hit-test a world (slide-space) point against a TableObject's cell
 * grid, accounting for the table's rotation around its centre and the
 * renderer's "rescale colWidths/rowHeights to fit table.width" rule.
 * Returns `{ r, c }` of the cell under the cursor or `null` when the
 * point falls outside the table's bbox.
 */
function hitTestTableCell(
  table: TableObject,
  worldX: number,
  worldY: number,
): { r: number; c: number } | null {
  const cx = table.x + table.width / 2
  const cy = table.y + table.height / 2
  const cos = Math.cos(-table.rotation)
  const sin = Math.sin(-table.rotation)
  const dx = worldX - cx
  const dy = worldY - cy
  const localX = cos * dx - sin * dy + table.width / 2
  const localY = sin * dx + cos * dy + table.height / 2
  if (localX < 0 || localX > table.width || localY < 0 || localY > table.height) return null
  const colSum = table.colWidths.reduce((a, b) => a + b, 0) || 1
  const rowSum = table.rowHeights.reduce((a, b) => a + b, 0) || 1
  const sx = table.width / colSum
  const sy = table.height / rowSum
  let acc = 0
  let col = table.colWidths.length - 1
  for (let i = 0; i < table.colWidths.length; i++) {
    acc += (table.colWidths[i] ?? 0) * sx
    if (localX <= acc) {
      col = i
      break
    }
  }
  acc = 0
  let row = table.rowHeights.length - 1
  for (let i = 0; i < table.rowHeights.length; i++) {
    acc += (table.rowHeights[i] ?? 0) * sy
    if (localY <= acc) {
      row = i
      break
    }
  }
  return { r: row, c: col }
}

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
  const command = useCommand()
  const objectClipboard = useObjectClipboard()
  const { selectedIds, selectOne, selectMany, clear } = useSelection()
  const { range: tableRange } = useTableEdit()
  const canvasInstance = useCanvasInstance()
  const { zoom, setZoom } = useZoomLevel()
  const defaults = useDefaultObjectFill()
  const api = useApi()
  const { folderId } = useDeckRole()
  // A deck's document name is its id; a component master (null) cannot promote.
  const { deckCtx, documentName: deckId, whenSaved } = useSlideDoc()
  const { activeSlideId } = useActiveSlide()

  // Promote status — used to show a brief feedback toast text
  const [promoteStatus, setPromoteStatus] = useState<'idle' | 'promoting' | 'done' | 'error'>(
    'idle',
  )

  // Promote-to-component dialog open state.
  const [promoteDialogOpen, setPromoteDialogOpen] = useState(false)

  /** Mode flips on contextmenu and is read at render time to choose items. */
  const [mode, setMode] = useState<Mode>('canvas')

  /** Resolved object ids for object-mode handlers. Snapshotted in
   *  onContextMenu so handlers don't depend on the React selection batch. */
  const targetIdsRef = useRef<string[]>([])

  /** Slide-space coords for canvas-mode insert/paste. */
  const cursorCoordsRef = useRef<{ x: number; y: number }>({ x: 400, y: 300 })

  /** Right-clicked cell inside a TableObject — snapshot for the table-
   *  specific menu items. `null` when the right-click missed a table or
   *  the table's cell math couldn't resolve a cell at the click point. */
  const tableCellHitRef = useRef<{ tableId: string; r: number; c: number } | null>(null)

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
          // Mirror left-click behavior (EditorLayout.tsx): if the hit
          // object belongs to a group, promote selection to the whole
          // group so right-click actions (e.g. Ungroup) operate on it.
          const hitObj = objects.find((o) => o.id === hitId)
          const hitGroupId =
            hitObj?.groupId !== undefined && hitObj.groupId !== '' ? hitObj.groupId : null
          if (hitGroupId !== null) {
            const groupIds = objects.filter((o) => o.groupId === hitGroupId).map((o) => o.id)
            selectMany(groupIds)
            targetIdsRef.current = groupIds
          } else {
            selectOne(hitId)
            targetIdsRef.current = [hitId]
          }
        }
        setMode('object')
        // Capture the table cell under the cursor so the table-specific
        // menu items (insert/delete row + col) target the right slot.
        const hitObj = objects.find((o) => o.id === hitId)
        if (hitObj !== undefined && hitObj.type === 'table') {
          const cell = hitTestTableCell(hitObj, slideX, slideY)
          tableCellHitRef.current =
            cell === null ? null : { tableId: hitObj.id, r: cell.r, c: cell.c }
        } else {
          tableCellHitRef.current = null
        }
        return
      }
    }
    targetIdsRef.current = []
    tableCellHitRef.current = null
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

  /** Delete the targets a person may delete: locks are an editor-only guard. */
  const deleteUnlocked = (targets: SlideObject[]): void => {
    const ids = targets.filter((o) => o.locked !== true).map((o) => o.id)
    if (ids.length === 0 || activeSlideId === null) return
    command.tryRun('object.delete', { slide: activeSlideId, objects: ids })
  }

  const handleCut = (): void => {
    const targets = resolveTargets()
    if (targets.length === 0) return
    if (
      !objectClipboard.copy(
        targets.map((o) => o.id),
        { cut: true },
      )
    )
      return
    deleteUnlocked(targets)
    clear()
  }

  const handleCopy = (): void => {
    const targets = resolveTargets()
    if (targets.length === 0) return
    objectClipboard.copy(targets.map((o) => o.id))
  }

  const handleDuplicate = (): void => {
    const targets = resolveTargets()
    if (targets.length === 0 || activeSlideId === null) return
    // One command, one undo step — same as Mod+D.
    const out = command.tryRun<{ objectIds: string[] }>('object.duplicate', {
      slide: activeSlideId,
      objects: targets.map((o) => o.id),
      offset: { x: 20, y: 20 },
    })
    if (out !== null && out.objectIds.length > 0) selectMany(out.objectIds)
  }

  const handleLayerMove = (move: LayerMove): void => {
    const ids = targetIdsRef.current
    if (ids.length === 0 || activeSlideId === null) return
    command.tryRun('object.layer', { slide: activeSlideId, objects: ids, move })
  }

  // ---------- Table cell ops — driven by tableCellHitRef ----------
  const tableTarget = (): { table: TableObject; r: number; c: number } | null => {
    const hit = tableCellHitRef.current
    if (hit === null || mutationCtx === null) return null
    const obj = objects.find((o) => o.id === hit.tableId)
    return obj === undefined || obj.type !== 'table'
      ? null
      : { table: obj as TableObject, r: hit.r, c: hit.c }
  }
  /** Run a table command on the table under the cursor. */
  const tableCommand = (
    commandId: string,
    input: (t: { table: TableObject; r: number; c: number }) => Record<string, unknown>,
  ): void => {
    const t = tableTarget()
    if (t === null || activeSlideId === null) return
    command.tryRun(commandId, { slide: activeSlideId, table: t.table.id, ...input(t) })
  }
  const handleTableInsertRowAbove = (): void =>
    tableCommand('table.row.insert', (t) => ({ index: t.r }))
  const handleTableInsertRowBelow = (): void =>
    tableCommand('table.row.insert', (t) => ({ index: t.r + 1 }))
  const handleTableInsertColBefore = (): void =>
    tableCommand('table.col.insert', (t) => ({ index: t.c }))
  const handleTableInsertColAfter = (): void =>
    tableCommand('table.col.insert', (t) => ({ index: t.c + 1 }))
  const handleTableDeleteRow = (): void => tableCommand('table.row.delete', (t) => ({ index: t.r }))
  const handleTableDeleteCol = (): void => tableCommand('table.col.delete', (t) => ({ index: t.c }))
  /** Phase 3 — Merge / split helpers driven by the table-edit range or
   *  the cell under the cursor. Read fresh on each invocation so the
   *  menu always acts on the latest state. */
  const handleTableMerge = (): void => {
    if (activeSlideId === null) return
    if (tableRange !== null && targetIdsRef.current.includes(tableRange.tableId)) {
      command.tryRun('table.merge', {
        slide: activeSlideId,
        table: tableRange.tableId,
        range: {
          from: { row: tableRange.r0, col: tableRange.c0 },
          to: { row: tableRange.r1, col: tableRange.c1 },
        },
      })
    }
  }
  const handleTableSplit = (): void => {
    const hit = tableCellHitRef.current
    if (hit === null || activeSlideId === null) return
    command.tryRun('table.split', {
      slide: activeSlideId,
      table: hit.tableId,
      cell: { row: hit.r, col: hit.c },
    })
  }
  const mergeInfoAtClickedCell = (): { kind: 'origin' | 'continuation' } | null => {
    if (mutationCtx === null) return null
    const hit = tableCellHitRef.current
    if (hit === null) return null
    const info = getTableMergeInfo(mutationCtx, hit.tableId, hit.r, hit.c)
    return info === null ? null : { kind: info.kind }
  }

  const handleToggleLock = (): void => {
    const target = resolveTargets()[0]
    if (target === undefined || activeSlideId === null) return
    command.tryRun('object.update', {
      slide: activeSlideId,
      object: target.id,
      patch: { locked: target.locked === true ? null : true },
    })
  }

  const handleUngroup = (): void => {
    const ids = targetIdsRef.current
    if (ids.length === 0 || activeSlideId === null) return
    command.tryRun('object.ungroup', { slide: activeSlideId, objects: ids })
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
    const pair = resolveMaskPair()
    if (pair === null || activeSlideId === null) return
    const out = command.tryRun('object.mask.apply', {
      slide: activeSlideId,
      image: pair.imageId,
      shape: pair.shapeId,
    })
    if (out === null) return
    // After the action the shape is gone — collapse selection to the
    // surviving image so the user lands on it for further crop edits.
    selectOne(pair.imageId)
  }

  /**
   * Promote the current selection to a component of the deck's folder:
   * `component.promote` on the server (state/promoteSelectionToComponent.ts),
   * after the server holds the slide's latest changes. The slide is not
   * changed.
   */
  // Promote-to-component runs the actual create + Yjs work after the
  // user confirms a name in the dialog. Split out so the menu item can
  // open the dialog without locking the closure on a name.
  const performPromote = useCallback(
    (name: string): void => {
      if (mutationCtx === null || folderId === null || deckId === null) return
      if (deckCtx === null || activeSlideId === null) return
      const targets = resolveTargets()
      if (targets.length === 0) return

      setPromoteStatus('promoting')

      void (async () => {
        try {
          await promoteSelectionToComponent({
            api,
            deckId,
            folderId,
            deckCtx,
            whenSaved,
            activeSlideId,
            targetIds: targets.map((t) => t.id),
            name,
          })

          setPromoteStatus('done')
          window.setTimeout(() => setPromoteStatus('idle'), 2000)
        } catch (err) {
          // Nothing to clean up: the server makes the component, its media
          // and its master together or not at all, and the slide is never
          // changed. Surface the failure so the user knows nothing was
          // promoted.
          console.warn('[EditorContextMenu] promote to component failed', err)
          setPromoteStatus('error')
          window.setTimeout(() => setPromoteStatus('idle'), 2000)
        }
      })()
    },
    [api, deckId, folderId, mutationCtx, deckCtx, whenSaved, activeSlideId],
  )

  const handlePromoteToComponent = useCallback((): void => {
    // Capture targets now (the menu dismiss will clear the selection
    // by the time the user confirms in the dialog). The dialog's
    // confirm callback only needs the name + the live `targetIdsRef`
    // — so we can rely on resolveTargets() inside performPromote.
    setPromoteDialogOpen(true)
  }, [])

  // Multi-select inspector dispatches this event when the user clicks
  // "Create component template". We seed `targetIdsRef` with the live
  // selection (the ref is otherwise only populated on right-click) and
  // open the same dialog the context menu uses.
  useEffect(() => {
    const handler = (e: Event): void => {
      const detail = (e as CustomEvent<{ ids?: string[] }>).detail
      const ids = Array.isArray(detail?.ids) ? detail.ids.filter((s) => typeof s === 'string') : []
      if (ids.length === 0) return
      targetIdsRef.current = ids
      setPromoteDialogOpen(true)
    }
    window.addEventListener('narrative:create-component-template', handler)
    return () => window.removeEventListener('narrative:create-component-template', handler)
  }, [])

  const handleDelete = (): void => {
    const targets = resolveTargets()
    if (targets.length === 0) return
    deleteUnlocked(targets)
    clear()
  }

  // ---------------------------------------------------------------------------
  // Canvas-mode handlers
  // ---------------------------------------------------------------------------

  // The pasted block is centred on the point the menu was opened at.
  const handlePasteAtCursor = (): void => {
    if (!objectClipboard.canPaste()) return
    const { x, y } = cursorCoordsRef.current
    void objectClipboard.paste({ at: { x, y } }).then((ids) => {
      if (ids !== null && ids.length > 0) selectMany(ids)
    })
  }

  const handleInsertShape = (type: SlideObjectType): void => {
    if (activeSlideId === null) return
    const { x, y } = cursorCoordsRef.current
    const DEFAULT_W = type === 'text' ? 200 : 160
    const DEFAULT_H = type === 'text' ? 60 : 120
    const colorDefaults =
      type === 'line' || type === 'arrow'
        ? defaults.strokeDefaults
        : type === 'text'
          ? defaults.textColorDefaults
          : defaults.fillDefaults
    command.tryRun('object.create', {
      slide: activeSlideId,
      object: { type, x: x - DEFAULT_W / 2, y: y - DEFAULT_H / 2, ...colorDefaults },
    })
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

  const canPaste = objectClipboard.canPaste()
  const target = resolveTargets()[0]
  const isLocked = target?.locked === true
  const hasObjectTarget = targetIdsRef.current.length > 0
  const canPromote =
    hasObjectTarget &&
    mutationCtx !== null &&
    folderId !== null &&
    deckId !== null &&
    promoteStatus === 'idle'
  // Ungroup is visible when any right-click target carries a groupId.
  const canUngroup =
    hasObjectTarget &&
    mutationCtx !== null &&
    resolveTargets().some((o) => o.groupId !== undefined && o.groupId !== '')

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
            <ContextMenuItem
              action="object.cut"
              disabled={mutationCtx === null}
              onSelect={handleCut}
            >
              Cut
            </ContextMenuItem>
            <ContextMenuItem action="object.copy" onSelect={handleCopy}>
              Copy
            </ContextMenuItem>
            <ContextMenuItem
              action="object.paste"
              disabled={!canPaste || activeSlideId === null}
              onSelect={handlePasteAtCursor}
            >
              Paste
            </ContextMenuItem>
            <ContextMenuItem
              action="object.duplicate"
              disabled={mutationCtx === null}
              onSelect={handleDuplicate}
            >
              Duplicate
            </ContextMenuItem>

            <ContextMenuSeparator />

            {/* Labels and shortcut hints match the canvas shortcuts in
                EditorLayout (and the Inspector's layer-order buttons):
                Mod+] front, ] forward, [ backward, Mod+[ back. The label
                sits in its own span so text lookups match it exactly. */}
            {LAYER_MENU_ITEMS.map(({ move, label, keys, action }) => (
              <ContextMenuItem
                key={move}
                action={action}
                disabled={mutationCtx === null}
                onSelect={() => handleLayerMove(move)}
                data-layer-move={move}
              >
                <span>{label}</span>
                <ContextMenuShortcut aria-hidden="true">{formatKeyCombo(keys)}</ContextMenuShortcut>
              </ContextMenuItem>
            ))}

            <ContextMenuSeparator />

            {/* M29 — Table cell mutations. Only render when the right
                click landed inside a single TableObject's grid; the
                hit is captured in `handleContextMenu` so the menu
                items operate on the cell under the cursor, not the
                currently-active edit cell. */}
            {tableCellHitRef.current !== null &&
              targetIdsRef.current.length === 1 &&
              targetIdsRef.current[0] === tableCellHitRef.current.tableId && (
                <>
                  <ContextMenuItem
                    action="table.insertRowAbove"
                    disabled={mutationCtx === null}
                    onSelect={handleTableInsertRowAbove}
                  >
                    Insert row above
                  </ContextMenuItem>
                  <ContextMenuItem
                    action="table.insertRowBelow"
                    disabled={mutationCtx === null}
                    onSelect={handleTableInsertRowBelow}
                  >
                    Insert row below
                  </ContextMenuItem>
                  <ContextMenuItem
                    action="table.insertColumnBefore"
                    disabled={mutationCtx === null}
                    onSelect={handleTableInsertColBefore}
                  >
                    Insert column left
                  </ContextMenuItem>
                  <ContextMenuItem
                    action="table.insertColumnAfter"
                    disabled={mutationCtx === null}
                    onSelect={handleTableInsertColAfter}
                  >
                    Insert column right
                  </ContextMenuItem>
                  <ContextMenuItem
                    action="table.deleteRow"
                    disabled={
                      mutationCtx === null ||
                      ((): boolean => {
                        const t = tableTarget()
                        return t === null || t.table.rows.length <= 1
                      })()
                    }
                    onSelect={handleTableDeleteRow}
                  >
                    Delete row
                  </ContextMenuItem>
                  <ContextMenuItem
                    action="table.deleteColumn"
                    disabled={
                      mutationCtx === null ||
                      ((): boolean => {
                        const t = tableTarget()
                        return t === null || t.table.colWidths.length <= 1
                      })()
                    }
                    onSelect={handleTableDeleteCol}
                  >
                    Delete column
                  </ContextMenuItem>
                  {/* M29 Phase 3 — Merge / Split */}
                  <ContextMenuItem
                    action="table.merge"
                    disabled={
                      mutationCtx === null ||
                      tableRange === null ||
                      tableRange.tableId !== tableCellHitRef.current.tableId
                    }
                    onSelect={handleTableMerge}
                  >
                    Merge cells
                  </ContextMenuItem>
                  <ContextMenuItem
                    action="table.split"
                    disabled={mutationCtx === null || mergeInfoAtClickedCell() === null}
                    onSelect={handleTableSplit}
                  >
                    Split cell
                  </ContextMenuItem>
                  <ContextMenuSeparator />
                </>
              )}

            <ContextMenuItem
              action="object.toggleLock"
              disabled={target === undefined || mutationCtx === null}
              onSelect={handleToggleLock}
            >
              {isLocked ? 'Unlock' : 'Lock'}
            </ContextMenuItem>
            <ContextMenuItem action="object.hide" disabled title="Hide not yet implemented (P12)">
              Hide
            </ContextMenuItem>

            <ContextMenuSeparator />

            <ContextMenuItem
              action="object.hyperlink"
              disabled={target === undefined}
              onSelect={handleHyperlink}
            >
              Hyperlink…
            </ContextMenuItem>

            {resolveMaskPair() !== null && (
              <ContextMenuItem
                action="object.mask"
                disabled={mutationCtx === null}
                onSelect={handleMaskWithShape}
              >
                Mask with shape
              </ContextMenuItem>
            )}

            {canUngroup && (
              <ContextMenuItem
                action="object.ungroup"
                onSelect={handleUngroup}
                data-testid="ungroup"
                title="Ungroup (Shift+Cmd+G)"
              >
                Ungroup
              </ContextMenuItem>
            )}

            {/* M16 P5 — promote selection to a shared component */}
            <ContextMenuItem
              action="component.promote"
              disabled={!canPromote}
              onSelect={handlePromoteToComponent}
              data-testid="promote-to-component"
            >
              {promoteStatus === 'promoting'
                ? 'Creating component template…'
                : promoteStatus === 'done'
                  ? 'Component template created'
                  : promoteStatus === 'error'
                    ? 'Failed to create component template'
                    : 'Create component template'}
            </ContextMenuItem>

            <ContextMenuSeparator />

            <ContextMenuItem
              action="object.delete"
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
              action="object.paste"
              disabled={!canPaste || activeSlideId === null}
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
                  <ContextMenuItem
                    key={type}
                    action="object.insertShape"
                    onSelect={() => handleInsertShape(type)}
                  >
                    {label}
                  </ContextMenuItem>
                ))}
              </ContextMenuSubContent>
            </ContextMenuSub>

            <ContextMenuSeparator />

            <ContextMenuItem action="selection.all" onSelect={handleSelectAll}>
              Select all
            </ContextMenuItem>
            <ContextMenuItem action="view.resetZoom" onSelect={handleResetZoom}>
              Reset zoom
            </ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
      <PromoteComponentDialog
        open={promoteDialogOpen}
        onCancel={() => setPromoteDialogOpen(false)}
        onConfirm={(name) => {
          setPromoteDialogOpen(false)
          performPromote(name)
        }}
      />
    </ContextMenu>
  )
}
