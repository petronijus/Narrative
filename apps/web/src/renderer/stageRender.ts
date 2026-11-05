/**
 * renderer/stageRender.ts — how an application's stage is drawn into its
 * canvas: the editor canvas draws one region of its world (canvasRegion.ts),
 * moved into the canvas by a render transform; every other canvas draws its
 * world from (0, 0).
 *
 * A render transform, not the stage's own position: it applies while the
 * frame is drawn only (Pixi's `render({ container, transform })`), so world
 * coordinates — `toGlobal`, `getBounds`, what the overlays and the hit test
 * read — stay what they are wherever the region is.
 */

import type { Application, Matrix } from 'pixi.js'

const transforms = new WeakMap<Application, Matrix>()

/** Draw `app`'s stage through `transform` from now on (null: from the world's origin). */
export function setStageRenderTransform(app: Application, transform: Matrix | null): void {
  if (transform === null) transforms.delete(app)
  else transforms.set(app, transform)
}

/** The transform `app`'s stage is drawn through (null: none). */
export function stageRenderTransform(app: Application): Matrix | null {
  return transforms.get(app) ?? null
}

/** Draw `app`'s stage into its canvas (RenderScheduler, and the ticker while a timeline plays). */
export function renderStage(app: Application): void {
  const transform = transforms.get(app)
  if (transform === undefined) app.renderer.render(app.stage)
  else app.renderer.render({ container: app.stage, transform })
}
