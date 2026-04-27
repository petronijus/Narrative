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

/**
 * Resize math shared by frame and image handles. With shift held on a
 * corner handle, locks aspect ratio (initial w/h) and the dominant
 * delta drives both axes. Edge handles ignore shift (single-axis
 * resize is unambiguous).
 */
function resizeRect(
  initial: { x: number; y: number; width: number; height: number },
  kind: HandleKind,
  dx: number,
  dy: number,
  shiftHeld: boolean,
): { x: number; y: number; width: number; height: number } {
  let { x, y, width, height } = initial
  const right = x + width
  const bottom = y + height
  const aspect = initial.height === 0 ? 1 : initial.width / initial.height
  const isCorner = kind === 'TL' || kind === 'TR' || kind === 'BL' || kind === 'BR'

  if (kind === 'TL' || kind === 'ML' || kind === 'BL') {
    const newX = Math.min(right - 10, x + dx)
    width = right - newX
    x = newX
  }
  if (kind === 'TR' || kind === 'MR' || kind === 'BR') {
    width = Math.max(10, width + dx)
  }
  if (kind === 'TL' || kind === 'TC' || kind === 'TR') {
    const newY = Math.min(bottom - 10, y + dy)
    height = bottom - newY
    y = newY
  }
  if (kind === 'BL' || kind === 'BC' || kind === 'BR') {
    height = Math.max(10, height + dy)
  }

  if (shiftHeld && isCorner) {
    // Lock to initial aspect — pick whichever proposed dimension
    // moved further from its initial value; recompute the other.
    const dW = Math.abs(width - initial.width)
    const dH = Math.abs(height - initial.height)
    if (dW >= dH) {
      const newH = Math.max(10, width / aspect)
      // Keep the anchor corner (opposite to the dragged one) fixed.
      if (kind === 'TL' || kind === 'TR') y = bottom - newH
      height = newH
    } else {
      const newW = Math.max(10, height * aspect)
      if (kind === 'TL' || kind === 'BL') x = right - newW
      width = newW
    }
  }

  return { x, y, width, height }
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
  const [imageRotation, setImageRotation] = useState<number>(obj.imageRotation ?? 0)
  const [frame, setFrame] = useState<FrameRect>({
    x: obj.x,
    y: obj.y,
    width: obj.width,
    height: obj.height,
  })

  /**
   * Two crop sub-modes (Keynote-style):
   *  - 'frame' (default after dbl-click): orange handles, drag = move
   *    crop window, image stays put.
   *  - 'image': blue handles, drag = move/scale image, frame stays.
   * The user toggles by clicking either the frame body (returns to
   * frame mode) or the image area outside the frame (= the faded
   * outside-frame region — switches to image mode).
   */
  const [mode, setMode] = useState<'frame' | 'image'>('frame')

  // Sync local state when the underlying object changes from outside
  // (undo / collaborator). We only re-seed when not actively dragging.
  const draggingRef = useRef(false)
  useEffect(() => {
    if (draggingRef.current) return
    setImageRect(defaultImageRect(obj))
    setImageRotation(obj.imageRotation ?? 0)
    setFrame({ x: obj.x, y: obj.y, width: obj.width, height: obj.height })
  }, [obj])

  // Materialise imageRect on entry into crop mode if it's still implicit.
  // Otherwise frame-handle resize (which only mutates x/y/width/height)
  // would visually drag the image with it, because the renderer's
  // effectiveImageRect falls back to the frame when imageRect is
  // undefined. By committing imageRect = current frame on entry, frame
  // resize cleanly trims the visible window without scaling the image.
  useEffect(() => {
    if (mutationCtx === null) return
    if (obj.imageRect !== undefined) return
    bulkUpdateObjects(mutationCtx, [
      {
        id: obj.id,
        patch: {
          imageRect: { x: obj.x, y: obj.y, width: obj.width, height: obj.height },
        } as Partial<ImageObject>,
      },
    ])
    // Run once per crop-mode entry — depends only on object id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [obj.id])

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
      // Same two-step rule as the frame ring: first click switches
      // mode, second click + drag manipulates.
      if (mode !== 'image') {
        setMode('image')
        return
      }
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
    [imageRect.x, imageRect.y, mode],
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
  // Frame body drag — pointer-down inside the frame moves the crop
  // window (object.x/y) without touching imageRect.
  // -------------------------------------------------------------------------

  const frameDragRef = useRef<{
    pointerId: number
    startClientX: number
    startClientY: number
    initialX: number
    initialY: number
  } | null>(null)

  const onFrameBodyPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return
      e.stopPropagation()
      // Two-step Keynote interaction: if we're not already in frame
      // sub-mode, the FIRST click on the frame edge just toggles the
      // mode. Only clicks while ALREADY in frame mode start a drag.
      if (mode !== 'frame') {
        setMode('frame')
        return
      }
      ;(e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId)
      draggingRef.current = true
      frameDragRef.current = {
        pointerId: e.pointerId,
        startClientX: e.clientX,
        startClientY: e.clientY,
        initialX: frame.x,
        initialY: frame.y,
      }
    },
    [frame.x, frame.y, mode],
  )

  const onFrameBodyPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const drag = frameDragRef.current
      if (drag === null) return
      const z = zoom === 0 ? 1 : zoom
      const dx = (e.clientX - drag.startClientX) / z
      const dy = (e.clientY - drag.startClientY) / z
      const next: FrameRect = {
        x: drag.initialX + dx,
        y: drag.initialY + dy,
        width: frame.width,
        height: frame.height,
      }
      setFrame(next)
      bulkUpdateObjects(mutationCtx, [{ id: obj.id, patch: { x: next.x, y: next.y } }])
    },
    [zoom, frame.width, frame.height, mutationCtx, obj.id],
  )

  const onFrameBodyPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (frameDragRef.current === null) return
    try {
      ;(e.currentTarget as HTMLDivElement).releasePointerCapture(e.pointerId)
    } catch {
      // already released
    }
    frameDragRef.current = null
    draggingRef.current = false
  }, [])

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
      const next = resizeRect(drag.initialFrame, drag.kind, dx, dy, e.shiftKey)
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
  // Image resize — blue handles on the imageRect bounds. Drag scales
  // the image content within the (un-changed) frame so the user can
  // zoom into a specific region while the crop window stays put.
  // -------------------------------------------------------------------------

  const imageHandleDragRef = useRef<{
    kind: HandleKind
    pointerId: number
    startClientX: number
    startClientY: number
    initialImage: ImageRect
  } | null>(null)

  const onImageHandlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>, kind: HandleKind) => {
      if (e.button !== 0) return
      e.stopPropagation()
      ;(e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId)
      draggingRef.current = true
      imageHandleDragRef.current = {
        kind,
        pointerId: e.pointerId,
        startClientX: e.clientX,
        startClientY: e.clientY,
        initialImage: { ...imageRect },
      }
    },
    [imageRect],
  )

  const onImageHandlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const drag = imageHandleDragRef.current
      if (drag === null) return
      const z = zoom === 0 ? 1 : zoom
      const dx = (e.clientX - drag.startClientX) / z
      const dy = (e.clientY - drag.startClientY) / z
      const next: ImageRect = resizeRect(drag.initialImage, drag.kind, dx, dy, e.shiftKey)
      setImageRect(next)
      bulkUpdateObjects(mutationCtx, [
        { id: obj.id, patch: { imageRect: next } as Partial<ImageObject> },
      ])
    },
    [zoom, mutationCtx, obj.id],
  )

  const onImageHandlePointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (imageHandleDragRef.current === null) return
    try {
      ;(e.currentTarget as HTMLDivElement).releasePointerCapture(e.pointerId)
    } catch {
      // already released
    }
    imageHandleDragRef.current = null
    draggingRef.current = false
  }, [])

  // -------------------------------------------------------------------------
  // Image rotation — drag handle above the imageRect rotates the image
  // around the imageRect centre via obj.imageRotation. Independent of
  // the object's frame rotation.
  // -------------------------------------------------------------------------

  const rotationDragRef = useRef<{
    pointerId: number
    centerClientX: number
    centerClientY: number
    initialAngle: number
    initialRotation: number
  } | null>(null)

  const onRotationPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return
      e.stopPropagation()
      // Find the imageRect centre in viewport coords using the artboard
      // bounding rect + zoom.
      const artboardEl = (e.currentTarget as HTMLElement).closest<HTMLElement>('.artboard')
      if (artboardEl === null) return
      const ar = artboardEl.getBoundingClientRect()
      const z = zoom === 0 ? 1 : zoom
      const cx = ar.left + (imageRect.x + imageRect.width / 2) * z
      const cy = ar.top + (imageRect.y + imageRect.height / 2) * z
      const initialAngle = Math.atan2(e.clientY - cy, e.clientX - cx)
      ;(e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId)
      draggingRef.current = true
      rotationDragRef.current = {
        pointerId: e.pointerId,
        centerClientX: cx,
        centerClientY: cy,
        initialAngle,
        initialRotation: imageRotation,
      }
    },
    [imageRect.x, imageRect.y, imageRect.width, imageRect.height, imageRotation, zoom],
  )

  const onRotationPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const drag = rotationDragRef.current
      if (drag === null) return
      const angle = Math.atan2(e.clientY - drag.centerClientY, e.clientX - drag.centerClientX)
      let next = drag.initialRotation + (angle - drag.initialAngle)
      if (e.shiftKey) {
        // Snap to 15° increments.
        const step = Math.PI / 12
        next = Math.round(next / step) * step
      }
      setImageRotation(next)
      bulkUpdateObjects(mutationCtx, [
        { id: obj.id, patch: { imageRotation: next } as Partial<ImageObject> },
      ])
    },
    [mutationCtx, obj.id],
  )

  const onRotationPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (rotationDragRef.current === null) return
    try {
      ;(e.currentTarget as HTMLDivElement).releasePointerCapture(e.pointerId)
    } catch {
      // already released
    }
    rotationDragRef.current = null
    draggingRef.current = false
  }, [])

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  const handles = buildHandles(frame.width, frame.height)
  const imageHandles = buildHandles(imageRect.width, imageRect.height)
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
      {/* Image-side overlays — wrapped in a CSS-rotated container so
          the ghost <img>, drag overlay, blue outline + handles all
          rotate together as a single unit (matching the Pixi sprite's
          imageRotation). Resize-while-rotated produces axis-aligned
          slide-space deltas — the visual resize follows slide-x/y,
          not the rotated frame's axes; that's a known v1 limitation
          tracked as a P12 follow-up. */}
      <div
        className="absolute"
        style={{
          left: imageRect.x,
          top: imageRect.y,
          width: imageRect.width,
          height: imageRect.height,
          transform: `rotate(${imageRotation}rad)`,
          transformOrigin: 'center',
          pointerEvents: 'none',
        }}
      >
        {imageUrl !== null && (
          <img
            src={imageUrl}
            alt=""
            aria-hidden="true"
            className="absolute select-none"
            style={{
              left: 0,
              top: 0,
              width: '100%',
              height: '100%',
              opacity: 0.3,
              objectFit: obj.fit ?? 'cover',
              pointerEvents: 'none',
            }}
          />
        )}

        {/* Image-drag overlay — full bounds, pointer-events auto so
            the user can switch to image mode + drag from anywhere on
            the picture. */}
        <div
          className="absolute"
          style={{
            left: 0,
            top: 0,
            width: '100%',
            height: '100%',
            cursor: mode === 'image' ? 'move' : 'pointer',
            touchAction: 'none',
            pointerEvents: 'auto',
          }}
          onPointerDown={onImagePointerDown}
          onPointerMove={onImagePointerMove}
          onPointerUp={onImagePointerUp}
          onPointerCancel={onImagePointerUp}
          onWheel={onImageWheel}
          data-crop-overlay-image="true"
        />

        {mode === 'image' && (
          <>
            {/* Blue outline — relative to wrapper. */}
            <div
              aria-hidden="true"
              className="pointer-events-none absolute box-border"
              style={{
                left: 0,
                top: 0,
                width: '100%',
                height: '100%',
                border: `${2 * inv}px solid #3b82f6`,
              }}
            />

            {/* Blue handles. */}
            {imageHandles.map((h) => (
              <div
                key={`img-${h.kind}`}
                role="button"
                aria-label={`Image ${h.kind}`}
                tabIndex={-1}
                className="absolute box-border border-2 bg-white"
                style={{
                  left: h.x,
                  top: h.y,
                  width: HANDLE_SIZE,
                  height: HANDLE_SIZE,
                  cursor: h.cursor,
                  borderColor: '#3b82f6',
                  transform: `translate(-50%, -50%) scale(${inv})`,
                  transformOrigin: 'center',
                  touchAction: 'none',
                  pointerEvents: 'auto',
                }}
                data-crop-overlay-handle="true"
                onPointerDown={(e) => onImageHandlePointerDown(e, h.kind)}
                onPointerMove={onImageHandlePointerMove}
                onPointerUp={onImageHandlePointerUp}
                onPointerCancel={onImageHandlePointerUp}
              />
            ))}

            {/* Rotation handle — circle ~24 viewport-px above the top
                centre. Hold Shift while dragging to snap to 15°. */}
            <div
              role="button"
              aria-label="Rotate image"
              tabIndex={-1}
              className="absolute rounded-full border-2 bg-white"
              style={{
                left: imageRect.width / 2,
                top: -24 * inv,
                width: HANDLE_SIZE,
                height: HANDLE_SIZE,
                cursor: 'grab',
                borderColor: '#3b82f6',
                transform: `translate(-50%, -50%) scale(${inv})`,
                transformOrigin: 'center',
                touchAction: 'none',
                pointerEvents: 'auto',
              }}
              data-crop-overlay-handle="true"
              onPointerDown={onRotationPointerDown}
              onPointerMove={onRotationPointerMove}
              onPointerUp={onRotationPointerUp}
              onPointerCancel={onRotationPointerUp}
            />
            {/* Tether line from top center to rotation handle. */}
            <div
              aria-hidden="true"
              className="pointer-events-none absolute"
              style={{
                left: imageRect.width / 2,
                top: -24 * inv,
                width: 1 * inv,
                height: 24 * inv,
                background: '#3b82f6',
                transform: 'translateX(-50%)',
              }}
            />
          </>
        )}
      </div>

      {/* 2b. Frame ring — 4 thin strips around the frame border (top,
          right, bottom, left). Hit area only — interior of the frame
          falls through to the image-drag layer below, so clicking the
          centre of the crop window switches to image mode. Tolerance
          is computed in slide-space px to keep ~16 viewport-px hit
          area at any zoom. */}
      {(() => {
        const tol = 16 * inv // 16 viewport-px in slide-space
        const ringStrips = [
          // top
          { x: frame.x - tol, y: frame.y - tol, w: frame.width + 2 * tol, h: 2 * tol },
          // bottom
          {
            x: frame.x - tol,
            y: frame.y + frame.height - tol,
            w: frame.width + 2 * tol,
            h: 2 * tol,
          },
          // left (between top and bottom strips)
          { x: frame.x - tol, y: frame.y + tol, w: 2 * tol, h: frame.height - 2 * tol },
          // right
          {
            x: frame.x + frame.width - tol,
            y: frame.y + tol,
            w: 2 * tol,
            h: frame.height - 2 * tol,
          },
        ]
        return ringStrips.map((s, i) => (
          <div
            key={`ring-${i}`}
            className="absolute"
            style={{
              left: s.x,
              top: s.y,
              width: s.w,
              height: s.h,
              cursor: mode === 'frame' ? 'move' : 'pointer',
              touchAction: 'none',
            }}
            onPointerDown={onFrameBodyPointerDown}
            onPointerMove={onFrameBodyPointerMove}
            onPointerUp={onFrameBodyPointerUp}
            onPointerCancel={onFrameBodyPointerUp}
            data-crop-overlay-frame="true"
          />
        ))
      })()}

      {/* 3a. Frame outline — orange always (so user knows where the
          crop window is even in image sub-mode). */}
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

      {/* 3b. 8 frame resize handles — only shown in 'frame' sub-mode. */}
      {mode === 'frame' &&
        handles.map((h) => (
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
