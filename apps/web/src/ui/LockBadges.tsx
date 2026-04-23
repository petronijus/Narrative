/**
 * ui/LockBadges.tsx
 *
 * P5a: small padlock glyph rendered in the top-left corner of every locked
 * object so the author sees the lock state without opening the Inspector.
 * DOM overlay (not Pixi) — same pattern as PeerSelectionOverlays. Re-renders
 * on the `objects` list from `useSlideObjects`; by the time React paints,
 * SceneGraph.getBounds already reflects the latest transform.
 */

import { Lock } from 'lucide-react'
import { useCanvasInstance } from '../renderer/CanvasInstanceContext.js'
import { useSlideObjects } from '../state/useSlideObjects.js'
import { useZoomLevel } from '../state/useZoomLevel.js'

const BADGE_SIZE = 16

export function LockBadges() {
  const { objects } = useSlideObjects()
  const canvasInstance = useCanvasInstance()
  const { zoom } = useZoomLevel()
  if (canvasInstance === null) return null

  const { sceneGraph } = canvasInstance
  // Positioned by slide-space bounds inside the scaled artboard — invert
  // the scale so the padlock stays at a constant SCREEN size.
  const inv = 1 / (zoom || 1)
  const badges: Array<{ id: string; x: number; y: number }> = []
  for (const obj of objects) {
    if (obj.locked !== true) continue
    const bounds = sceneGraph.getBounds(obj.id)
    if (bounds === null) continue
    badges.push({
      id: obj.id,
      x: bounds.world.x,
      y: bounds.world.y,
    })
  }
  if (badges.length === 0) return null

  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0">
      {badges.map(({ id, x, y }) => (
        <div
          key={id}
          className="absolute flex items-center justify-center rounded bg-foreground/80 text-background shadow"
          style={{
            left: x,
            top: y,
            width: BADGE_SIZE,
            height: BADGE_SIZE,
            transform: `translate(-50%, -50%) scale(${inv})`,
            transformOrigin: 'center',
          }}
        >
          <Lock size={10} strokeWidth={2.5} />
        </div>
      ))}
    </div>
  )
}
