/**
 * ui/CropOverlay.tsx
 *
 * P11 (Keynote-style image crop): UI overlay shown while an ImageObject
 * is in crop-edit mode. Three layers, all rendered inside the artboard
 * div (so they inherit the CSS scale(zoom) transform — coordinates
 * stay in slide-space px):
 *
 * 1. Image-ghost layer — full source <img> at imageRect, opacity 30%,
 *    pointer-events disabled. Visualises everything currently OUTSIDE
 *    the frame so the user sees what they're trimming away.
 * 2. Image-drag overlay — invisible div sized to imageRect with
 *    pointer-events:auto. Pointer-down + drag mutates imageRect.x/y;
 *    the underlying Pixi sprite slides under the (un-moved) frame.
 *    Mouse-wheel scales imageRect around the cursor (zoom into image).
 * 3. Frame outline + 8 resize handles — same visual style as
 *    TransformHandles. Drag a handle → resize the object's frame
 *    while leaving imageRect alone, so the visible window changes
 *    but the picture content underneath stays put.
 *
 * Exit: Escape (handled by EditorLayout) or pointerdown outside the
 * union of frame and imageRect (handled by EditorLayout's backdrop).
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ImageObject } from '@narrative/shared'
import type { ObjectsMutationContext } from '@narrative/slide-model'
import { bulkUpdateObjects } from '@narrative/slide-model'
import { useZoomLevel } from '../state/useZoomLevel.js'
import { getDefaultImageUrlResolver } from '../renderer/imageUrl.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HANDLE_SIZE = 10

type HandleKind = 'TL' | 'TC' | 'TR' | 'ML' | 'MR' | 'BL' | 'BC' | 'BR'

interface HandleSpec {
  kind: HandleKind
  /** Slide-space position (top-left of the object frame is origin 0,0 here). */
  x: number
  y: number
  cursor: string
}

function buildHandles(w: number, h: number): HandleSpec[] {
  return [
    { kind: 'TL', x: 0, y: 0, cursor: 'nwse-resize' },
    { kind: 'TC', x: w / 2, y: 0, cursor: 'ns-resize' },
    { kind: 'TR', x: w, y: 0, cursor: 'nesw-resize' },
    { kind: 'ML', x: 0, y: h / 2, cursor: 'ew-resize' },
    { kind: 'MR', x: w, y: h / 2, cursor: 'ew-resize' },
    { kind: 'BL', x: 0, y: h, cursor: 'nesw-resize' },
    { kind: 'BC', x: w / 2, y: h, cursor: 'ns-resize' },
    { kind: 'BR', x: w, y: h, cursor: 'nwse-resize' },
  ]
}

interface ImageRect {
  x: number
  y: number
  width: number
  height: number
}

interface FrameRect {
  x: number
  y: number
  width: number
  height: number
}

export interface CropOverlayProps {
  obj: ImageObject
  mutationCtx: ObjectsMutationContext
}

// ---------------------------------------------------------------------------
// Default imageRect helper — resolves the implicit "image fills the frame"
// case to an explicit rect we can mutate.
// ---------------------------------------------------------------------------

