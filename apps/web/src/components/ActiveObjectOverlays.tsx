/**
 * components/ActiveObjectOverlays.tsx — the parts of the editor that show the
 * active slide's objects, split out of EditorLayout (performance.md → E6).
 *
 * EditorLayout used to read the active slide's objects itself, so every
 * document change — each pointer move of a drag — re-rendered the whole
 * editor: panels, toolbar, menus, ~650 components a frame on a crowded slide.
 * It now reads the objects only when a handler runs (from the deck store,
 * current at that moment), and the pieces that draw objects subscribe here:
 *
 * - `ActiveObjectGuards` — the effects that keep selection and table-cell
 *   state consistent with the objects (renders nothing);
 * - `ActiveObjectOverlays part="handles"` — video previews and the
 *   transform rig of the selection;
 * - `ActiveObjectOverlays part="editors"` — the inline text editor, the table
 *   cell editor and chrome, crop, path-point and moveTo overlays.
 *
 * Each selects only the objects it shows, by id, from the deck store: a
 * drag re-renders the handles of the dragged selection, not the editors of
 * an unrelated table. The transform rig and the text editor select their
 * objects by fields (`sameObjectFields`), so typing re-renders neither: what a
 * keystroke changes lives inside the text's Y.Text, which the editor observes
 * itself.
 *
 * Their DOM positions inside the artboard are EditorLayout's, unchanged:
 * the overlays stack in the order they always did.
 */

import { useCallback, useEffect, useMemo, useRef } from 'react'
import { getSlideObjectsCtx, type DeckStore } from '@narrative/slide-model'
import type { SlideObject } from '@narrative/shared'
import type { SnapGuide } from '../editor/snap.js'
import { useSelection } from '../state/SelectionContext'
import { useTextEdit } from '../state/TextEditContext'
import { useTableEdit } from '../state/TableEditContext'
import { useCropMode } from '../state/CropModeContext'
import { usePathPointsMode } from '../state/PathPointsModeContext'
import { useAnimations } from '../state/useAnimations'
import { useSlideDoc } from '../state/useSlideDoc'
import {
  useActiveSlideObject,
  useActiveSlideObjectFields,
  useActiveSlideObjectFieldsWhere,
  useDeckSelector,
  useDeckStore,
} from '../state/useDeckStore.js'
import { useActiveSlide } from '../state/ActiveSlideContext.js'
import { useCanvasInstance } from '../renderer/CanvasInstanceContext'
import { TransformHandles } from '../ui/TransformHandles'
import { LineEndpointHandles } from '../ui/LineEndpointHandles'
import { EditorVideoPreview } from '../ui/EditorVideoPreview'
import { TextEditOverlay } from '../ui/TextEditOverlay'
import { TableCellEditor } from '../ui/TableCellEditor'
import { TableRangeHighlight } from '../ui/TableRangeHighlight'
// Shown only after a user action: chunks of their own (ui/lazyEditorParts.tsx).
import {
  CropOverlay,
  MoveToTargetOverlay,
  PathPointsOverlay,
  TableBorderSelectionOverlay,
  TableChrome,
} from '../ui/lazyEditorParts.js'

/**
 * The active slide's object ids with their types, joined: what the guards
 * below judge against. A string compares by value, so an edit inside an
 * object (a move, a keystroke) selects the same key and renders nothing.
 */
const selectIdsAndTypes =
  (slideId: string | null) =>
  (store: DeckStore): string =>
    slideId === null
      ? ''
      : (store.getSlide(slideId)?.objects ?? []).map((o) => `${o.id}\u0000${o.type}`).join('\n')

/**
 * Prune selection of ids that no longer exist before it is broadcast, and
 * drop table-cell editing whose table went away. Renders nothing; it is a
 * component so that only it re-renders when the slide's objects come or go.
 */
