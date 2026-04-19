/**
 * renderer/coords.ts
 *
 * World↔screen coordinate transforms s DPR compensation.
 *
 * KRITICKÝ POZNATEK ze Spike C:
 * Pixi v8 s resolution=devicePixelRatio a autoDensity=true interně škáluje stage
 * hodnotou DPR. container.toGlobal() vrací souřadnice v *physical* pixelech
 * (Pixi render space), nikoliv v CSS logical pixelech. CSS translate() pracuje
 * v logical pixelech — bez DPR division vzniká 2× offset na HiDPI displayích.
 *
 * Formula: cssX = physicalX / devicePixelRatio
 *
 * Toto musí být zachováno ve všech budoucích DOM overlay implementacích (M2+).
 */

import type { Container } from 'pixi.js'

/** Fyzické pixely → CSS logical pixely */
export function worldToScreen(
  pixiGlobal: { x: number; y: number },
  dpr: number,
): { x: number; y: number } {
  return {
    x: pixiGlobal.x / dpr,
    y: pixiGlobal.y / dpr,
  }
}

/**
 * CSS logical pixely → Pixi world souřadnice.
 * Inverzní transform k worldToScreen.
 * Použití: převod mouse event pozice na canvas souřadnice.
 */
export function screenToWorld(
  screen: { x: number; y: number },
  container: Container,
  dpr: number,
): { x: number; y: number } {
  // Fyzické pixely = CSS logical × DPR
  const physical = { x: screen.x * dpr, y: screen.y * dpr }

  // Inverzní world transform — přetransformuje z global render space do container local space
  const worldTransform = container.worldTransform
  const inverted = worldTransform.clone()
  inverted.invert()

  return inverted.apply(physical)
}
