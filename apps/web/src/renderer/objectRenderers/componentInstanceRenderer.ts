/**
 * renderer/objectRenderers/componentInstanceRenderer.ts
 *
 * M16 P6 — Renders a ComponentInstanceObject by expanding the master
 * subtree fetched from the `component:<id>` Y.Doc cache.
 *
 * Layout:
 *   The Pixi node is structured as:
 *     instanceContainer (transform: x/y/rotation/opacity, pivot at instance centre)
 *       └── innerContainer (translate + uniform scale to fit master bbox into instance bbox)
 *             └── child renderers, one per master object, dispatched via the registry
 *
 *   The "fit, not stretch" choice — scale = min(instance.w / master.w, instance.h / master.h)
 *   — keeps the master's aspect ratio. When the instance has a different aspect
 *   the inner content is centred inside the instance bbox so neither axis
 *   crops content. This matches what the placeholder bbox preserved at
 *   promotion time and what the user expects when resizing the instance.
 *
 * Lifecycle:
 *   mount: acquires the master doc from componentDocCache, subscribes to
 *     mutations, paints the placeholder until the doc syncs, then expands
 *     the subtree and reconciles incrementally on every doc change.
 *   destroy: releases the cache slot, detaches the subscription, and tears
 *     down all inner child renderers via the same registry.
 *
 * What this renderer never does:
 *   - It never reaches into Yjs mutation APIs. Reads only — through the
 *     componentDocCache + extractComponentSnapshot pipeline.
 *   - It never bypasses the registry for child rendering — every master
 *     object goes through getRenderer(type).create/update/destroy.
 */

import { Container, Graphics, Point, Text, TextStyle } from 'pixi.js'
import type { ComponentInstanceObject, SlideObject } from '@narrative/shared'
import { resolveInstanceTree } from '@narrative/slide-model'
import type { ObjectRenderer } from './index.js'
import { rendererRegistry } from './index.js'
import {
  acquireComponentDoc,
  releaseComponentDoc,
  getComponentDoc,
  getComponentDocSyncStatus,
  subscribeToComponentDoc,
} from '../../state/componentDocCache.js'
import {
  extractComponentSnapshot,
  type ComponentSnapshot,
} from '../../state/extractComponentSnapshot.js'
import { reconcileChildren } from '../reconcileChildren.js'
import { markRenderDirty } from '../RenderScheduler.js'
import { setThumbnailReady } from '../thumbnailReady.js'

// ---------------------------------------------------------------------------
// Symbol-keyed slots
// ---------------------------------------------------------------------------

const PLACEHOLDER_TAG = Symbol('compInstPlaceholder')
const LABEL_TAG = Symbol('compInstLabel')
const INNER_TAG = Symbol('compInstInner')
const DATA_TAG = Symbol('compInstData')
const SNAPSHOT_TAG = Symbol('compInstSnapshot')
const CHILD_MAP_TAG = Symbol('compInstChildMap')
const COMP_ID_TAG = Symbol('compInstCompId')
const UNSUB_TAG = Symbol('compInstUnsub')
const PENDING_SINCE_TAG = Symbol('compInstPendingSince')
const MISSING_TIMER_TAG = Symbol('compInstMissingTimer')
const LAST_RESOLVED_LIST_TAG = Symbol('compInstLastResolvedList')
const THUMBNAIL_TAG = Symbol('compInstThumbnail')

// Pixi v8 Container has no public typing for symbol-keyed instance slots;
// widening to `any` lets us colocate per-instance state on the node so GC
// follows automatically when the node is destroyed (no side WeakMap that
// would need to be plumbed through every call site).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const asAny = (node: Container): any => node as any

interface InstanceSlots {
  placeholder?: Graphics
  label?: Text
  inner?: Container
  data?: ComponentInstanceObject
  snapshot?: ComponentSnapshot | null
  childMap?: Map<string, Container>
  componentId?: string
  unsubscribe?: () => void
  /** Timestamp (performance.now()) when the renderer first observed the
   *  doc in `pending` state. Cleared once the doc reports `synced`. Used
   *  to flip the placeholder copy from "syncing" → "Missing component"
   *  after MISSING_TIMEOUT_MS without progress. */
  pendingSince?: number
  /** setTimeout handle that triggers a re-paint when the missing window
   *  elapses while still pending. Cleared on detach / on first sync. */
  missingTimer?: number
  /** Last leaf list passed into reconcileChildren after master + override
   *  resolution. We stash it because applyPatch overwrites `data` with the
   *  new overrides BEFORE calling reconcileFromSnapshot, so recomputing
   *  prevList from the previous snapshot would still use the new overrides
   *  and produce a no-op diff. Reusing the cached list as prevList lets
   *  reconcileChildren see real per-property changes and fire updates. */
  lastResolvedList?: SlideObject[]
  /** Set when the container was created via `thumbnailMount` — drives
   *  inner-leaf mount/registry choice and skips main-scene render
   *  scheduling. Thumbnail nodes live under an offscreen Pixi
   *  Application, so any `markRenderDirty()` here would corrupt the
   *  main canvas's GL upload (foreign-context texSubImage2D). */
  thumbnail?: boolean
}

