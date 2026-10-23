/**
 * ui/EditorShowOverlay.tsx
 *
 * The visible half of `editor.show` (agentic A1) — see useEditorShow.ts.
 *
 * - `EditorShowHighlight`: a pulsing outline around the objects an agent
 *   pointed at, for SHOW_HIGHLIGHT_MS from the moment it can be drawn (the
 *   objects may mount a little after the slide switch). A DOM/SVG overlay positioned from
 *   SceneGraph bounds, the same pattern as PeerSelectionOverlays (no Pixi
 *   mutation outside the renderer). With reduced motion it is a static
 *   outline for the same time.
 * - `EditorShowNotice`: shown instead of jumping when the user is in a
 *   modal edit; offers to go there.
 */

import { useEffect } from 'react'
import { Bot } from 'lucide-react'
import { useCanvasInstance } from '../renderer/CanvasInstanceContext.js'
import type { ObjectBounds } from '../renderer/types.js'
import { useActiveSlideObjectFieldsById } from '../state/useDeckStore.js'
import { useZoomLevel } from '../state/useZoomLevel.js'
import { Button } from '@/components/ui/button'
import { SHOW_HIGHLIGHT_MS, type PendingShow, type ShowHighlight } from './useEditorShow.js'
import { useBoundsSettled } from './useBoundsSettled.js'
import { useTextLayoutTick } from './useTextLayoutTick.js'

/** Gap between the object and the outline, in screen pixels. */
const OUTLINE_GAP_PX = 6
/** Wait up to ~10 s at 60 Hz for the objects to mount (see HIGHLIGHT_WAIT_MS). */
const MOUNT_WAIT_FRAMES = 600

function outlinePoints(bounds: ObjectBounds, offset: number): string {
  return bounds.corners
    .map(({ x, y }) => {
      const dx = x - bounds.center.x
      const dy = y - bounds.center.y
      const len = Math.hypot(dx, dy)
      if (len === 0) return `${x},${y}`
      return `${x + (dx / len) * offset},${y + (dy / len) * offset}`
    })
    .join(' ')
}

interface EditorShowHighlightProps {
  highlight: ShowHighlight | null
  /** Called SHOW_HIGHLIGHT_MS after the outline was first drawn. */
  onDone: (token: number) => void
}

const NO_IDS: string[] = []

export function EditorShowHighlight({ highlight, onDone }: EditorShowHighlightProps) {
  const canvasInstance = useCanvasInstance()
  const { zoom } = useZoomLevel()
  // Re-render as the highlighted objects' fields change, so the outline
  // tracks an object that moves while it is up — bounds come from the scene
  // graph (a growing text box also changes them without a document change,
  // and typing changes no field) …
  useActiveSlideObjectFieldsById(highlight?.objectIds ?? NO_IDS)
  useTextLayoutTick(canvasInstance?.sceneGraph ?? null)
  // … and once the reconciler has mounted the objects of a slide we just
  // switched to (it lags the switch; on a loading tab, by seconds).
  useBoundsSettled(
    canvasInstance?.sceneGraph ?? null,
    highlight?.objectIds ?? [],
    MOUNT_WAIT_FRAMES,
  )

  const inv = 1 / (zoom || 1)
  const outlines =
    highlight === null || canvasInstance === null
      ? []
      : highlight.objectIds.flatMap((id) => {
          const bounds = canvasInstance.sceneGraph.getBounds(id)
          return bounds === null
            ? []
            : [{ id, points: outlinePoints(bounds, OUTLINE_GAP_PX * inv) }]
        })
  const drawn = outlines.length > 0
  const token = highlight?.token ?? null

  // The highlight's time starts when it is drawn — the same moment its CSS
  // animation starts.
  useEffect(() => {
    if (!drawn || token === null) return
    const t = setTimeout(() => onDone(token), SHOW_HIGHLIGHT_MS)
    return () => clearTimeout(t)
  }, [drawn, token, onDone])

  if (highlight === null || !drawn) return null

  return (
    <svg
      aria-hidden="true"
      data-testid="editor-show-highlight"
      data-object-ids={highlight.objectIds.join(' ')}
      className="pointer-events-none absolute inset-0"
      style={{ overflow: 'visible' }}
    >
      {outlines.map(({ id, points }) => (
        <polygon
          // The token restarts the animation when the same object is shown again.
          key={`${highlight.token}-${id}`}
          points={points}
          fill="none"
          strokeWidth={3 * inv}
          strokeLinejoin="round"
          className={
            'motion-safe:animate-show-highlight ' +
            (highlight.color === null ? 'stroke-primary' : '')
          }
          style={highlight.color === null ? undefined : { stroke: highlight.color }}
        />
      ))}
    </svg>
  )
}

interface EditorShowNoticeProps {
  pending: PendingShow | null
  onShow: () => void
  onDismiss: () => void
}

export function EditorShowNotice({ pending, onShow, onDismiss }: EditorShowNoticeProps) {
  return (
    // Always mounted, so screen readers announce the notice when it appears.
    <div role="status" aria-live="polite" className="contents">
      {pending !== null && (
        <div className="panel fixed left-1/2 top-14 z-50 flex -translate-x-1/2 items-center gap-3 rounded-lg border border-border px-3 py-2 text-xs text-foreground shadow-lg">
          <Bot className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" aria-hidden="true" />
          <span>
            {pending.requester} wants to show you slide {pending.slideNumber}.
          </span>
          <Button size="sm" className="h-7 px-2 text-xs" onClick={onShow}>
            Show
          </Button>
          <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={onDismiss}>
            Dismiss
          </Button>
        </div>
      )}
    </div>
  )
}
