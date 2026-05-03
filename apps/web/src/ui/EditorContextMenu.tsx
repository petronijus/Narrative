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
import { nanoid } from 'nanoid'
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
  addAnimation,
  getSlideAnimationsCtx,
} from '@narrative/slide-model'
import { promoteSelectionToComponent } from '../state/promoteSelectionToComponent.js'
import {
  acquireComponentDoc,
  releaseComponentDoc,
  getComponentDoc,
  getComponentDocSyncStatus,
  subscribeToComponentDoc,
} from '../state/componentDocCache.js'
import { readMasterDoc } from '../state/readMasterDoc.js'
import { setClipboard, hasClipboard, readClipboardForPaste } from '../state/clipboard.js'
import { applyShapeMask, isMaskableShape } from '../state/applyShapeMask.js'
import { useSlideObjects } from '../state/useSlideObjects.js'
import { useSelection } from '../state/SelectionContext.js'
import { useCanvasInstance } from '../renderer/CanvasInstanceContext.js'
import { useZoomLevel } from '../state/useZoomLevel.js'
import { SLIDE_WIDTH, SLIDE_HEIGHT } from '../renderer/constants.js'
import { useDefaultObjectFill } from '../state/useDefaultObjectFill.js'
// useApi imported below alongside ComponentSummary
import { useDeckRole } from '../state/DeckRoleContext.js'
import { useSlideDoc } from '../state/useSlideDoc.js'
import { useActiveSlide } from '../state/ActiveSlideContext.js'
import { useAuth } from '../state/AuthContext.js'
import { useFolderComponents } from '../state/useFolderComponents.js'
import { ComponentPickerDrawer } from './ComponentPickerDrawer.js'
import { PromoteComponentDialog } from './PromoteComponentDialog.js'
import { extractComponentSnapshot } from '../state/extractComponentSnapshot.js'
import { useApi, type ComponentSummary } from '../api/client.js'
import type {
  SlideObject,
  SlideObjectPatch,
  SlideObjectType,
  ComponentInstanceObject,
  AnimationStep,
} from '@narrative/shared'
import { useLocation, useNavigate } from 'react-router-dom'

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
  const { deckCtx } = useSlideDoc()
  const { activeSlideId } = useActiveSlide()
  const { token } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()

  // Promote status — used to show a brief feedback toast text
  const [promoteStatus, setPromoteStatus] = useState<'idle' | 'promoting' | 'done' | 'error'>(
    'idle',
  )

  // Promote-to-component dialog open state.
  const [promoteDialogOpen, setPromoteDialogOpen] = useState(false)

  /** Tracks whether each known instance's master is loaded. Drives the
   * detach menu item's enabled state without re-rendering on every cache
   * pulse. */
  const [, forceMenuRerender] = useState(0)

  /** Mode flips on contextmenu and is read at render time to choose items. */
  const [mode, setMode] = useState<Mode>('canvas')

  /** Resolved object ids for object-mode handlers. Snapshotted in
   *  onContextMenu so handlers don't depend on the React selection batch. */
  const targetIdsRef = useRef<string[]>([])

  /** Slide-space coords for canvas-mode insert/paste. */
  const cursorCoordsRef = useRef<{ x: number; y: number }>({ x: 400, y: 300 })

  /**
   * Currently-held master doc cache reference (one per menu instance).
   * Tracked so we can release on unmount or when the targeted instance
   * changes — keeps the cache's linger window honest under rapid
   * right-click churn.
   */
  const heldComponentIdRef = useRef<string | null>(null)
  // Release the held master ref on unmount so the cache's ref-count
  // settles to zero and the linger-destroy timer can fire.
  /** Active subscription to the held master doc — cleaned up on swap / unmount. */
  const masterSubRef = useRef<(() => void) | null>(null)
  // Release the held master ref + subscription on unmount so the cache's
  // ref-count settles to zero and the linger-destroy timer can fire.
  useEffect(() => {
    return () => {
      masterSubRef.current?.()
      masterSubRef.current = null
      if (heldComponentIdRef.current !== null) {
        releaseComponentDoc(heldComponentIdRef.current)
        heldComponentIdRef.current = null
      }
    }
  }, [])
  const acquireMasterFor = (componentId: string): void => {
    if (heldComponentIdRef.current === componentId) return
    if (heldComponentIdRef.current !== null) {
      releaseComponentDoc(heldComponentIdRef.current)
    }
    masterSubRef.current?.()
    masterSubRef.current = null
    acquireComponentDoc(componentId)
    heldComponentIdRef.current = componentId
    // Re-render once the master doc syncs so the "Detach" item flips
    // from disabled → enabled. Subscribing instead of rAF-polling keeps
    // CPU at zero when the menu sits idle.
    masterSubRef.current = subscribeToComponentDoc(componentId, () => {
      if (heldComponentIdRef.current !== componentId) return
      forceMenuRerender((n) => n + 1)
    })
  }

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
        // If the right-clicked target is a single component instance, eagerly
        // acquire its master doc so detach + edit-master are ready by the
        // time the user picks the menu item.
        const hitObj = objects.find((o) => o.id === hitId)
        if (hitObj !== undefined && hitObj.type === 'componentInstance') {
          acquireMasterFor(hitObj.componentId)
        }
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
   * Order of operations:
   * 1. Build a serialisable plan via `promoteToComponent` (slide-model).
   * 2. Mint the Postgres row with the plan's `componentId` so server +
   *    Y.Doc agree on the master id.
   * 3. Open a transient Hocuspocus connection to the new component doc
   *    and write masterTree + masterAnimations into it.
   * 4. In one slide-level Yjs transaction, remove the promoted objects
   *    and insert the instance node — undo restores the originals
   *    atomically because everything happens inside a single transact.
   * 5. Select the new instance.
   */
  // Promote-to-component runs the actual create + Yjs work after the
  // user confirms a name in the dialog. Split out so the menu item can
  // open the dialog without locking the closure on a name.
  const performPromote = useCallback(
    (name: string): void => {
      if (mutationCtx === null || folderId === null) return
      if (deckCtx === null || activeSlideId === null) return
      const targets = resolveTargets()
      if (targets.length === 0) return

      setPromoteStatus('promoting')

      void (async () => {
        try {
          const { instanceId } = await promoteSelectionToComponent({
            api,
            folderId,
            mutationCtx,
            deckCtx,
            activeSlideId,
            targetIds: targets.map((t) => t.id),
            name,
            token,
          })

          selectOne(instanceId)
          setPromoteStatus('done')
          window.setTimeout(() => setPromoteStatus('idle'), 2000)
        } catch (err) {
          // Cleanup-on-failure is intentionally NOT performed here:
          // - The Postgres row stays — the user can delete it from the
          //   Components tab in folder settings if it's empty.
          // - The slide is unchanged because the transaction never fired.
          // Surface the failure so the user knows nothing was promoted.

          console.warn('[EditorContextMenu] promote to component failed', err)
          setPromoteStatus('error')
          window.setTimeout(() => setPromoteStatus('idle'), 2000)
        }
      })()
    },
    [api, folderId, mutationCtx, deckCtx, activeSlideId, selectOne, token],
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

  // ---------------------------------------------------------------------------
  // Component-instance specific handlers (M16 P6)
  // ---------------------------------------------------------------------------

  /**
   * Resolves the single ComponentInstance target for the right-click menu, or
   * null when the selection isn't a single instance. Group-selecting multiple
   * instances → null (detach + edit-master are single-target operations).
   */
  const resolveSingleInstanceTarget = (): ComponentInstanceObject | null => {
    const targets = resolveTargets()
    if (targets.length !== 1) return null
    const t = targets[0]
    if (t === undefined || t.type !== 'componentInstance') return null
    return t
  }

  /** True if the master doc for this instance has finished its first sync. */
  const isMasterSynced = (componentId: string): boolean => {
    return getComponentDocSyncStatus(componentId) === 'synced'
  }

  const handleEditMaster = useCallback(
    (instance: ComponentInstanceObject): void => {
      if (folderId === null) return
      navigate(`/folder/${folderId}/component/${instance.componentId}`, {
        state: { from: location.pathname + location.search },
      })
    },
    [folderId, location.pathname, location.search, navigate],
  )

  /**
   * Detach a component instance:
   *   - Read the master snapshot from `componentDocCache`.
   *   - In ONE Yjs transaction on the slide doc:
   *     1. Remove the instance node.
   *     2. Insert each master object, fresh-ID-mapped, translated + scaled
   *        to fit the instance's bbox (uniform scale, "fit" placement).
   *     3. Insert master animations onto the slide's animations array, with
   *        objectId remapped to the new copies and animation ids regenerated
   *        so the slide can carry many detached instances independently.
   *   - Single transaction → single undo step.
   *
   * If the master snapshot isn't loaded, the menu item is disabled and we
   * never reach this path. The acquire/release dance ensures the WS is
   * spinning up the moment the user opens the menu, so by the time they
   * try again the doc is usually ready.
   */
  const handleDetachInstance = (instance: ComponentInstanceObject): void => {
    if (mutationCtx === null || deckCtx === null || activeSlideId === null) return

    const masterDoc = getComponentDoc(instance.componentId)
    if (masterDoc === null) return // disabled in render — defensive
    const snapshot = readMasterDoc(masterDoc)
    if (snapshot === null || snapshot.objects.length === 0) return

    const bbox = snapshot.bbox
    const scaleX = bbox.width > 0 ? instance.width / bbox.width : 1
    const scaleY = bbox.height > 0 ? instance.height / bbox.height : 1
    // "Fit" — uniform scale, min of x/y so nothing overflows the bbox.
    const scale = Math.min(scaleX, scaleY)

    // Stable id remap: master object ids → fresh slide ids. Used by group-
    // member references (groupId field) and animation targets.
    const idMap = new Map<string, string>()
    for (const obj of snapshot.objects) {
      idMap.set(obj.id, nanoid())
    }

    // Renderer letterboxes the master content inside the instance bbox —
    // centred on whichever axis has spare room. Detach must apply the
    // same offset so the visual position is a true no-op:
    //   offsetX = (instance.width  - bbox.width  * scale) / 2
    //   offsetY = (instance.height - bbox.height * scale) / 2
    // Without this, instances whose aspect ratio doesn't match the
    // master jump to the top-left after detach.
    const offsetX = (instance.width - bbox.width * scale) / 2
    const offsetY = (instance.height - bbox.height * scale) / 2
    const newObjects: SlideObject[] = snapshot.objects.map((obj) => {
      // Spread to a mutable copy; rewrite id, x, y, width, height, groupId.
      const next = { ...(obj as unknown as Record<string, unknown>) } as Record<string, unknown>
      next.id = idMap.get(obj.id) ?? nanoid()
      next.x = (obj.x - bbox.x) * scale + instance.x + offsetX
      next.y = (obj.y - bbox.y) * scale + instance.y + offsetY
      next.width = obj.width * scale
      next.height = obj.height * scale
      // Remap groupId if it points at one of the promoted root groups.
      if (typeof next.groupId === 'string') {
        const remapped = idMap.get(next.groupId as string)
        if (remapped !== undefined) next.groupId = remapped
      }
      return next as unknown as SlideObject
    })

    // Build remapped animations: regenerate animation step ids and rewrite
    // objectId to the new slide-side copy. Steps targeting an unmapped id
    // (shouldn't happen — master only contains in-scope objects) are dropped.
    const newAnimations: AnimationStep[] = []
    for (const step of snapshot.animations) {
      const remappedTarget = idMap.get(step.objectId)
      if (remappedTarget === undefined) continue
      newAnimations.push({
        ...step,
        id: nanoid(),
        objectId: remappedTarget,
      })
    }

    const animationsCtx = getSlideAnimationsCtx(deckCtx, activeSlideId)

    // ONE transaction on the deck doc — covers the slide objects array AND
    // the slide animations array, both of which live under the same Y.Doc.
    // The undo manager (created from the deck context) treats the whole
    // batch as a single step.
    deckCtx.doc.transact(() => {
      removeObject(mutationCtx, instance.id)
      addObjects(mutationCtx, newObjects)
      if (animationsCtx !== null) {
        for (const step of newAnimations) {
          // We're inside a transact already — addAnimation will open a nested
          // transact, which Yjs flattens into the outer one. The id we
          // generated above is overwritten by addAnimation's own nanoid;
          // that's fine, animation ids are slide-local and we don't reference
          // them anywhere after detach.
          const { id: _unused, ...rest } = step
          void _unused
          addAnimation(animationsCtx, rest)
        }
      }
    })

    selectMany(newObjects.map((o) => o.id))
  }

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
  // M16 P7 — Missing-master flow
  // ---------------------------------------------------------------------------

  /**
   * True when the right-clicked instance's master is unrecoverable: cache
   * has finished its first sync round-trip but the doc carries no slide /
   * objects (i.e. server-side delete). Mirrors the renderer's
   * pickPlaceholderVariant rule so menu + canvas placeholder agree.
   */
  const isMasterMissing = (componentId: string): boolean => {
    if (getComponentDocSyncStatus(componentId) !== 'synced') return false
    const doc = getComponentDoc(componentId)
    if (doc === null) return true
    return extractComponentSnapshot(doc) === null
  }

  /**
   * Detach (preserve nothing) — used when the master is gone and there's
   * no snapshot to expand. Just removes the instance node; undo restores
   * it including its overrides slot.
   */
  const handleDetachOrphan = (instance: ComponentInstanceObject): void => {
    if (mutationCtx === null) return
    removeObject(mutationCtx, instance.id)
    clear()
  }

  /**
   * Replace the missing master with another component. Single
   * updateObject call → single transaction, single undo step. Existing
   * overrides slot is left intact (resolveInstanceTree skips dangling
   * leaf ids); the user can hit Reset overrides afterwards if they want
   * a clean slate.
   */
  const handlePickReplacement = (instanceId: string, component: ComponentSummary): void => {
    if (mutationCtx === null) return
    updateObject(mutationCtx, instanceId, {
      componentId: component.id,
      componentName: component.name,
    } as SlideObjectPatch<ComponentInstanceObject>)
    setReplaceTargetId(null)
  }

  // Replace…-flow state. Lives at the menu root so the picker drawer
  // outlives the (transient) Radix portal — picking a row dispatches
  // mutate + close.
  const [replaceTargetId, setReplaceTargetId] = useState<string | null>(null)
  const folderComponents = useFolderComponents(folderId, { eager: false })
  const [replaceUsageCounts, setReplaceUsageCounts] = useState<Record<string, number> | null>(null)
  const handleOpenReplace = (instance: ComponentInstanceObject): void => {
    setReplaceTargetId(instance.id)
    void folderComponents.invalidate()
    if (folderId !== null) {
      setReplaceUsageCounts(null)
      api
        .listComponentInstanceCounts(folderId)
        .then((counts) => setReplaceUsageCounts(counts))
        .catch(() => setReplaceUsageCounts({}))
    } else {
      setReplaceUsageCounts({})
    }
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
  // Components are flat: disallow promoting a selection that already
  // contains a componentInstance. Matches the same guard inside
  // promoteToComponent (slide-model); gating here surfaces it as a
  // disabled menu item instead of a throw + error toast.
  const selectionContainsInstance = resolveTargets().some((t) => t.type === 'componentInstance')
  const canPromote =
    hasObjectTarget &&
    mutationCtx !== null &&
    folderId !== null &&
    promoteStatus === 'idle' &&
    !selectionContainsInstance

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
                ? 'Creating component template…'
                : promoteStatus === 'done'
                  ? 'Component template created'
                  : promoteStatus === 'error'
                    ? 'Failed to create component template'
                    : 'Create component template'}
            </ContextMenuItem>

            {/* M16 P6 / P7 — component instance specific actions.
                When the master is missing (synced + null snapshot) the
                detach-via-master-snapshot path is impossible; surface
                the orphan-flow items instead. */}
            {(() => {
              const inst = resolveSingleInstanceTarget()
              if (inst === null) return null
              const masterReady = isMasterSynced(inst.componentId)
              const masterMissing = isMasterMissing(inst.componentId)
              if (masterMissing) {
                return (
                  <>
                    <ContextMenuItem
                      disabled={mutationCtx === null}
                      onSelect={() => handleDetachOrphan(inst)}
                      data-testid="detach-orphan-instance"
                    >
                      Detach (preserve nothing)
                    </ContextMenuItem>
                    <ContextMenuItem
                      disabled={mutationCtx === null || folderId === null}
                      onSelect={() => handleOpenReplace(inst)}
                      data-testid="replace-orphan-instance"
                    >
                      Replace…
                    </ContextMenuItem>
                  </>
                )
              }
              return (
                <>
                  <ContextMenuItem
                    disabled={folderId === null}
                    onSelect={() => handleEditMaster(inst)}
                    data-testid="edit-master-instance"
                  >
                    Edit master
                  </ContextMenuItem>
                  <ContextMenuItem
                    disabled={!masterReady || mutationCtx === null}
                    onSelect={() => handleDetachInstance(inst)}
                    data-testid="detach-instance"
                    title={masterReady ? undefined : 'Loading master…'}
                  >
                    {masterReady ? 'Detach instance' : 'Detach instance (loading master…)'}
                  </ContextMenuItem>
                </>
              )
            })()}

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
      {/* M16 P7 — Replace…-flow picker. Mounted at the menu root so it
          survives the Radix portal close that happens on item select.
          Open state lives in `replaceTargetId`. */}
      <ComponentPickerDrawer
        open={replaceTargetId !== null}
        onClose={() => setReplaceTargetId(null)}
        components={folderComponents.components}
        loading={folderComponents.loading}
        usageCounts={replaceUsageCounts}
        onPick={(component) => {
          if (replaceTargetId !== null) {
            handlePickReplacement(replaceTargetId, component)
          }
        }}
      />

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