function getSlots(node: Container): InstanceSlots {
  return {
    placeholder: asAny(node)[PLACEHOLDER_TAG],
    label: asAny(node)[LABEL_TAG],
    inner: asAny(node)[INNER_TAG],
    data: asAny(node)[DATA_TAG],
    snapshot: asAny(node)[SNAPSHOT_TAG],
    childMap: asAny(node)[CHILD_MAP_TAG],
    componentId: asAny(node)[COMP_ID_TAG],
    unsubscribe: asAny(node)[UNSUB_TAG],
    pendingSince: asAny(node)[PENDING_SINCE_TAG],
    missingTimer: asAny(node)[MISSING_TIMER_TAG],
    lastResolvedList: asAny(node)[LAST_RESOLVED_LIST_TAG],
    thumbnail: asAny(node)[THUMBNAIL_TAG],
  }
}

function setSlot<K extends keyof InstanceSlots>(
  node: Container,
  key: K,
  value: InstanceSlots[K],
): void {
  const sym = SLOT_SYMBOLS[key]
  asAny(node)[sym] = value
}

const SLOT_SYMBOLS: Record<keyof InstanceSlots, symbol> = {
  placeholder: PLACEHOLDER_TAG,
  label: LABEL_TAG,
  inner: INNER_TAG,
  data: DATA_TAG,
  snapshot: SNAPSHOT_TAG,
  childMap: CHILD_MAP_TAG,
  componentId: COMP_ID_TAG,
  unsubscribe: UNSUB_TAG,
  pendingSince: PENDING_SINCE_TAG,
  missingTimer: MISSING_TIMER_TAG,
  lastResolvedList: LAST_RESOLVED_LIST_TAG,
  thumbnail: THUMBNAIL_TAG,
}

// ---------------------------------------------------------------------------
// Placeholder painting (kept from P5 as the "not-yet-synced" fallback)
// ---------------------------------------------------------------------------

const CORNER_R = 8
const BORDER_COLOR = 0x6366f1
const BORDER_ALPHA = 0.7
const FILL_COLOR = 0x6366f1
const FILL_ALPHA = 0.06
const STROKE_W = 1.5

// Placeholder variant for masters that have either gone missing on the
// server or sat unsynced past MISSING_TIMEOUT_MS. Red-ish so it's
// visually distinct from the "loading" indigo, dashed to read as
// "broken / not OK", smaller "?" icon to invite investigation.
const MISSING_BORDER_COLOR = 0xdc2626
const MISSING_BORDER_ALPHA = 0.85
const MISSING_FILL_COLOR = 0xdc2626
const MISSING_FILL_ALPHA = 0.05
const MISSING_DASH_LEN = 6
const MISSING_GAP_LEN = 4

/**
 * After this many ms of continuous `pending` status (with no snapshot
 * ever materialising) we flip the placeholder to "Missing component" —
 * see {@link maybeFlipToMissing} for the syncing-vs-deleted distinction.
 */
const MISSING_TIMEOUT_MS = 5_000

/**
 * Three placeholder states:
 *   - 'syncing': cache reports `pending`. Fresh mount or router transition;
 *     the cache's own retry handles the WS reconnect, so we just wait.
 *   - 'missing': either (a) we've been pending past MISSING_TIMEOUT_MS or
 *     (b) the cache reports `synced` but the master has empty/null
 *     `slides` — i.e. server-side delete or doc corruption. The user gets
 *     a visually-distinct dashed-red box with a "?" badge so they can tell
 *     "still loading" from "this master is gone".
 *
 * We never refetch from this code path — the cache already retries. The
 * placeholder is purely a presentation hint for the user.
 */
type PlaceholderVariant = 'syncing' | 'missing'

