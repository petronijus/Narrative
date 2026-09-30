/**
 * state/testApi.ts
 *
 * Dev-only helper that installs `window.__narrative_test_api` for Playwright.
 *
 * Why: the editor UI is too fragile to drive via locators (drag-to-resize,
 * right-click menus, modal confirms...). E2E specs instead seed reproducible
 * scenes in the live deck through this API, then navigate through the real
 * renderer and present-mode orchestrator to observe the result.
 *
 * Writes go through the command registry (ADR 0010), on a browser-host
 * context like `useCommand()`'s: the same validation, one `LOCAL_ORIGIN`
 * transaction per command, the same code path an agent takes. Objects keep
 * the ids a spec gives them (`object.create`'s `id`). Legacy states no
 * command creates any more — an animation step with the retired `onEnter`
 * trigger — are seeded by testApiLegacyFixtures.ts.
 *
 * Gated behind `import.meta.env.DEV` so the hook and its function references
 * never reach a production bundle.
 */

import {
  createDefaultRegistry,
  runCommandSync,
  runGroup,
  type CommandContext,
} from '@narrative/commands'
import {
  LOCAL_ORIGIN,
  getSlideObjectsCtx,
  listSlides,
  type SlideMutationContext,
} from '@narrative/slide-model'
import { seedLegacyAnimationStep } from './testApiLegacyFixtures.js'
import type { AnimationStep, Slide } from '@narrative/shared'

/**
 * Snapshot of the Selection context written by SelectionContext in DEV
 * builds so Playwright specs can read the current selection without
 * walking React internals.
 */
export interface SelectionSnapshot {
  selectedIds: string[]
}

export interface MagicMoveFixtureOptions {
  /** Transition duration on slide 2. Default 600 ms. */
  durationMs?: number
  /** Rectangle fill colour as a 24-bit RGB integer (e.g. 0x3b82f6). */
  fill?: number
  /** Shared object id used on both slides. Default 'e2e-rect'. */
  objectId?: string
  /** Slide 1 rectangle transform. */
  from?: { x?: number; y?: number; width?: number; height?: number; opacity?: number }
  /** Slide 2 rectangle transform (the target of the morph). */
  to?: { x?: number; y?: number; width?: number; height?: number; opacity?: number }
}

export interface AddRectOpts {
  id: string
  x: number
  y: number
  w: number
  h: number
  /** 24-bit RGB; the editor's default fill when omitted. */
  fill?: number
}

export interface AddImageOpts {
  id: string
  /** An asset of the deck (a spec uploads one with media.upload first). */
  assetId: string
  x: number
  y: number
  w: number
  h: number
  /** Crop source rect in ABSOLUTE slide coordinates (P11 crop model). */
  imageRect?: { x: number; y: number; width: number; height: number }
}