export function ActiveObjectGuards() {
  const { activeSlideId } = useActiveSlide()
  const idsKey = useDeckSelector(selectIdsAndTypes(activeSlideId))
  const { selectedIds, selectMany } = useSelection()
  const { active: activeTableCell, clear: clearTableCellEdit } = useTableEdit()

  // id → type of the objects on the active slide.
  const present = useMemo(() => {
    const map = new Map<string, string>()
    if (idsKey === '') return map
    for (const entry of idsKey.split('\n')) {
      const cut = entry.indexOf('\u0000')
      if (!map.has(entry.slice(0, cut))) map.set(entry.slice(0, cut), entry.slice(cut + 1))
    }
    return map
  }, [idsKey])

  // A peer (or a local delete on another slide path) can remove a selected
  // object; without this the stale id lingers in selectedIds, gets broadcast
  // over awareness as a phantom, and downstream lookups return undefined.
  // This component sits before EditorLayout's awareness broadcast in the
  // tree, so its effect runs first and peers never see a deleted id.
  //
  // Judged only against a NEW set of objects: a selected id is stale once a
  // set read after it was selected still lacks it. (The set is read from the
  // deck store at render, so a selection made right after a local insert —
  // duplicate, Alt-drag clone, paste — already finds the new ids; the rule
  // stays for a selection that names objects a peer's update has not
  // brought yet.)
  const prunedAgainstRef = useRef<Map<string, string> | null>(null)
  useEffect(() => {
    if (prunedAgainstRef.current === present) return
    prunedAgainstRef.current = present
    if (selectedIds.size === 0) return
    let hasStale = false
    for (const id of selectedIds) {
      if (!present.has(id)) {
        hasStale = true
        break
      }
    }
    if (!hasStale) return
    selectMany([...selectedIds].filter((id) => present.has(id)))
  }, [present, selectedIds, selectMany])

  // M29 Phase 2: clear table-cell-edit state if the active cell's table
  // disappears (deleted, peer removed it) or selection moves to a non-
  // table object.
  useEffect(() => {
    if (activeTableCell === null) return
    if (present.get(activeTableCell.tableId) !== 'table') {
      clearTableCellEdit()
      return
    }
    // Selection moved off the table — drop the editor target so the
    // inspector doesn't show table chrome for an unrelated object.
    if (selectedIds.size > 0 && !selectedIds.has(activeTableCell.tableId)) {
      clearTableCellEdit()
    }
  }, [present, activeTableCell, selectedIds, clearTableCellEdit])

  return null
}

interface ActiveObjectOverlaysProps {
  part: 'handles' | 'editors'
  isViewer: boolean
  /** Snap guides from a handle drag (EditorLayout draws them). */
  onSnapGuides: (guides: SnapGuide[]) => void
  /** Deck-level guides as extra snap targets. */
  extraGuides: ReadonlyArray<{ orientation: 'horizontal' | 'vertical'; position: number }>
  /** The text box being edited, as commands address it (stable while the edit lasts). */
  editingTextTarget: { slide: string; object: string } | null
}

export function ActiveObjectOverlays(props: ActiveObjectOverlaysProps) {
  return props.part === 'handles' ? <SelectionHandles {...props} /> : <ObjectEditors {...props} />
}