function drawPlaceholder(
  graphics: Graphics,
  label: Text,
  data: ComponentInstanceObject,
  variant: PlaceholderVariant = 'syncing',
): void {
  const { width, height } = data
  const borderColor = variant === 'missing' ? MISSING_BORDER_COLOR : BORDER_COLOR
  const borderAlpha = variant === 'missing' ? MISSING_BORDER_ALPHA : BORDER_ALPHA
  const fillColor = variant === 'missing' ? MISSING_FILL_COLOR : FILL_COLOR
  const fillAlpha = variant === 'missing' ? MISSING_FILL_ALPHA : FILL_ALPHA

  graphics.clear()
  graphics.roundRect(0, 0, width, height, CORNER_R)
  graphics.fill({ color: fillColor, alpha: fillAlpha })

  if (variant === 'missing') {
    // Dashed perimeter — Pixi v8 Graphics doesn't ship dashed strokes, so
    // we paint the dashes manually around the rectangle's bounding box
    // (rounded corners are sacrificed for simplicity; the dashed rect
    // still reads clearly as "broken").
    drawDashedRect(graphics, width, height, borderColor, borderAlpha)
  } else {
    graphics.roundRect(0, 0, width, height, CORNER_R)
    graphics.stroke({ color: borderColor, width: STROKE_W, alpha: borderAlpha })
  }

  const BADGE_SIZE = variant === 'missing' ? 12 : 14
  const BADGE_PAD = 6
  graphics.roundRect(BADGE_PAD, BADGE_PAD, BADGE_SIZE, BADGE_SIZE, 3)
  graphics.fill({ color: borderColor, alpha: 0.15 })
  graphics.roundRect(BADGE_PAD, BADGE_PAD, BADGE_SIZE, BADGE_SIZE, 3)
  graphics.stroke({ color: borderColor, width: 1, alpha: 0.5 })

  const maxLabelWidth = Math.max(width - 20, 40)
  const displayName =
    data.componentName != null && data.componentName.length > 0 ? data.componentName : 'Component'
  if (variant === 'missing') {
    label.text = `? Missing component\n${displayName}`
  } else {
    label.text = `⌘ ${displayName}`
  }
  label.style.wordWrapWidth = maxLabelWidth
  label.style.fill = borderColor
  label.x = width / 2
  label.y = height / 2
}

function drawDashedRect(g: Graphics, w: number, h: number, color: number, alpha: number): void {
  const stride = MISSING_DASH_LEN + MISSING_GAP_LEN
  const horiz = (y: number): void => {
    for (let x = 0; x < w; x += stride) {
      const x2 = Math.min(x + MISSING_DASH_LEN, w)
      g.moveTo(x, y)
      g.lineTo(x2, y)
    }
  }
  const vert = (x: number): void => {
    for (let y = 0; y < h; y += stride) {
      const y2 = Math.min(y + MISSING_DASH_LEN, h)
      g.moveTo(x, y)
      g.lineTo(x, y2)
    }
  }
  horiz(0)
  horiz(h)
  vert(0)
  vert(w)
  g.stroke({ color, width: STROKE_W, alpha })
}

function makeLabelStyle(): TextStyle {
  return new TextStyle({
    fontFamily: 'system-ui, -apple-system, sans-serif',
    fontSize: 11,
    fill: BORDER_COLOR,
    align: 'center',
    wordWrap: true,
    wordWrapWidth: 200,
    breakWords: true,
  })
}

// ---------------------------------------------------------------------------
// Transform helpers
// ---------------------------------------------------------------------------

function applyInstanceTransform(container: Container, data: ComponentInstanceObject): void {
  container.rotation = data.rotation
  container.alpha = data.opacity
  container.pivot.set(data.width / 2, data.height / 2)
  container.x = data.x + data.width / 2
  container.y = data.y + data.height / 2
}

/**
 * Re-fits the inner container into the instance bbox.
 *
 * Master content is rendered at its native master coordinates; the inner
 * container's transform translates the master bbox top-left to (0,0) and
 * uniformly scales so the larger axis of the master bbox matches the
 * corresponding axis of the instance bbox. The remaining axis is centred
 * — letterboxing rather than cropping.
 */
function applyInnerFit(
  inner: Container,
  data: ComponentInstanceObject,
  snapshot: ComponentSnapshot,
): void {
  // The auto-fit pass that grows the outer instance bbox writes a
  // `masterBboxOverride` so the renderer can keep the inner scale
  // constant — without it, growing data.w/h would shrink the master
  // content because scale = min(data.w/bbox.w, data.h/bbox.h).
  const bboxOv = data.overrides?.masterBboxOverride
  const bbox =
    bboxOv !== undefined &&
    typeof bboxOv.x === 'number' &&
    typeof bboxOv.y === 'number' &&
    typeof bboxOv.width === 'number' &&
    typeof bboxOv.height === 'number' &&
    bboxOv.width > 0 &&
    bboxOv.height > 0
      ? bboxOv
      : snapshot.bbox
  if (bbox.width <= 0 || bbox.height <= 0) {
    inner.scale.set(1)
    inner.x = 0
    inner.y = 0
    return
  }
  const sx = data.width / bbox.width
  const sy = data.height / bbox.height
  const scale = Math.min(sx, sy)
  const renderedW = bbox.width * scale
  const renderedH = bbox.height * scale
  const offsetX = (data.width - renderedW) / 2
  const offsetY = (data.height - renderedH) / 2
  // Subtract bbox.x/y so master objects positioned at e.g. (100, 50) on
  // the master canvas land at (0, 0) in the inner space before scaling.
  // P7: instance-level `overrides.transform` is added on TOP of the
  // letterbox math — the user nudges the inner content within the
  // instance bbox without touching the instance's own x/y (which
  // controls the outer container's slide position). Values are in
  // instance-space pixels (i.e. post-fit), matching what the Inspector
  // input shows.
  const tx = data.overrides?.transform?.x ?? 0
  const ty = data.overrides?.transform?.y ?? 0
  inner.scale.set(scale)
  inner.x = offsetX - bbox.x * scale + tx
  inner.y = offsetY - bbox.y * scale + ty
}