export interface TestApi {
  /**
   * Wipes existing slides and seeds a 2-slide deck with the same rectangle
   * id on both slides at different transforms, plus a Magic Move transition
   * on slide 2. Returns the slide ids ([from, to]).
   */
  seedMagicMoveFixture(opts?: MagicMoveFixtureOptions): { fromSlideId: string; toSlideId: string }
  /**
   * Stamp a rectangle onto the active slide with a known id + dimensions.
   * Used by E2E specs that need deterministic positions to hit-test.
   */
  addRect(opts: AddRectOpts, slideId?: string): void
  /**
   * Stamp an ImageObject, optionally cropped. No asset (`assetId: ''`), so
   * the renderer draws its placeholder — specs use it for geometry (a crop
   * must travel with its frame), not for pixels.
   */
  addImage(opts: AddImageOpts, slideId?: string): void
  /**
   * Append an animation step to a slide (default: the first) exactly as
   * stored — including legacy triggers such as `onEnter` — and return its
   * generated id.
   */
  addAnimation(step: Omit<AnimationStep, 'id'>, slideId?: string): string
  /**
   * P15: stamp a TextObject for font tests. Default font / weight /
   * color so the test only has to specify position + content.
   */
  addText(
    opts: {
      id: string
      x: number
      y: number
      w: number
      h: number
      text: string
      /** Frame default size; 32 when omitted. */
      fontSize?: number
      lineSpacing?: number
      wrap?: 'none'
      /** Size of the text's own runs (a formatted body at that size). */
      runFontSize?: number
    },
    slideId?: string,
  ): void
  /** Append a new slide to the deck. Returns its id. */
  addSlide(): string
  /** Ordered list of slide ids in the deck. */
  listSlideIds(): string[]
  /**
   * Full slide snapshots — id, objects, transition — as the slide model sees
   * them. Specs that compare two clients' state (multi-client-collab) need the
   * objects per slide in one read, so a poll cannot observe a half-applied
   * update the way `listSlideIds()` + a follow-up `objectIds()` can.
   */
  listSlides(): Slide[]
  /** Patch an object's geometry (used by tests to simulate drags). */
  updateObject(objectId: string, patch: Record<string, unknown>, slideId?: string): void
  /** Remove an object from the slide by id. */
  removeObject(objectId: string, slideId?: string): void
  /** Inspect object types on a slide. */
  debugObjectTypes(slideId?: string): { id: string; type: string }[]
  /** Ids of all objects on the given slide (default = first slide). */
  objectIds(slideId?: string): string[]
  /** Number of objects on the given slide. */
  objectCount(slideId?: string): number
  /** Current editor selection, as an array of ids. */
  getSelection(): string[]
  /**
   * Programmatically set the editor selection. Uses a window event so
   * the SelectionContext provider can pick it up without us having to
   * expose its setter globally.
   */
  setSelection(ids: string[]): void
  /** Enter the contenteditable text overlay for `objectId`, the way a
   *  double-click does. Synthesising that click is unreliable: the DOM overlay
   *  root sits above the canvas with `pointer-events: auto`, so the click never
   *  reaches Pixi's hit test. */
  beginTextEdit(objectId: string, opts?: { selectAll?: boolean }): void
  /** Leave text editing (equivalent to Escape). */
  endTextEdit(): void
  /**
   * Ids currently mounted in the Pixi SceneGraph. Must match the
   * Y.Array ids after the reconciler has caught up — a mismatch means
   * either a dropped id or a stale node, both of which manifest as
   * "can't click the object" in the editor.
   */
  sceneGraphIds(): string[]
  /**
   * True when the Pixi SceneGraph has a live node for this id and that
   * node's bounds are readable. Proxy for "the user could click this
   * object and the pointer handler would find it".
   */
  sceneGraphHasMountedNode(id: string): boolean
  /**
   * Order in which object containers sit on the Pixi root — from back
   * (lowest child index) to front (highest). Must match the Y.Array
   * order after a layer reorder; a mismatch means the visual render
   * contradicts the logical z-order.
   */
  sceneGraphChildOrder(): string[]
  /**
   * Read x,y directly from the live Y.Map for a given object on a slide.
   * Bypasses the React state and SceneGraph — lets specs compare
   * "what is in Y.Doc" vs "what Pixi is rendering" independently.
   * Returns null if the slide or object is not found.
   */
  getObjectPositionFromYDoc(objectId: string, slideId: string): { x: number; y: number } | null
  /**
   * Read the full object Y.Map as a plain JS snapshot. Used by specs
   * that need to introspect properties beyond x/y (e.g. text vAlign,
   * fontSize, height) to compare rendered vs editing layouts.
   */
  getObject(objectId: string, slideId?: string): Record<string, unknown> | null
}

declare global {
  interface Window {
    __narrative_test_api?: TestApi
    __narrative_selection_snapshot?: SelectionSnapshot
  }
}

/**
 * The live deck context the installed API operates on.
 *
 * The API object on `window` is installed once and never removed; what changes
 * underneath it is this context. React StrictMode mounts the deck provider
 * twice — the first Y.Doc is destroyed by the effect cleanup, and its
 * Hocuspocus `onSynced` can still land afterwards. Binding the API to the doc
 * that happened to install it meant a spec could write into a doc that was
 * already torn down: Y.Doc accepts the write silently, nothing renders and
 * nothing syncs, so the spec sees "object never mounted in the SceneGraph"
 * (observed intermittently in the e2e suite on 2026-09-09). Deleting the hook
 * on teardown only moved the problem — specs that had already waited for
 * `__narrative_test_api` then hit `undefined`. Retargeting keeps a single
 * stable object that always writes to whichever doc is currently live.
 */
