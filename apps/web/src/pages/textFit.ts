/**
 * pages/textFit.ts — which text boxes of the shown slide overflow, measured
 * on the render page with the real fonts (agentic A3.6; plan §4.6 "text-fit
 * measurement", the input of the brand checker's fit rule).
 *
 * A text box overflows when its laid-out text — wrapped by the browser in
 * the box's width, in the faces the folder supplies, placed by its vertical
 * alignment — ends below the box (textRenderer `laidOutTextBottom`: the
 * block of lines, the PowerPoint line offset within them taken out).
 * Measured after the slide settled, so every raster has landed in its final
 * fonts. Groups are flat on the slide (a `groupId` on each member), so every
 * text box is a node of its own in the scene graph. Table cells are not
 * measured: a cell grows its row instead of overflowing.
 */

import type { SlideObject, TextOverflow } from '@narrative/shared'
import type { SceneGraph } from '../renderer/SceneGraph.js'
import { laidOutTextBottom } from '../renderer/objectRenderers/textRenderer.js'

/** Rounding between the measured block and a box sized to it exactly. */
const TOLERANCE_PX = 1

export function measureTextOverflow(
  sceneGraph: Pick<SceneGraph, 'getNode'>,
  objects: readonly SlideObject[],
  slideId: string,
): TextOverflow[] {
  const out: TextOverflow[] = []
  for (const object of objects) {
    if (object.type !== 'text') continue
    const node = sceneGraph.getNode(object.id)
    if (node === undefined) continue
    const bottom = laidOutTextBottom(node.container, object)
    if (bottom === null || bottom <= object.height + TOLERANCE_PX) continue
    out.push({
      slideId,
      objectId: object.id,
      boxHeight: Math.round(object.height),
      textHeight: Math.round(bottom),
    })
  }
  return out
}