// ---------------------------------------------------------------------------
// Reconciliation glue
// ---------------------------------------------------------------------------

/**
 * Project the master snapshot through the instance's per-leaf overrides.
 * P7 delegates to the shared resolver in @narrative/slide-model so the
 * inspector preview path uses the exact same merge rules.
 *
 * Each instance node holds its own resolved tree (this function is called
 * fresh per reconcile), so instances of the same master with different
 * overrides never share state.
 */
function projectSnapshotForInstance(
  snapshot: ComponentSnapshot,
  data: ComponentInstanceObject,
): SlideObject[] {
  return resolveInstanceTree(snapshot.objects, data.overrides)
}

function reconcileFromSnapshot(node: Container, force: boolean): void {
  const slots = getSlots(node)
  const data = slots.data
  if (data === undefined) return

  // No componentId → nothing to expand.
  const componentId = slots.componentId
  if (componentId === undefined) return

  const doc = getComponentDoc(componentId)
  if (doc === null) return

  const status = getComponentDocSyncStatus(componentId)
  const nextSnapshot = extractComponentSnapshot(doc)

  // Render whatever content we have. The `synced` flag only tells us
  // whether Hocuspocus has acknowledged its first round-trip; when we
  // already have a non-null snapshot (Y.applyUpdate populated slides[]
  // before `synced` fired) we should expand it immediately. Keep the
  // placeholder only when there's no content yet — and let
  // `pickPlaceholderVariant` decide whether that's "syncing" or
  // "missing" based on a 5 s pending grace period.
  if (nextSnapshot === null) {
    const variant = pickPlaceholderVariant(node, status, nextSnapshot)
    showPlaceholder(node, true, variant)
    // Cache listener path runs outside SceneGraph.applyChanges, so it
    // must wake the render scheduler itself — the autoStart:false
    // (P12b) loop won't paint the placeholder swap otherwise. Skipped
    // when this container is part of a thumbnail render: the offscreen
    // thumbnail Pixi Application drives its own renderer, and waking
    // the main scheduler from here would force the main canvas to
    // upload offscreen-context textures (foreign-GL texSubImage2D).
    if (slots.thumbnail !== true) markRenderDirty()
    return
  }
  // First successful snapshot — clear pending bookkeeping.
  clearPendingTracking(node)

  // If the snapshot reference is identical to the cached one and not forced,
  // we still need to re-fit (instance bbox may have changed).
  const prevSnapshot = slots.snapshot ?? null
  const snapshotUnchanged = prevSnapshot === nextSnapshot
  if (snapshotUnchanged && !force) {
    // Pure transform refit — ensures resize handles update inner scale.
    if (slots.inner !== undefined) applyInnerFit(slots.inner, data, nextSnapshot)
    markRenderDirty()
    return
  }

  // Hide placeholder, show inner.
  showPlaceholder(node, false)

  let inner = slots.inner
  if (inner === undefined) {
    inner = new Container()
    setSlot(node, 'inner', inner)
    node.addChild(inner)
  }

  // prevList: prefer the previously-resolved list cached after the last
  // reconcile pass. Falls back to projecting prevSnapshot through the
  // CURRENT data only on the very first pass when no cache exists yet —
  // in that case the diff is harmless because the inner container has no
  // children mounted yet.
  const prevList: SlideObject[] =
    slots.lastResolvedList ??
    (prevSnapshot !== null ? projectSnapshotForInstance(prevSnapshot, data) : [])
  const nextList = projectSnapshotForInstance(nextSnapshot, data)

  const prevMap = slots.childMap ?? new Map<string, Container>()
  const registry = slots.thumbnail === true ? thumbnailRendererRegistry : rendererRegistry
  const { containers } = reconcileChildren(inner, prevMap, prevList, nextList, registry)
  setSlot(node, 'childMap', containers)
  setSlot(node, 'snapshot', nextSnapshot)
  setSlot(node, 'lastResolvedList', nextList)

  applyInnerFit(inner, data, nextSnapshot)
  // Same rationale as the placeholder branch above — main-scene render
  // scheduler must NOT be poked from a thumbnail render pass.
  if (slots.thumbnail !== true) markRenderDirty()
}