/** Video previews and the transform rig: the videos and the selected objects. */
function SelectionHandles({ isViewer, onSnapGuides, extraGuides }: ActiveObjectOverlaysProps) {
  const { deckCtx } = useSlideDoc()
  const store = useDeckStore()
  const { selectedIds } = useSelection()
  const { activeSlideId } = useActiveSlide()
  const canvasInstance = useCanvasInstance()
  const { cropImageId } = useCropMode()
  const { pathPointsId } = usePathPointsMode()
  // By fields: typing into the selected text box changes its snapshot, not
  // its fields, so the rig does not re-render per key. What typing does move
  // — a growing box's drawn height, a shrinking box's scale — reaches the rig
  // through the scene graph's layout notification (TransformHandles).
  const shown = useActiveSlideObjectFieldsWhere((o) => o.type === 'video' || selectedIds.has(o.id))
  const shownById = useMemo(() => {
    const map = new Map<string, SlideObject>()
    for (const o of shown) map.set(o.id, o)
    return map
  }, [shown])

  // The snap targets of a handle drag — every other object, as drawn (a
  // growing text box is as tall as it is drawn, whatever its `height`
  // says) — read when a drag frame needs them, not on every render.
  const otherBounds = useCallback(() => {
    if (activeSlideId === null) return []
    return (store.getSlide(activeSlideId)?.objects ?? [])
      .filter((o) => !selectedIds.has(o.id))
      .map((o) => ({
        id: o.id,
        x: o.x,
        y: o.y,
        width: o.width,
        height: canvasInstance?.sceneGraph.drawnSize(o.id)?.height ?? o.height,
      }))
  }, [store, activeSlideId, selectedIds, canvasInstance])

  const hasObjectsCtx =
    activeSlideId !== null && getSlideObjectsCtx(deckCtx, activeSlideId) !== null

  return (
    <>
      {/* P8: click-to-play video preview in the editor. Before the
        transform handles so the handles, selection outline and snap
        guides render ON TOP of the <video> element. */}
      {shown
        .filter((o) => o.type === 'video')
        .map((vidObj) => (
          <EditorVideoPreview key={`editor-video-${vidObj.id}`} videoObject={vidObj} />
        ))}

      {/* Transform handles — lines/arrows get endpoint handles instead of
        the 8-handle scale + rotate rig. Locked objects (P5a) skip the
        handles entirely; the object stays selected (the Inspector can
        toggle the flag) but can't be dragged / resized. */}
      {!isViewer &&
        selectedIds.size > 0 &&
        canvasInstance !== null &&
        hasObjectsCtx &&
        activeSlideId !== null &&
        (() => {
          const editableIds = [...selectedIds].filter((sid) => {
            const o = shownById.get(sid)
            if (o === undefined || o.locked === true) return false
            // While in crop mode, the cropped image is driven by
            // CropOverlay — suppress the normal 8-handle transform rig.
            if (cropImageId !== null && sid === cropImageId) return false
            // While point-edit is active on this path, hide the
            // bounding-box handles so the anchor dots are unobstructed.
            if (pathPointsId !== null && sid === pathPointsId) return false
            return true
          })
          if (editableIds.length === 0) return null

          if (editableIds.length === 1) {
            const onlyId = editableIds[0]
            const obj = onlyId !== undefined ? shownById.get(onlyId) : undefined
            if (obj !== undefined && (obj.type === 'line' || obj.type === 'arrow')) {
              return <LineEndpointHandles object={obj} slideId={activeSlideId} />
            }
          }
          // P15: aspect-ratio lock lives on every object
          // (BaseSlideObject.aspectLocked). If ANY selected object has it
          // on, the resize is locked; Shift inverts it mid-drag (XOR in
          // TransformHandles).
          const aspectLock = editableIds.some((sid) => shownById.get(sid)?.aspectLocked === true)
          return (
            <TransformHandles
              objectIds={editableIds}
              sceneGraph={canvasInstance.sceneGraph}
              slideId={activeSlideId}
              onSnapGuides={onSnapGuides}
              otherBounds={otherBounds}
              forceAspectLock={aspectLock}
              extraGuides={extraGuides}
              objects={shown}
            />
          )
        })()}
    </>
  )
}

