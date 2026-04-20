/**
 * ui/UploadDropZone.tsx
 *
 * M11: Transparent absolute-positioned drop zone overlay inside the canvas container.
 *
 * Behaviour:
 *   - dragenter/dragover with image files → show "Drop image here" border highlight
 *   - dragleave / dragend → hide highlight
 *   - drop → for each image file call startUpload(file, { onDone: addImageObject })
 *   - non-image files silently filtered (MIME check client-side; server enforces 415)
 *   - viewer role: rendered inert (pointer-events-none, no event handlers)
 *
 * addImageObject(entry, dropX, dropY):
 *   Creates an ImageObject via createObjectOfType on the active slide at the drop
 *   position in world/canvas coords (same coordinate space as other objects).
 *   Falls back to slide centre (960, 540 for 1920×1080) if drop position is unknown.
 *
 * Note: clientToCanvasCoords mirrors the helper in EditorLayout.tsx. When zoom/pan
 * lands in a future milestone, both places need updating to apply the viewport transform.
 */

import { useCallback, useRef, useState } from 'react'
import { createObjectOfType } from '@narrative/slide-model'
import type { UploadEntry } from '../state/useMediaUpload.js'
import { useMediaUpload } from '../state/useMediaUpload.js'
import { useSlideObjects } from '../state/useSlideObjects.js'
import { useDeckRole } from '../state/DeckRoleContext.js'

// ---------------------------------------------------------------------------
// Coordinate helper (mirrors EditorLayout.clientToCanvasCoords)
// ---------------------------------------------------------------------------

function clientToCanvasCoords(
  clientX: number,
  clientY: number,
  canvasRect: DOMRect,
): { x: number; y: number } {
  return {
    x: clientX - canvasRect.left,
    y: clientY - canvasRect.top,
  }
}

// Default drop position when we cannot determine canvas rect
const DEFAULT_DROP_X = 960
const DEFAULT_DROP_Y = 540

// ---------------------------------------------------------------------------
// UploadDropZone
// ---------------------------------------------------------------------------

interface UploadDropZoneProps {
  /** Ref to the canvas container div — used to compute drop coords. */
  canvasContainerRef: React.RefObject<HTMLDivElement | null> | React.RefObject<HTMLDivElement>
}

export function UploadDropZone({ canvasContainerRef }: UploadDropZoneProps) {
  const { role } = useDeckRole()
  const { startUpload } = useMediaUpload()
  const { objectsCtx } = useSlideObjects()

  const [isDragOver, setIsDragOver] = useState(false)
  /** Track drop X/Y in world coords so onDone callback can place the image. */
  const pendingDropCoordsRef = useRef<{ x: number; y: number }>({
    x: DEFAULT_DROP_X,
    y: DEFAULT_DROP_Y,
  })

  // Drag enter counter — prevents flicker when moving between child elements
  const dragDepthRef = useRef(0)

  const isViewer = role === 'viewer'

  // ---------------------------------------------------------------------------
  // Check if dragged items contain image files
  // ---------------------------------------------------------------------------

  function hasImageFiles(dataTransfer: DataTransfer): boolean {
    for (const item of Array.from(dataTransfer.items)) {
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        return true
      }
    }
    return false
  }

  // ---------------------------------------------------------------------------
  // Create ImageObject on upload completion
  // ---------------------------------------------------------------------------

  const addImageObject = useCallback(
    (entry: UploadEntry, x: number, y: number) => {
      if (entry.status !== 'done') return
      if (objectsCtx === null) return
      if (entry.assetId === undefined || entry.assetId === '') return

      createObjectOfType(objectsCtx, 'image', {
        assetId: entry.assetId,
        width: entry.width ?? 400,
        height: entry.height ?? 300,
        x,
        y,
      })
    },
    [objectsCtx],
  )

  // ---------------------------------------------------------------------------
  // Drag event handlers
  // ---------------------------------------------------------------------------

  const handleDragEnter = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.stopPropagation()
    dragDepthRef.current += 1
    if (hasImageFiles(e.dataTransfer)) {
      setIsDragOver(true)
    }
  }, [])

  const handleDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = 'copy'
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.stopPropagation()
    dragDepthRef.current -= 1
    if (dragDepthRef.current <= 0) {
      dragDepthRef.current = 0
      setIsDragOver(false)
    }
  }, [])

  const handleDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault()
      e.stopPropagation()
      dragDepthRef.current = 0
      setIsDragOver(false)

      const containerEl = canvasContainerRef.current
      const rect = containerEl?.getBoundingClientRect()
      const dropCoords =
        rect !== undefined
          ? clientToCanvasCoords(e.clientX, e.clientY, rect)
          : { x: DEFAULT_DROP_X, y: DEFAULT_DROP_Y }

      pendingDropCoordsRef.current = dropCoords

      const files = Array.from(e.dataTransfer.files)
      const imageFiles = files.filter((f) => f.type.startsWith('image/'))

      for (const file of imageFiles) {
        // Capture drop coords for this upload's onDone closure
        const { x, y } = dropCoords
        startUpload(file, {
          onDone: (entry) => addImageObject(entry, x, y),
        })
      }
    },
    [canvasContainerRef, startUpload, addImageObject],
  )

  // Viewer: render inert transparent overlay (no pointer events, no handlers)
  if (isViewer) {
    return <div className="pointer-events-none absolute inset-0" aria-hidden="true" />
  }

  return (
    <div
      aria-hidden="true"
      className={[
        'absolute inset-0 transition-all duration-150',
        isDragOver
          ? 'border-4 border-blue-400 border-dashed bg-blue-400/10 z-20'
          : 'pointer-events-none border-transparent',
      ].join(' ')}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {isDragOver && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="rounded-xl bg-gray-900/90 px-6 py-4 shadow-xl">
            <p className="text-sm font-semibold text-blue-300">Drop image here</p>
          </div>
        </div>
      )}
    </div>
  )
}