/**
 * Registry wrapper that swaps `mount` for `thumbnailMount` when the
 * inner renderer exposes one. Used by reconcileFromSnapshot when this
 * component-instance container is part of a thumbnail render — text
 * leaves and nested instances need the same "no main-scheduler poking,
 * no foreign-context texture upload" treatment as the outer thumbnail
 * mount path.
 */
const thumbnailRendererRegistry: { get(type: string): ReturnType<typeof rendererRegistry.get> } = {
  get(type: string) {
    const base = rendererRegistry.get(type)
    if (base === undefined) return undefined
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- registry is heterogeneous
    const tm = (base as any).thumbnailMount
    if (typeof tm !== 'function') return base
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- shallow clone preserves structural typing
    return { ...(base as any), mount: tm.bind(base) } as ReturnType<typeof rendererRegistry.get>
  },
}

function showPlaceholder(
  node: Container,
  visible: boolean,
  variant: PlaceholderVariant = 'syncing',
): void {
  const slots = getSlots(node)
  if (slots.placeholder !== undefined) slots.placeholder.visible = visible
  if (slots.label !== undefined) slots.label.visible = visible
  if (slots.inner !== undefined) slots.inner.visible = !visible
  // Re-paint the placeholder visuals to reflect the current variant.
  // Skip when invisible — drawing while hidden wastes a redraw and the
  // inner content is what's on screen.
  if (
    visible &&
    slots.placeholder !== undefined &&
    slots.label !== undefined &&
    slots.data !== undefined
  ) {
    drawPlaceholder(slots.placeholder, slots.label, slots.data, variant)
  }
}

/**
 * Decide which placeholder variant to show given the current cache state.
 *
 * - `pending` + no historic snapshot → start the "missing" timer; show
 *   `syncing` until it elapses, then `missing`.
 * - `synced` + null snapshot → master row exists in the cache but the doc
 *   is empty (server-side delete or empty master). Show `missing`
 *   immediately — no point waiting.
 *
 * The function also schedules a one-shot setTimeout that triggers a
 * re-paint when the missing window elapses while still pending. The timer
 * is colocated on the node via {@link setSlot} so it's reset / cleared on
 * detach without a side WeakMap.
 */
function pickPlaceholderVariant(
  node: Container,
  status: 'pending' | 'synced',
  snapshot: ComponentSnapshot | null,
): PlaceholderVariant {
  if (status === 'synced' && snapshot === null) {
    // Cache says synced but the master doc is empty — treat as missing.
    clearPendingTracking(node)
    return 'missing'
  }
  // status === 'pending' OR (synced && snapshot present, handled by caller)
  const slots = getSlots(node)
  const now = performance.now()
  const since = slots.pendingSince ?? now
  if (slots.pendingSince === undefined) {
    setSlot(node, 'pendingSince', since)
  }
  const elapsed = now - since
  if (elapsed >= MISSING_TIMEOUT_MS) {
    return 'missing'
  }
  // Schedule a re-paint exactly when the timeout would elapse, but only
  // if we don't already have a timer pending. The timer fires
  // reconcileFromSnapshot which re-enters this function; if status is
  // still pending it'll then return 'missing'.
  if (slots.missingTimer === undefined) {
    const handle = setTimeout(() => {
      setSlot(node, 'missingTimer', undefined)
      // Container may have been destroyed in the meantime — guard.
      if (node.destroyed) return
      reconcileFromSnapshot(node, false)
    }, MISSING_TIMEOUT_MS - elapsed) as unknown as number
    setSlot(node, 'missingTimer', handle)
  }
  return 'syncing'
}

/**
 * Drop the pending-tracking bookkeeping. Called once a snapshot lands or
 * when the node detaches; clearing the timer prevents a phantom re-paint
 * from firing after the node is gone.
 */
function clearPendingTracking(node: Container): void {
  const slots = getSlots(node)
  if (slots.missingTimer !== undefined) {
    clearTimeout(slots.missingTimer)
    setSlot(node, 'missingTimer', undefined)
  }
  if (slots.pendingSince !== undefined) {
    setSlot(node, 'pendingSince', undefined)
  }
}

// ---------------------------------------------------------------------------
// Cache subscription wiring
// ---------------------------------------------------------------------------

