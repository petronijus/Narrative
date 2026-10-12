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
 *
 * Autofit (A4.2): a `shrink` box is measured as drawn, at the scale the
 * renderer shrank its type to — it overflows only when the text does not
 * fit even at its minimum size. A `grow-down` box is as tall as its text,
 * so it never overflows itself; whether it runs past the region its layout
 * gives it is the brand checker's question once slides have layouts (A4.4).
 */

import type { GrownText, SlideObject, TextOverflow } from '@narrative/shared'
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
    if (object.type !== 'text' || object.autofit === 'grow-down') continue
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

/**
 * The height each growing text box of the shown slide is drawn at (A4.5,
 * the brand checker's fit rule: a growing box against the region below).
 */
export function measureGrownText(
  sceneGraph: Pick<SceneGraph, 'getNode'>,
  objects: readonly SlideObject[],
  slideId: string,
): GrownText[] {
  const out: GrownText[] = []
  for (const object of objects) {
    if (object.type !== 'text' || object.autofit !== 'grow-down') continue
    const node = sceneGraph.getNode(object.id)
    if (node === undefined) continue
    const bottom = laidOutTextBottom(node.container, object)
    if (bottom === null) continue
    out.push({ slideId, objectId: object.id, height: Math.round(bottom) })
  }
  return out
}