let activeCtx: SlideMutationContext | null = null

function liveCtx(): SlideMutationContext {
  if (activeCtx === null) {
    throw new Error('test api: no live deck document (the provider is between mounts)')
  }
  return activeCtx
}

/**
 * One registry for the page's test hooks (definitions are stateless). Built in
 * dev builds only: SlideDocProvider imports this module in production too,
 * where `installTestApi` returns before anything would use it.
 */
const registry = import.meta.env.DEV ? createDefaultRegistry() : null

/**
 * The actor the hooks run commands as. Specs seed decks they own, and the
 * hooks never depended on the signed-in user's role, so they act as owner.
 */
const TEST_ACTOR: CommandContext['actor'] = {
  userId: 'e2e-test-api',
  role: 'owner',
  kind: 'human',
}

/** A browser-host command context on the live deck, as `useCommand()` builds it. */
function commandCtx(): CommandContext {
  return { actor: TEST_ACTOR, host: 'browser', origin: LOCAL_ORIGIN, deck: liveCtx() }
}

function commandRegistry(): NonNullable<typeof registry> {
  if (registry === null) throw new Error('test api: dev builds only')
  return registry
}

/** A 24-bit RGB integer as the `#rrggbb` a command takes. */
function hexColour(rgb: number): string {
  return `#${rgb.toString(16).padStart(6, '0')}`
}

/** Run one document command on the live deck: one transaction, one undo step. */
function run<T>(command: string, input: unknown): T {
  return runCommandSync(commandRegistry(), commandCtx(), command, input) as T
}

/** Run several commands as one transaction (one undo step, one update on the wire). */
function group<T>(fn: (run: <R>(command: string, input: unknown) => R) => T): T {
  return runGroup(commandRegistry(), commandCtx(), fn)
}

/** The slide a hook targets: `slideId`, else the first slide of the deck. */
function targetSlide(slideId: string | undefined, hook: string): string {
  const id = slideId ?? listSlides(liveCtx())[0]?.id
  if (id === undefined) throw new Error(`${hook}: no slide`)
  return id
}

