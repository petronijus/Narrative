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

export interface MagicMoveFixtureOptions {
  /** Transition duration on slide 2. Default 600 ms. */
  durationMs?: number
  /** Rectangle fill colour (e.g. '#3b82f6'). Default blue. */
  fill?: string
  /** Shared object id used on both slides. Default 'e2e-rect'. */
  objectId?: string
  /** Slide 1 rectangle transform. */
  from?: { x?: number; y?: number; width?: number; height?: number; opacity?: number }
  /** Slide 2 rectangle transform (the target of the morph). */
  to?: { x?: number; y?: number; width?: number; height?: number; opacity?: number }
}

export interface TestApi {
  /**
   * Wipes existing slides and seeds a 2-slide deck with the same rectangle
   * id on both slides at different transforms, plus a Magic Move transition
   * on slide 2. Returns the slide ids ([from, to]).
   */
  seedMagicMoveFixture(opts?: MagicMoveFixtureOptions): { fromSlideId: string; toSlideId: string }
}

declare global {
  interface Window {
    __narrative_test_api?: TestApi
  }
}

export function installTestApi(deckCtx: SlideMutationContext): void {
  if (!import.meta.env.DEV) return

  const api: TestApi = {
    seedMagicMoveFixture(opts = {}) {
      const objectId = opts.objectId ?? 'e2e-rect'
      const fill = opts.fill ?? '#3b82f6'
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
  }

  window.__narrative_test_api = api
}