function defaultImageRect(obj: ImageObject): ImageRect {
  if (obj.imageRect !== undefined) return obj.imageRect
  return { x: obj.x, y: obj.y, width: obj.width, height: obj.height }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function CropOverlay({ obj, mutationCtx }: CropOverlayProps) {
  const { zoom } = useZoomLevel()
  const [imageUrl, setImageUrl] = useState<string | null>(null)

  // Local "live" state — updated optimistically during drags so the
  // overlay tracks the pointer at 60Hz without waiting for the Y.Doc
  // round-trip. Committed to the doc on every move via bulkUpdateObjects.
  const [imageRect, setImageRect] = useState<ImageRect>(defaultImageRect(obj))
  const [frame, setFrame] = useState<FrameRect>({
    x: obj.x,
    y: obj.y,
    width: obj.width,
    height: obj.height,
  })

  // Sync local state when the underlying object changes from outside
  // (undo / collaborator). We only re-seed when not actively dragging.
  const draggingRef = useRef(false)
  useEffect(() => {
    if (draggingRef.current) return
    setImageRect(defaultImageRect(obj))
    setFrame({ x: obj.x, y: obj.y, width: obj.width, height: obj.height })
  }, [obj])

  // Resolve image URL via the same resolver the renderer uses.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const url = await getDefaultImageUrlResolver()({
          assetId: obj.assetId,
          variant: obj.variant ?? 'display',
        })
        if (!cancelled) setImageUrl(url)
      } catch {
        // Leave imageUrl null — ghost layer just won't render.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [obj.assetId, obj.variant])

  // -------------------------------------------------------------------------
  // Image drag — pointer-down on the image moves imageRect.x/y.
  // -------------------------------------------------------------------------

  const imageDragRef = useRef<{
    pointerId: number
    startClientX: number
    startClientY: number
    initialX: number
    initialY: number
  } | null>(null)

  const onImagePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return
      e.stopPropagation()
      ;(e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId)
      draggingRef.current = true
      imageDragRef.current = {
        pointerId: e.pointerId,
        startClientX: e.clientX,
        startClientY: e.clientY,
        initialX: imageRect.x,
        initialY: imageRect.y,
      }
    },
    [imageRect.x, imageRect.y],
  )

  const onImagePointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const drag = imageDragRef.current
      if (drag === null) return
      const z = zoom === 0 ? 1 : zoom
      const dx = (e.clientX - drag.startClientX) / z
      const dy = (e.clientY - drag.startClientY) / z
      const next: ImageRect = {
        x: drag.initialX + dx,
        y: drag.initialY + dy,
        width: imageRect.width,
        height: imageRect.height,
      }
      setImageRect(next)
      bulkUpdateObjects(mutationCtx, [
        { id: obj.id, patch: { imageRect: next } as Partial<ImageObject> },
      ])
    },
    [zoom, imageRect.width, imageRect.height, mutationCtx, obj.id],
  )

  const onImagePointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (imageDragRef.current === null) return
    try {
      ;(e.currentTarget as HTMLDivElement).releasePointerCapture(e.pointerId)
    } catch {
      // releasePointerCapture throws if the capture was already released — ignore.
    }
    imageDragRef.current = null
    draggingRef.current = false
  }, [])

  // Mouse-wheel zoom around the cursor. TODO: support pinch / smooth
  // wheel deltas — current implementation is the minimum-viable
  // factor-based zoom requested in the spec.
  const onImageWheel = useCallback(
    (e: React.WheelEvent<HTMLDivElement>) => {
      e.preventDefault()
      e.stopPropagation()
      const factor = e.deltaY < 0 ? 1.05 : 1 / 1.05
      // Cursor in slide coords — same coord system as imageRect.
      const target = e.currentTarget as HTMLDivElement
      const rect = target.getBoundingClientRect()
      const z = zoom === 0 ? 1 : zoom
      const cursorSlideX = imageRect.x + (e.clientX - rect.left) / z
      const cursorSlideY = imageRect.y + (e.clientY - rect.top) / z
      const next: ImageRect = {
        width: imageRect.width * factor,
        height: imageRect.height * factor,
        x: imageRect.x - (cursorSlideX - imageRect.x) * (factor - 1),
        y: imageRect.y - (cursorSlideY - imageRect.y) * (factor - 1),
      }
      setImageRect(next)
      bulkUpdateObjects(mutationCtx, [
        { id: obj.id, patch: { imageRect: next } as Partial<ImageObject> },
      ])
    },
    [imageRect, zoom, mutationCtx, obj.id],
  )

  // -------------------------------------------------------------------------
  // Frame resize — pointer-down on a handle resizes the object frame
  // (object.x/y/width/height) without touching imageRect.
  // -------------------------------------------------------------------------

  const handleDragRef = useRef<{
    kind: HandleKind
    pointerId: number
    startClientX: number
    startClientY: number
    initialFrame: FrameRect
  } | null>(null)

  const onHandlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>, kind: HandleKind) => {
      if (e.button !== 0) return
      e.stopPropagation()
      ;(e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId)
      draggingRef.current = true
      handleDragRef.current = {
        kind,
        pointerId: e.pointerId,
        startClientX: e.clientX,
        startClientY: e.clientY,
        initialFrame: { ...frame },
      }
    },
    [frame],
  )

  const onHandlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const drag = handleDragRef.current
      if (drag === null) return
      const z = zoom === 0 ? 1 : zoom
      const dx = (e.clientX - drag.startClientX) / z
      const dy = (e.clientY - drag.startClientY) / z
      let { x, y, width, height } = drag.initialFrame
      const right = x + width
      const bottom = y + height

      const k = drag.kind
      if (k === 'TL' || k === 'ML' || k === 'BL') {
        const newX = Math.min(right - 10, x + dx)
        width = right - newX
        x = newX
      }
      if (k === 'TR' || k === 'MR' || k === 'BR') {
        width = Math.max(10, width + dx)
      }
      if (k === 'TL' || k === 'TC' || k === 'TR') {
        const newY = Math.min(bottom - 10, y + dy)
        height = bottom - newY
        y = newY
      }
      if (k === 'BL' || k === 'BC' || k === 'BR') {
        height = Math.max(10, height + dy)
      }

      const next: FrameRect = { x, y, width, height }
      setFrame(next)
      bulkUpdateObjects(mutationCtx, [
        {
          id: obj.id,
          patch: { x: next.x, y: next.y, width: next.width, height: next.height },
        },
      ])
    },
    [zoom, mutationCtx, obj.id],
  )

  const onHandlePointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (handleDragRef.current === null) return
    try {
      ;(e.currentTarget as HTMLDivElement).releasePointerCapture(e.pointerId)
    } catch {
      // already released
    }
    handleDragRef.current = null
    draggingRef.current = false
  }, [])

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  const handles = buildHandles(frame.width, frame.height)
  // Inverse-zoom factor so handles stay constant SCREEN size despite
  // the artboard's CSS scale(zoom).
  const inv = zoom === 0 ? 1 : 1 / zoom

  return (
    <>
      {/* 1. Faded full-image ghost. The Pixi-rendered (un-faded) image
          is clipped to the frame; this layer shows the rest at 30%
          opacity. We render the FULL image atop the Pixi one inside
          the frame too — that's fine, opacity 30% on top of the same
          pixels just dims them slightly which is acceptable; at the
          edges it visually cross-fades to the trimmed area. */}
      {imageUrl !== null && (
        <img
          src={imageUrl}
          alt=""
          aria-hidden="true"
          className="pointer-events-none absolute select-none"
          style={{
            left: imageRect.x,
            top: imageRect.y,
            width: imageRect.width,
            height: imageRect.height,
            opacity: 0.3,
            objectFit: 'fill',
          }}
        />
      )}

      {/* 2. Invisible image-drag overlay covering imageRect. Catches
          pointer events anywhere on the source image (inside or
          outside the frame). */}
      <div
        className="absolute"
        style={{
          left: imageRect.x,
          top: imageRect.y,
          width: imageRect.width,
          height: imageRect.height,
          cursor: 'move',
          touchAction: 'none',
        }}
        onPointerDown={onImagePointerDown}
        onPointerMove={onImagePointerMove}
        onPointerUp={onImagePointerUp}
        onPointerCancel={onImagePointerUp}
        onWheel={onImageWheel}
        data-crop-overlay-image="true"
      />

      {/* 3a. Frame outline — yellow-ish accent so it reads as "this is
          the visible window", distinct from the regular blue selection. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute box-border"
        style={{
          left: frame.x,
          top: frame.y,
          width: frame.width,
          height: frame.height,
          border: `${2 * inv}px solid #f59e0b`,
        }}
      />

      {/* 3b. 8 resize handles. Positioned relative to the artboard
          (frame.x + handle-local). Inverse-scaled to stay constant on
          screen. */}
      {handles.map((h) => (
        <div
          key={h.kind}
          role="button"
          aria-label={`Crop frame ${h.kind}`}
          tabIndex={-1}
          className="absolute box-border border-2 bg-white"
          style={{
            left: frame.x + h.x,
            top: frame.y + h.y,
            width: HANDLE_SIZE,
            height: HANDLE_SIZE,
            cursor: h.cursor,
            borderColor: '#f59e0b',
            transform: `translate(-50%, -50%) scale(${inv})`,
            transformOrigin: 'center',
            touchAction: 'none',
          }}
          data-crop-overlay-handle="true"
          onPointerDown={(e) => onHandlePointerDown(e, h.kind)}
          onPointerMove={onHandlePointerMove}
          onPointerUp={onHandlePointerUp}
          onPointerCancel={onHandlePointerUp}
        />
      ))}
    </>
  )
}