function attachToComponent(node: Container, componentId: string): void {
  acquireComponentDoc(componentId)
  setSlot(node, 'componentId', componentId)
  const unsubscribe = subscribeToComponentDoc(componentId, () => {
    reconcileFromSnapshot(node, false)
  })
  setSlot(node, 'unsubscribe', unsubscribe)
  // Best-effort initial pass — useful when the doc was already cached
  // and synced before this instance mounted.
  reconcileFromSnapshot(node, true)

  // Defensive catch-up: in some Hocuspocus / strict-mode interleavings
  // the cache's `update` observer fires before our subscribe lands —
  // the listener Set is still empty when the rAF flush runs, so the
  // first delivery is dropped. Re-poll on a couple of frames + a 250 ms
  // tick after subscribe so a freshly-acquired master that was already
  // synced (or that syncs within the next ~250 ms) can still flip the
  // placeholder to content without waiting for the user to interact.
  const recheck = () => {
    if (slotsHaveSnapshot(node)) return
    reconcileFromSnapshot(node, false)
  }
  requestAnimationFrame(recheck)
  requestAnimationFrame(() => requestAnimationFrame(recheck))
  window.setTimeout(recheck, 250)
  window.setTimeout(recheck, 750)
}

function slotsHaveSnapshot(node: Container): boolean {
  return getSlots(node).snapshot !== undefined
}

function detachFromComponent(node: Container): void {
  // Drop the missing-timer + pendingSince before tearing down so a fired
  // timer can't reach into a half-dismantled node.
  clearPendingTracking(node)
  const slots = getSlots(node)
  if (slots.unsubscribe !== undefined) {
    try {
      slots.unsubscribe()
    } catch {
      // ignore
    }
    setSlot(node, 'unsubscribe', undefined)
  }
  if (slots.componentId !== undefined) {
    releaseComponentDoc(slots.componentId)
    setSlot(node, 'componentId', undefined)
  }
}

function destroyChildren(node: Container): void {
  const slots = getSlots(node)
  const map = slots.childMap
  const inner = slots.inner
  if (map !== undefined && slots.snapshot !== undefined && slots.snapshot !== null) {
    const data = slots.data
    const list =
      data !== undefined ? projectSnapshotForInstance(slots.snapshot, data) : slots.snapshot.objects
    for (const obj of list) {
      const container = map.get(obj.id)
      if (container === undefined) continue
      const renderer = rendererRegistry.get(obj.type)
      try {
        renderer?.destroy(container)
      } catch {
        // ignore
      }
    }
  }
  if (inner !== undefined) {
    try {
      inner.destroy({ children: true })
    } catch {
      // ignore
    }
    setSlot(node, 'inner', undefined)
  }
  setSlot(node, 'childMap', undefined)
  setSlot(node, 'snapshot', undefined)
}

// ---------------------------------------------------------------------------
// Per-instance leaf lookup (M16 P8)
// ---------------------------------------------------------------------------

/**
 * Look up the per-instance Pixi child container for a master leaf id.
 *
 * The animation engine receives a "synthetic" target id of the shape
 * `instance:<instanceId>:<masterLeafId>` for steps coming from a
 * ComponentInstance's master animations. The target resolver maps that to
 * the live Pixi node by:
 *   1. Finding the instance container via SceneGraph.getNode(instanceId).
 *   2. Reading its childMap slot (master-leaf-id → Container).
 *
 * Both lookups are stable across reconciles: SceneGraph keeps the instance
 * container by its own object id (P5), and reconcileChildren keys the
 * inner childMap by leaf id (P6). The cached Pixi target proxy in the
 * resolver therefore stays valid as long as the instance + leaf both
 * survive a master edit.
 *
 * Returns null when the instance is mid-mount (no snapshot yet, no inner
 * container) or the leaf has been removed from the master tree. Callers
 * skip + warn rather than crashing — same contract as the slide-level
 * resolver.
 */
export function getInstanceLeafContainer(
  instanceContainer: Container,
  leafId: string,
): Container | null {
  const slots = getSlots(instanceContainer)
  const map = slots.childMap
  if (map === undefined) return null
  return map.get(leafId) ?? null
}

// ---------------------------------------------------------------------------
// Leaf hit-test helper (M16 P8)
// ---------------------------------------------------------------------------

/** Shared slack pad for instance-edit hit-testing — used by the leaf
 *  AABB check below AND by `EditorLayout`'s "is the click inside the
 *  active instance?" gate. Lines / arrows compute their own threshold
 *  from `strokeWidth`. */
export const INSTANCE_HIT_PAD = 5

