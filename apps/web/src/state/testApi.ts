/**
 * state/testApi.ts
 *
 * Dev-only helper that installs `window.__narrative_test_api` for Playwright.
 *
 * Why: the editor UI is too fragile to drive via locators (drag-to-resize,
 * right-click menus, modal confirms...). E2E specs instead mutate the live
 * Y.Doc directly through this API to seed reproducible scenes, then navigate
 * through the real renderer and present-mode orchestrator to observe the
 * result.
 *
 * Gated behind `import.meta.env.DEV` so the hook and its function references
 * never reach a production bundle.
 */

import {
  LOCAL_ORIGIN,
  addObject,
  addSlide,
  getSlideObjectsCtx,
  listSlides,
  removeSlide,
  updateSlideTransition,
  type SlideMutationContext,
} from '@narrative/slide-model'

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
  fill: number
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
  /** Append a new slide to the deck. Returns its id. */
  addSlide(): string
  /** Ordered list of slide ids in the deck. */
  listSlideIds(): string[]
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
}

declare global {
  interface Window {
    __narrative_test_api?: TestApi
    __narrative_selection_snapshot?: SelectionSnapshot
  }
}

export function installTestApi(deckCtx: SlideMutationContext): void {
  if (!import.meta.env.DEV) return

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

      deckCtx.doc.transact(() => {
        for (const s of listSlides(deckCtx)) {
          // removeSlide auto-replaces when emptying — ignore, we'll add ours
          // and end up with 2 seeded slides plus at most one stale empty.
          removeSlide(deckCtx, s.id)
        }
      }, LOCAL_ORIGIN)

      // After the loop, deck has exactly one empty slide (removeSlide seeds
      // a fresh one when emptying). We replace both its content and add a
      // second slide.
      const existing = listSlides(deckCtx)
      const fromSlideId = existing[0]?.id ?? addSlide(deckCtx).id
      const toSlide = addSlide(deckCtx)
      const toSlideId = toSlide.id

      const fromCtx = getSlideObjectsCtx(deckCtx, fromSlideId)
      const toCtx = getSlideObjectsCtx(deckCtx, toSlideId)
      if (fromCtx === null || toCtx === null) {
        throw new Error('seedMagicMoveFixture: slide object context not found')
      }

      addObject(fromCtx, {
        id: objectId,
        type: 'rectangle',
        x: from.x,
        y: from.y,
        width: from.width,
        height: from.height,
        fill,
        opacity: from.opacity,
        rotation: 0,
      })
      addObject(toCtx, {
        id: objectId,
        type: 'rectangle',
        x: to.x,
        y: to.y,
        width: to.width,
        height: to.height,
        fill,
        opacity: to.opacity,
        rotation: 0,
      })

      updateSlideTransition(deckCtx, toSlideId, { kind: 'magic', durationMs })

      return { fromSlideId, toSlideId }
    },
    addSlide() {
      return addSlide(deckCtx).id
    },
    listSlideIds() {
      return listSlides(deckCtx).map((s) => s.id)
    },
    addRect(opts, slideId) {
      const targetSlideId = slideId ?? listSlides(deckCtx)[0]?.id
      if (targetSlideId === undefined) throw new Error('addRect: no slide')
      const ctx = getSlideObjectsCtx(deckCtx, targetSlideId)
      if (ctx === null) throw new Error('addRect: slide ctx not found')
      addObject(ctx, {
        id: opts.id,
        type: 'rectangle',
        x: opts.x,
        y: opts.y,
        width: opts.w,
        height: opts.h,
        fill: opts.fill,
        opacity: 1,
        rotation: 0,
      })
    },
    objectIds(slideId) {
      const targetSlideId = slideId ?? listSlides(deckCtx)[0]?.id
      if (targetSlideId === undefined) return []
      const ctx = getSlideObjectsCtx(deckCtx, targetSlideId)
      if (ctx === null) return []
      const out: string[] = []
      for (let i = 0; i < ctx.objects.length; i++) {
        out.push(ctx.objects.get(i).get('id') as string)
      }
      return out
    },
    objectCount(slideId) {
      const targetSlideId = slideId ?? listSlides(deckCtx)[0]?.id
      if (targetSlideId === undefined) return 0
      const ctx = getSlideObjectsCtx(deckCtx, targetSlideId)
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
  }

  window.__narrative_test_api = api
}