/** Point the API at this deck's live Y.Doc. A destroyed doc is ignored. */
export function installTestApi(deckCtx: SlideMutationContext): void {
  if (!import.meta.env.DEV) return
  if (deckCtx.doc.isDestroyed) return
  activeCtx = deckCtx

  const api: TestApi = {
    seedMagicMoveFixture(opts = {}) {
      const objectId = opts.objectId ?? 'e2e-rect'
      const fill = opts.fill ?? 0x3b82f6
      const durationMs = opts.durationMs ?? 600
      const from = {
        x: opts.from?.x ?? 200,
        y: opts.from?.y ?? 400,
        width: opts.from?.width ?? 300,
        height: opts.from?.height ?? 200,
        opacity: opts.from?.opacity ?? 1,
      }
      const to = {
        x: opts.to?.x ?? 1200,
        y: opts.to?.y ?? 400,
        width: opts.to?.width ?? 300,
        height: opts.to?.height ?? 200,
        opacity: opts.to?.opacity ?? 1,
      }

      // Every slide goes; deleting the last one leaves a fresh empty slide,
      // which is where `landOn` points.
      const { landOn: fromSlideId } = run<{ landOn: string }>('slide.delete', {
        slides: listSlides(liveCtx()).map((s) => s.id),
      })

      run('object.create', {
        slide: fromSlideId,
        id: objectId,
        object: {
          type: 'rectangle',
          x: from.x,
          y: from.y,
          width: from.width,
          height: from.height,
          fill: hexColour(fill),
          opacity: from.opacity,
          rotation: 0,
        },
      })

      // The target slide the way an author makes one: a duplicate keeps the
      // object's id, which is what pairs it for Magic Move.
      const toSlideId = group((step) => {
        const { slideId } = step<{ slideId: string }>('slide.duplicate', { slide: fromSlideId })
        step('object.update', {
          slide: slideId,
          object: objectId,
          patch: { x: to.x, y: to.y, width: to.width, height: to.height, opacity: to.opacity },
        })
        step('slide.setTransition', { slide: slideId, kind: 'magic', durationMs })
        return slideId
      })

      return { fromSlideId, toSlideId }
    },
    addSlide() {
      return run<{ slideId: string }>('slide.add', {}).slideId
    },
    listSlideIds() {
      return listSlides(liveCtx()).map((s) => s.id)
    },
    listSlides() {
      return listSlides(liveCtx())
    },
    debugObjectTypes(slideId) {
      const sid = slideId ?? listSlides(liveCtx())[0]?.id
      if (sid === undefined) return []
      const ctx = getSlideObjectsCtx(liveCtx(), sid)
      if (ctx === null) return []
      const out: { id: string; type: string }[] = []
      for (let i = 0; i < ctx.objects.length; i++) {
        const m = ctx.objects.get(i)
        out.push({
          id: m.get('id') as string,
          type: m.get('type') as string,
        })
      }
      return out
    },
    updateObject(objectId, patch, slideId) {
      // object.update patches a text body in place (the Y.Text keeps its
      // CRDT identity), so a spec's text edit syncs like a typed one.
      run('object.update', {
        slide: targetSlide(slideId, 'updateObject'),
        object: objectId,
        patch,
      })
    },
    removeObject(objectId, slideId) {
      run('object.delete', { slide: targetSlide(slideId, 'removeObject'), objects: [objectId] })
    },
    addRect(opts, slideId) {
      run('object.create', {
        slide: targetSlide(slideId, 'addRect'),
        id: opts.id,
        object: {
          type: 'rectangle',
          x: opts.x,
          y: opts.y,
          width: opts.w,
          height: opts.h,
          ...(opts.fill !== undefined ? { fill: hexColour(opts.fill) } : {}),
          opacity: 1,
          rotation: 0,
        },
      })
    },
    addAnimation(step, slideId) {
      const slide = targetSlide(slideId, 'addAnimation')
      // A step with the retired `onEnter` trigger is what older decks and
      // PowerPoint imports hold; no command writes one any more, so it is
      // seeded as legacy data (testApiLegacyFixtures.ts).
      if (step.trigger === 'onEnter') return seedLegacyAnimationStep(liveCtx(), slide, step)
      return run<{ animationId: string }>('animation.add', {
        slide,
        object: step.objectId,
        preset: step.preset,
        trigger: step.trigger,
        duration: step.duration,
        delay: step.delay,
        easing: step.easing,
        ...(step.params !== undefined ? { params: step.params } : {}),
      }).animationId
    },
    addImage(opts, slideId) {
      run('object.create', {
        slide: targetSlide(slideId, 'addImage'),
        id: opts.id,
        object: {
          type: 'image',
          assetId: opts.assetId,
          x: opts.x,
          y: opts.y,
          width: opts.w,
          height: opts.h,
          opacity: 1,
          rotation: 0,
          ...(opts.imageRect !== undefined ? { imageRect: { ...opts.imageRect } } : {}),
        },
      })
    },
    addText(opts, slideId) {
      // One paragraph per line; a run size makes each line one sized run.
      const paragraphs = opts.text
        .split('\n')
        .map((line) =>
          opts.runFontSize === undefined
            ? { text: line }
            : { runs: [{ text: line, fontSize: opts.runFontSize }] },
        )
      run('object.create', {
        slide: targetSlide(slideId, 'addText'),
        id: opts.id,
        object: {
          type: 'text',
          x: opts.x,
          y: opts.y,
          width: opts.w,
          height: opts.h,
          text: { paragraphs },
          ...(opts.lineSpacing !== undefined ? { lineSpacing: opts.lineSpacing } : {}),
          ...(opts.wrap !== undefined ? { wrap: opts.wrap } : {}),
          fontSize: opts.fontSize ?? 32,
          fontWeight: 400,
          color: '#000000',
          align: 'left',
          rotation: 0,
          opacity: 1,
        },
      })
    },
    objectIds(slideId) {
      const targetSlideId = slideId ?? listSlides(liveCtx())[0]?.id
      if (targetSlideId === undefined) return []
      const ctx = getSlideObjectsCtx(liveCtx(), targetSlideId)
      if (ctx === null) return []
      const out: string[] = []
      for (let i = 0; i < ctx.objects.length; i++) {
        out.push(ctx.objects.get(i).get('id') as string)
      }
      return out
    },
    objectCount(slideId) {
      const targetSlideId = slideId ?? listSlides(liveCtx())[0]?.id
      if (targetSlideId === undefined) return 0
      const ctx = getSlideObjectsCtx(liveCtx(), targetSlideId)
      return ctx === null ? 0 : ctx.objects.length
    },
    getSelection() {
      return window.__narrative_selection_snapshot?.selectedIds ?? []
    },
    setSelection(ids) {
      window.dispatchEvent(
        new CustomEvent('narrative:test-set-selection', { detail: { ids: [...ids] } }),
      )
    },
    beginTextEdit(objectId, opts) {
      window.dispatchEvent(
        new CustomEvent('narrative:test-begin-text-edit', {
          detail: { id: objectId, selectAll: opts?.selectAll === true },
        }),
      )
    },
    endTextEdit() {
      window.dispatchEvent(new CustomEvent('narrative:test-end-text-edit'))
    },
    sceneGraphIds() {
      const sg = (
        window as unknown as { __narrative_scene_graph?: { getMountedIds: () => string[] } }
      ).__narrative_scene_graph
      return sg?.getMountedIds() ?? []
    },
    sceneGraphHasMountedNode(id) {
      const sg = (
        window as unknown as {
          __narrative_scene_graph?: {
            getBounds: (id: string) => unknown
            getMountedIds: () => string[]
          }
        }
      ).__narrative_scene_graph
      if (sg === undefined) return false
      if (!sg.getMountedIds().includes(id)) return false
      return sg.getBounds(id) !== null
    },
    sceneGraphChildOrder() {
      const sg = (
        window as unknown as {
          __narrative_scene_graph?: {
            getRoot: () => { children: Array<{ label?: string }> }
            getMountedIds: () => string[]
            getContainer: (id: string) => { children: Array<unknown> } | undefined
          }
        }
      ).__narrative_scene_graph
      if (sg === undefined) return []
      const root = sg.getRoot()
      const mounted = sg.getMountedIds()
      const containerToId = new Map<unknown, string>()
      for (const id of mounted) {
        const c = sg.getContainer(id)
        if (c !== undefined) containerToId.set(c, id)
      }
      const out: string[] = []
      for (const child of root.children) {
        const id = containerToId.get(child)
        if (id !== undefined) out.push(id)
      }
      return out
    },
    getObjectPositionFromYDoc(objectId, slideId) {
      for (let i = 0; i < liveCtx().slides.length; i++) {
        const slideMap = liveCtx().slides.get(i)
        if ((slideMap.get('id') as string) !== slideId) continue
        // Found the slide — walk objects array
        const objectsArr = slideMap.get('objects') as {
          length: number
          get: (i: number) => {
            get: (k: string) => unknown
            entries: () => Iterable<[string, unknown]>
          }
        }
        for (let j = 0; j < objectsArr.length; j++) {
          const objMap = objectsArr.get(j)
          if ((objMap.get('id') as string) === objectId) {
            return {
              x: objMap.get('x') as number,
              y: objMap.get('y') as number,
            }
          }
        }
        return null // slide found, object not found
      }
      return null // slide not found
    },
    getObject(objectId, slideId) {
      const targetSlideId = slideId ?? listSlides(liveCtx())[0]?.id
      if (targetSlideId === undefined) return null
      for (let i = 0; i < liveCtx().slides.length; i++) {
        const slideMap = liveCtx().slides.get(i)
        if ((slideMap.get('id') as string) !== targetSlideId) continue
        const objectsArr = slideMap.get('objects') as {
          length: number
          get: (i: number) => {
            get: (k: string) => unknown
            toJSON: () => Record<string, unknown>
          }
        }
        for (let j = 0; j < objectsArr.length; j++) {
          const objMap = objectsArr.get(j)
          if ((objMap.get('id') as string) === objectId) {
            return objMap.toJSON()
          }
        }
        return null
      }
      return null
    },
  }

  window.__narrative_test_api = api
}

/**
 * Detach the API from a doc that is being destroyed. A no-op once a newer doc
 * has taken the slot. The `window` hook stays in place — calls made in the gap
 * throw a named error instead of silently writing into a dead document.
 */
export function uninstallTestApi(doc: SlideMutationContext['doc']): void {
  if (!import.meta.env.DEV) return
  if (activeCtx?.doc !== doc) return
  activeCtx = null
}
