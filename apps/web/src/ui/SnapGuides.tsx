/**
 * ui/SnapGuides.tsx
 *
 * Vizualizace snap guide lines během dragu/resize.
 *
 * Renderuje DOM overlays pro každý aktivní SnapGuide:
 * - Vertical guide: 1px modrá svislá čára na X pozici
 * - Horizontal guide: 1px modrá vodorovná čára na Y pozici
 *
 * Zobrazí se jen pokud `guides` je neprázdný (volající skryje při pointerup).
 * `canvasBounds` — DOMRect canvas containeru, pro překlad world coords na CSS.
 */

import type { SnapGuide } from '../editor/snap.js'

interface SnapGuidesProps {
  guides: SnapGuide[]
  /** DOMRect canvas containeru — pro překlad world→CSS coords. */
  canvasWidth: number
  canvasHeight: number
}

export function SnapGuides({ guides, canvasWidth, canvasHeight }: SnapGuidesProps) {
  if (guides.length === 0) return null

  return (
    <>
      {guides.map((guide, i) => {
        if (guide.kind === 'vertical') {
          // Svislá čára na guide.position X, výška canvasHeight
          return (
            <div
              key={`v-${i}-${guide.position}`}
              aria-hidden="true"
              className="pointer-events-none absolute top-0 w-px bg-blue-400"
              style={{
                left: guide.position,
                height: canvasHeight,
                opacity: 0.8,
              }}
            />
          )
        } else {
          // Vodorovná čára na guide.position Y, šířka canvasWidth
          return (
            <div
              key={`h-${i}-${guide.position}`}
              aria-hidden="true"
              className="pointer-events-none absolute left-0 h-px bg-blue-400"
              style={{
                top: guide.position,
                width: canvasWidth,
                opacity: 0.8,
              }}
            />
          )
        }
      })}
    </>
  )
}