/** The inline editors and per-object overlays: each object selected by id. */
function ObjectEditors({ isViewer, editingTextTarget }: ActiveObjectOverlaysProps) {
  const { deckCtx } = useSlideDoc()
  const { selectedIds, selectedAnimationId } = useSelection()
  const { activeSlideId } = useActiveSlide()
  const { editingId: editingTextId, endEdit } = useTextEdit()
  const { active: activeTableCell } = useTableEdit()
  const { cropImageId } = useCropMode()
  const { pathPointsId } = usePathPointsMode()
  const { animations } = useAnimations()

  const onlySelectedId = selectedIds.size === 1 ? ([...selectedIds][0] ?? null) : null
  const moveToStep =
    selectedAnimationId === null
      ? undefined
      : animations.find((a) => a.id === selectedAnimationId && a.preset === 'moveTo')

  // By fields: the overlay holds the live Y.Text and follows its content
  // itself (its observer), so a keystroke does not re-render it.
  const editingText = useActiveSlideObjectFields(editingTextId)
  const editedTable = useActiveSlideObject(
    activeTableCell !== null && activeTableCell.editing ? activeTableCell.tableId : null,
  )
  // The single selected object only when it is a table (its grid and chrome
  // are drawn here): dragging a rectangle does not render the editors.
  const onlySelected = useDeckSelector((store) => {
    if (activeSlideId === null || onlySelectedId === null) return undefined
    const o = store.getObject(activeSlideId, onlySelectedId)
    return o?.type === 'table' ? o : undefined
  })
  const croppedImage = useActiveSlideObject(cropImageId)
  const editedPath = useActiveSlideObject(pathPointsId)
  const moveToObject = useActiveSlideObject(moveToStep?.objectId ?? null)

  // Looked up per render (cheap): a slide's Y.Map can be replaced under the
  // same id, and the table cell editor binds to the live objects array.
  const mutationCtx = activeSlideId !== null ? getSlideObjectsCtx(deckCtx, activeSlideId) : null

  return (
    <>
      {/* P7: inline text edit overlay. Sits above the Pixi text and takes
        focus while the user edits. */}
      {editingTextId !== null &&
        mutationCtx !== null &&
        editingTextTarget !== null &&
        editingText !== undefined &&
        editingText.type === 'text' && (
          <TextEditOverlay obj={editingText} target={editingTextTarget} onEnd={endEdit} />
        )}

      {/* M29 Phase 2: per-cell editor for the first-class TableObject.
        Mounts only when `tableEdit.active.editing` is true; binds to the
        cell's Y.Text and handles Tab/Enter navigation across cells. */}
      {mutationCtx !== null &&
        activeSlideId !== null &&
        editedTable !== undefined &&
        editedTable.type === 'table' && (
          <TableCellEditor table={editedTable} slideId={activeSlideId} mutationCtx={mutationCtx} />
        )}

      {/* M29 Phase 3: drag-selected cell range highlight. */}
      <TableRangeHighlight />

      {/* M29: faint blue grid guides on every cell boundary of a selected
        table + a brighter overlay on the edges the inspector's
        border-preset grid targets. Mirrors Keynote. */}
      {onlySelected !== undefined && onlySelected.type === 'table' && (
        <TableBorderSelectionOverlay table={onlySelected} />
      )}

      {/* M29 Phase 5: Keynote-style chrome around the selected table (axis
        bars + corner handles). */}
      {onlySelected !== undefined && onlySelected.type === 'table' && activeSlideId !== null && (
        <TableChrome table={onlySelected} slideId={activeSlideId} isViewer={isViewer} />
      )}

      {/* P11: Keynote-style image crop overlay. */}
      {activeSlideId !== null && croppedImage !== undefined && croppedImage.type === 'image' && (
        <CropOverlay obj={croppedImage} slideId={activeSlideId} />
      )}

      {/* Path point-edit overlay — anchors as draggable dots. */}
      {activeSlideId !== null && editedPath !== undefined && editedPath.type === 'path' && (
        <PathPointsOverlay obj={editedPath} slideId={activeSlideId} />
      )}

      {/* moveTo animation target overlay — silhouette + draggable end-point
        handle when a moveTo step is selected. */}
      {activeSlideId !== null && moveToStep !== undefined && moveToObject !== undefined && (
        <MoveToTargetOverlay
          obj={moveToObject}
          step={moveToStep}
          slideId={activeSlideId}
          readOnly={isViewer}
        />
      )}
    </>
  )
}
