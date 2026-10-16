/**
 * ui/LockBadges.tsx
 *
 * P5a: small padlock glyph rendered in the top-left corner of every locked
 * object so the author sees the lock state without opening the Inspector.
 * DOM overlay (not Pixi) — same pattern as PeerSelectionOverlays. Re-renders
 * on the `objects` list from `useSlideObjects`; by the time React paints,
 * SceneGraph.getBounds already reflects the latest transform.
 *
 * Also renders a dashed selection outline for any LOCKED object that is in
 * the local selection. Locked objects are filtered out of the editable set
 * before TransformHandles renders, so without this overlay the user gets
 * no visual confirmation that the locked object is actually selected.
 */

import { Lock } from 'lucide-react'
import { useCanvasInstance } from '../renderer/CanvasInstanceContext.js'
import { useSlideObjects } from '../state/useSlideObjects.js'
import { useSelection } from '../state/SelectionContext.js'
import { useZoomLevel } from '../state/useZoomLevel.js'
import type { ObjectBounds } from '../renderer/types.js'
import { useTextLayoutTick } from './useTextLayoutTick.js'

const BADGE_SIZE = 16

function cornersToPoints(corners: ObjectBounds['corners']): string {
  return corners.map(({ x, y }) => `${x},${y}`).join(' ')
}

export function LockBadges() {
  const { objects } = useSlideObjects()
  const { selectedIds } = useSelection()
  const canvasInstance = useCanvasInstance()
  const { zoom } = useZoomLevel()
  useTextLayoutTick(canvasInstance?.sceneGraph ?? null)
  if (canvasInstance === null) return null

  const { sceneGraph } = canvasInstance
  // Positioned by slide-space bounds inside the scaled artboard — invert
  // the scale so the padlock stays at a constant SCREEN size.
  const inv = 1 / (zoom || 1)
  const badges: Array<{ id: string; x: number; y: number }> = []
  const selectedOutlines: Array<{ id: string; corners: ObjectBounds['corners'] }> = []
  for (const obj of objects) {
    if (obj.locked !== true) continue
    const bounds = sceneGraph.getBounds(obj.id)
    if (bounds === null) continue
    badges.push({
      id: obj.id,
      x: bounds.world.x,
      y: bounds.world.y,
    })
    if (selectedIds.has(obj.id)) {
      selectedOutlines.push({ id: obj.id, corners: bounds.corners })
    }
  }
  if (badges.length === 0 && selectedOutlines.length === 0) return null

  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0">
      {selectedOutlines.length > 0 && (
        <svg
          aria-hidden="true"
          className="pointer-events-none absolute inset-0"
          style={{ overflow: 'visible' }}
        >
          {selectedOutlines.map(({ id, corners }) => (
            <polygon
              key={`outline-${id}`}
              points={cornersToPoints(corners)}
              fill="none"
              // Muted slate so it reads as "selected but not editable",
              // distinct from the active blue handles outline.
              stroke="#94a3b8"
              strokeWidth={1.5 * inv}
              strokeDasharray={`${4 * inv} ${3 * inv}`}
              strokeLinejoin="round"
              opacity={0.95}
            />
          ))}
        </svg>
      )}
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