/**
 * Given an instance container and slide-space coordinates, walk the instance's
 * child map and return the id of the first leaf whose local bounding box
 * contains the point — or null if none.
 *
 * The point is expressed in the ARTBOARD's coordinate system (slide space).
 * This helper converts it to each leaf container's local space via Pixi's
 * `toLocal()` to handle scale + rotate accurately.
 *
 * Hit order: last child in the childMap first (visual topmost-wins semantics;
 * the map insertion order follows master-object order which matches Pixi
 * z-order for the inner container).
 *
 * @param instanceContainer  The Pixi container returned by SceneGraph.getNode(instanceId).
 * @param slideX             Hit-test point X in slide coordinates.
 * @param slideY             Hit-test point Y in slide coordinates.
 * @param slideOriginX       SceneGraph's slide origin X (from bleedPx, typically 400).
 * @param slideOriginY       SceneGraph's slide origin Y.
 * @param resolvedLeaves     The master leaves already merged with overrides (position is
 *                           master-space; the inner container's transform maps them into
 *                           instance space). Pass resolvedLeaves so the AABB math uses the
 *                           effective (post-override) geometry.
 */
export function hitTestInstanceLeaf(
  instanceContainer: Container,
  slideX: number,
  slideY: number,
  slideOriginX: number,
  slideOriginY: number,
  resolvedLeaves: SlideObject[],
): string | null {
  const slots = getSlots(instanceContainer)
  const childMap = slots.childMap
  if (childMap === undefined || childMap.size === 0) return null

  // Build a lookup from leaf id → resolved SlideObject for width/height.
  const leafById = new Map<string, SlideObject>()
  for (const leaf of resolvedLeaves) {
    leafById.set(leaf.id, leaf)
  }

  // Pixi world-space point: slide coords + slide origin.
  const worldPt = { x: slideX + slideOriginX, y: slideY + slideOriginY }

  // Walk in reverse insertion order so visually topmost child wins.
  const ids = [...childMap.keys()].reverse()
  const localPt = new Point()
  for (const leafId of ids) {
    const leafContainer = childMap.get(leafId)
    if (leafContainer === undefined || leafContainer.destroyed) continue
    const leaf = leafById.get(leafId)
    if (leaf === undefined) continue

    leafContainer.toLocal(worldPt, undefined, localPt)

    // Lines / arrows have a degenerate AABB so use point-to-segment
    // distance with a generous slack pad — same convention as
    // SceneGraph.hitTest for top-level lines.
    if (leaf.type === 'line' || leaf.type === 'arrow') {
      const ld = leaf
      const threshold = Math.max(ld.strokeWidth / 2 + 6, 10)
      const dx = ld.p2.x - ld.p1.x
      const dy = ld.p2.y - ld.p1.y
      const lenSq = dx * dx + dy * dy
      let dist: number
      if (lenSq === 0) {
        const ex = localPt.x - ld.p1.x
        const ey = localPt.y - ld.p1.y
        dist = Math.sqrt(ex * ex + ey * ey)
      } else {
        const t = Math.max(
          0,
          Math.min(1, ((localPt.x - ld.p1.x) * dx + (localPt.y - ld.p1.y) * dy) / lenSq),
        )
        const px = ld.p1.x + t * dx
        const py = ld.p1.y + t * dy
        const ex = localPt.x - px
        const ey = localPt.y - py
        dist = Math.sqrt(ex * ex + ey * ey)
      }
      if (dist <= threshold) return leafId
      continue
    }

    // Leaf renderers draw their geometry from local (0,0) to (w,h) — the
    // pivot is set to (w/2, h/2) so the container ROTATES around its
    // centre, but local (0,0) is still the top-left of the rendered
    // content. INSTANCE_HIT_PAD widens the AABB so leaves flush with
    // the instance border stay grabbable.
    if (
      localPt.x >= -INSTANCE_HIT_PAD &&
      localPt.x <= leaf.width + INSTANCE_HIT_PAD &&
      localPt.y >= -INSTANCE_HIT_PAD &&
      localPt.y <= leaf.height + INSTANCE_HIT_PAD
    ) {
      return leafId
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Renderer implementation
// ---------------------------------------------------------------------------

function buildInstanceContainer(
  data: ComponentInstanceObject,
  opts: { thumbnail: boolean } = { thumbnail: false },
): Container {
  const container = new Container()
  const placeholder = new Graphics()
  const label = new Text({ style: makeLabelStyle() })
  label.anchor.set(0.5, 0.5)
  label.alpha = 0.85

  setSlot(container, 'placeholder', placeholder)
  setSlot(container, 'label', label)
  setSlot(container, 'data', data)
  if (opts.thumbnail) setSlot(container, 'thumbnail', true)

  drawPlaceholder(placeholder, label, data)
  container.addChild(placeholder)
  container.addChild(label)
  applyInstanceTransform(container, data)

  attachToComponent(container, data.componentId)
  return container
}

/** Maximum time the thumbnail renderer will wait for a master doc to sync
 *  before giving up and capturing whatever's on screen (placeholder). The
 *  thumbnail panel re-renders on every slide change anyway, so a missed
 *  thumbnail self-corrects on the next mutation — but a hung promise would
 *  freeze the entire panel queue. Keep this comfortably above typical WS
 *  round-trip + initial state delivery. */
const THUMBNAIL_SYNC_TIMEOUT_MS = 3_000

export const componentInstanceRenderer: ObjectRenderer<ComponentInstanceObject> = {
  type: 'componentInstance' as const,

  mount(data: ComponentInstanceObject): Container {
    return buildInstanceContainer(data)
  },

  /**
   * Thumbnail variant — same scene tree as `mount`, but exposes a ready-
   * promise that resolves once the master doc has produced its first
   * non-null snapshot (or after a short timeout). The thumbnail renderer
   * awaits this before capturing the PNG so cold-reload thumbnails don't
   * freeze the placeholder into the rasterised bitmap.
   */
  thumbnailMount(data: ComponentInstanceObject): Container {
    const container = buildInstanceContainer(data, { thumbnail: true })
    // If `attachToComponent`'s synchronous best-effort pass already
    // produced a snapshot (cache warm from a sibling instance), no wait
    // is needed — skip the promise.
    if (slotsHaveSnapshot(container)) return container

    const ready = new Promise<void>((resolve) => {
      let settled = false
      let unsub: (() => void) | null = null
      let timer: number | null = null
      const finish = (): void => {
        if (settled) return
        settled = true
        if (unsub !== null) {
          try {
            unsub()
          } catch {
            // ignore
          }
        }
        if (timer !== null) window.clearTimeout(timer)
        resolve()
      }
      unsub = subscribeToComponentDoc(data.componentId, () => {
        if (slotsHaveSnapshot(container)) finish()
      })
      // Snapshot may have landed between attachToComponent and subscribe
      // (rare but possible under warm-cache races) — re-check now.
      if (slotsHaveSnapshot(container)) {
        finish()
        return
      }
      timer = window.setTimeout(finish, THUMBNAIL_SYNC_TIMEOUT_MS)
    })
    setThumbnailReady(container, ready)
    return container
  },

  update(node: Container, prev: ComponentInstanceObject, next: ComponentInstanceObject): void {
    setSlot(node, 'data', next)
    const slots = getSlots(node)
    if (slots.placeholder !== undefined && slots.label !== undefined) {
      drawPlaceholder(slots.placeholder, slots.label, next)
    }
    applyInstanceTransform(node, next)

    // If the master changed, swap subscription.
    if (prev.componentId !== next.componentId) {
      detachFromComponent(node)
      destroyChildren(node)
      attachToComponent(node, next.componentId)
      return
    }

    // Re-reconcile so geometry / override changes propagate.
    reconcileFromSnapshot(node, true)
  },

  applyPatch(node: Container, patch: Partial<ComponentInstanceObject>): void {
    const slots = getSlots(node)
    const cached = slots.data
    if (cached === undefined) return

    const next: ComponentInstanceObject = { ...cached, ...patch }
    setSlot(node, 'data', next)

    const componentChanged =
      patch.componentId !== undefined && patch.componentId !== cached.componentId
    const overridesChanged = 'overrides' in patch
    const geometryChanged =
      patch.width !== undefined || patch.height !== undefined || 'componentName' in patch

    if (geometryChanged && slots.placeholder !== undefined && slots.label !== undefined) {
      drawPlaceholder(slots.placeholder, slots.label, next)
    }

    if (patch.x !== undefined) node.x = patch.x + node.pivot.x
    if (patch.y !== undefined) node.y = patch.y + node.pivot.y
    if (patch.rotation !== undefined) node.rotation = patch.rotation
    if (patch.opacity !== undefined) node.alpha = patch.opacity

    if (patch.width !== undefined || patch.height !== undefined) {
      const newPivotX = next.width / 2
      const newPivotY = next.height / 2
      const dataX = node.x - node.pivot.x
      const dataY = node.y - node.pivot.y
      node.pivot.set(newPivotX, newPivotY)
      node.x = dataX + newPivotX
      node.y = dataY + newPivotY
    }

    if (componentChanged) {
      detachFromComponent(node)
      destroyChildren(node)
      attachToComponent(node, next.componentId)
      return
    }

    if (geometryChanged || overridesChanged) {
      reconcileFromSnapshot(node, overridesChanged)
    }
  },

  destroy(node: Container): void {
    detachFromComponent(node)
    destroyChildren(node)
    const slots = getSlots(node)
    try {
      slots.placeholder?.destroy()
    } catch {
      // ignore
    }
    try {
      slots.label?.destroy()
    } catch {
      // ignore
    }
    try {
      node.destroy({ children: true })
    } catch {
      // ignore
    }
  },
}
