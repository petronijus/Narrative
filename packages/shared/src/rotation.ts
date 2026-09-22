/**
 * shared/src/rotation.ts
 *
 * `SlideObject.rotation` is in **radians**, clockwise, about the object's
 * centre — the unit Pixi's `Container.rotation` takes directly and the one
 * the Inspector converts to and from degrees for display. File formats speak
 * degrees (PPTX `<a:xfrm rot>` is 60 000ths of a degree; pptxgenjs `rotate`
 * takes degrees), so every import and export boundary goes through these two
 * functions instead of passing the number across unconverted. An importer
 * that wrote degrees straight into `rotation` made a −7° label render at
 * +64° (352.97 rad ≡ 1.11 rad) while the exporter, reading the same field as
 * degrees, round-tripped it unchanged — each half hiding the other's bug.
 */

const TWO_PI = 2 * Math.PI

/**
 * Degrees (any range) → the model's radians, normalised to (−π, π] so a
 * PPTX `rot` of 352.97° lands as −7.03° in the Inspector rather than 352.97°.
 */
export function rotationFromDegrees(degrees: number): number {
  if (!Number.isFinite(degrees)) return 0
  let rad = ((degrees % 360) * Math.PI) / 180
  if (rad <= -Math.PI) rad += TWO_PI
  else if (rad > Math.PI) rad -= TWO_PI
  return rad
}

/**
 * The model's radians → degrees normalised to [0, 360), the range PPTX
 * `<a:xfrm rot>` is defined over.
 */
export function rotationToDegrees(radians: number): number {
  if (!Number.isFinite(radians)) return 0
  const deg = ((radians * 180) / Math.PI) % 360
  return deg < 0 ? deg + 360 : deg
}
