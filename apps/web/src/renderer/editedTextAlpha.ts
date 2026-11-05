/**
 * renderer/editedTextAlpha.ts — how faded a text is drawn while the edit
 * overlay shows it (SceneGraph.setTextNodeFaded, the table's cells).
 *
 * Not 0: Pixi skips a node whose alpha is 0 altogether — it is not drawn and
 * not rasterised again — so a character typed in edit mode reached the
 * canvas only after the overlay had gone, and the old text showed for the
 * frames the raster took (e2e/text-edit-transition.spec.ts). At 1/1024 the
 * node stays renderable and keeps its raster current, and draws nothing an
 * 8-bit target can show (a black glyph over white: 255 × (1 − 1/1024) rounds
 * to 255).
 */
export const EDITED_TEXT_ALPHA = 1 / 1024

/** Whether a node's alpha is the edited-text fade (or less). */
export function isEditedTextAlpha(alpha: number): boolean {
  return alpha <= EDITED_TEXT_ALPHA
}
