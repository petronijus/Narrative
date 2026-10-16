/**
 * ui/UploadDropZone.tsx
 *
 * M11: Transparent absolute-positioned drop zone overlay inside the canvas container.
 * M12: Extended to accept video/* MIME types (up to 500 MB).
 *
 * Behaviour:
 *   - dragenter/dragover with image or video files → show "Drop here" border highlight
 *   - dragleave / dragend → hide highlight
 *   - drop → for each accepted file call startUpload(file, { onDone })
 *     - image files → onDone creates ImageObject
 *     - video files → onDone creates VideoObject (once transcode is done)
 *   - non-image/non-video files silently filtered (MIME check client-side; server enforces 415)
 *   - viewer role: rendered inert (pointer-events-none, no event handlers)
 *
 * addMediaObject(entry, dropX, dropY):
 *   Creates an ImageObject or VideoObject via createObjectOfType on the active slide.
 *   Falls back to slide centre (960, 540 for 1920×1080) if drop position is unknown.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useActiveSlide } from '../state/ActiveSlideContext.js'
import { useCommand } from '../state/useCommand.js'
import type { UploadEntry } from '../state/useMediaUpload.js'
import { useMediaUpload } from '../state/useMediaUpload.js'
import { useDeckRole } from '../state/DeckRoleContext.js'
import { COMPONENT_DRAG_MIME } from './ComponentPickerDrawer.js'
import { useStampComponent } from '../state/useStampComponent.js'
import { useZoomLevel } from '../state/useZoomLevel.js'
import { clientToCanvasCoords } from '../lib/canvasCoords.js'

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
  const { activeSlideId } = useActiveSlide()
  const command = useCommand()
  // The drop listener is installed once; it reads the zoom through a ref.
  const { zoom } = useZoomLevel()
  const zoomRef = useRef(zoom)
  zoomRef.current = zoom
  const stampComponent = useStampComponent()

  const [isDragOver, setIsDragOver] = useState(false)
  const [dragFileType, setDragFileType] = useState<'image' | 'video' | 'mixed' | null>(null)
  /** Track drop X/Y in world coords so onDone callback can place the object. */
  const pendingDropCoordsRef = useRef<{ x: number; y: number }>({
    x: DEFAULT_DROP_X,
    y: DEFAULT_DROP_Y,
  })

  // Drag enter counter — prevents flicker when moving between child elements
  const dragDepthRef = useRef(0)

  const isViewer = role === 'viewer'

  // ---------------------------------------------------------------------------
  // Check if dragged items contain image or video files
  // ---------------------------------------------------------------------------

  function hasAcceptedFiles(dataTransfer: DataTransfer): boolean {
    for (const item of Array.from(dataTransfer.items)) {
      if (
        item.kind === 'file' &&
        (item.type.startsWith('image/') || item.type.startsWith('video/'))
      ) {
        return true
      }
    }
    return false
  }

  function detectDragFileType(dataTransfer: DataTransfer): 'image' | 'video' | 'mixed' | null {
    let hasImage = false
    let hasVideo = false
    for (const item of Array.from(dataTransfer.items)) {
      if (item.kind !== 'file') continue
      if (item.type.startsWith('image/')) hasImage = true
      if (item.type.startsWith('video/')) hasVideo = true
    }
    if (hasImage && hasVideo) return 'mixed'
    if (hasImage) return 'image'
    if (hasVideo) return 'video'
    return null
  }

  // ---------------------------------------------------------------------------
  // Create ImageObject or VideoObject on upload completion
  // ---------------------------------------------------------------------------

  const addMediaObject = useCallback(
    (entry: UploadEntry, x: number, y: number) => {
      if (entry.status !== 'done') return
      if (activeSlideId === null) return
      if (entry.assetId === undefined || entry.assetId === '') return

      const object = entry.mimeType.startsWith('video/')
        ? {
            type: 'video',
            assetId: entry.assetId,
            width: entry.width ?? 640,
            height: entry.height ?? 360,
            x,
            y,
            autoplay: false,
            loop: false,
            muted: true,
          }
        : {
            type: 'image',
            assetId: entry.assetId,
            width: entry.width ?? 400,
            height: entry.height ?? 300,
            x,
            y,
          }
      command.tryRun('object.create', { slide: activeSlideId, object })
    },
    [activeSlideId, command],
  )

  // ---------------------------------------------------------------------------
  // Drag event handlers
  // ---------------------------------------------------------------------------

  // Attach native drag listeners to the canvas container so events fire even
  // when this overlay is pointer-events-none (its default idle state so clicks
  // on canvas objects pass through).
  useEffect(() => {
    if (isViewer) return
    const el = canvasContainerRef.current
    if (!el) return

    const onDragEnter = (e: DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (!e.dataTransfer) return
      dragDepthRef.current += 1
      if (hasAcceptedFiles(e.dataTransfer)) {
        setIsDragOver(true)
        setDragFileType(detectDragFileType(e.dataTransfer))
      }
    }

    const onDragOver = (e: DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    }

    const onDragLeave = (e: DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      dragDepthRef.current -= 1
      if (dragDepthRef.current <= 0) {
        dragDepthRef.current = 0
        setIsDragOver(false)
        setDragFileType(null)
      }
    }

    const onDrop = (e: DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      dragDepthRef.current = 0
      setIsDragOver(false)
      setDragFileType(null)

      const rect = el.getBoundingClientRect()
      const dropCoords = clientToCanvasCoords(e.clientX, e.clientY, rect, zoomRef.current)
      pendingDropCoordsRef.current = dropCoords

      // Component drag-out from the picker drawer — stamped on the server
      // (useStampComponent). Drop position is ignored by design: the stamp
      // lands at the master's authored slide-space top-left, identical to
      // the click-from-picker path. (Predictable default placement — users
      // can always nudge afterwards.)
      const componentPayload = e.dataTransfer?.getData(COMPONENT_DRAG_MIME) ?? ''
      if (componentPayload !== '') {
        try {
          const parsed = JSON.parse(componentPayload) as { componentId: string }
          if (typeof parsed.componentId === 'string' && parsed.componentId !== '') {
            void stampComponent(parsed.componentId)
          }
        } catch {
          // Malformed payload — ignore; the file branch below still runs if applicable.
        }
        return
      }

      const files = Array.from(e.dataTransfer?.files ?? [])
      const accepted = files.filter(
        (f) => f.type.startsWith('image/') || f.type.startsWith('video/'),
      )

      for (const file of accepted) {
        const { x, y } = dropCoords
        startUpload(file, {
          onDone: (entry) => addMediaObject(entry, x, y),
        })
      }
    }

    el.addEventListener('dragenter', onDragEnter)
    el.addEventListener('dragover', onDragOver)
    el.addEventListener('dragleave', onDragLeave)
    el.addEventListener('drop', onDrop)
    return () => {
      el.removeEventListener('dragenter', onDragEnter)
      el.removeEventListener('dragover', onDragOver)
      el.removeEventListener('dragleave', onDragLeave)
      el.removeEventListener('drop', onDrop)
    }
  }, [isViewer, canvasContainerRef, startUpload, addMediaObject, stampComponent])

  // Viewer: render inert transparent overlay (no pointer events, no handlers)
  if (isViewer) {
    return <div className="pointer-events-none absolute inset-0" aria-hidden="true" />
  }

  // Choose label text based on what's being dragged
  const dropLabel =
    dragFileType === 'video'
      ? 'Drop video here'
      : dragFileType === 'mixed'
        ? 'Drop files here'
        : 'Drop image here'

  return (
    <div
      aria-hidden="true"
      className={[
        'pointer-events-none absolute inset-0 transition-all duration-150',
        isDragOver
          ? 'border-4 border-blue-400 border-dashed bg-blue-400/10 z-20'
          : 'border-transparent',
      ].join(' ')}
    >
      {isDragOver && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="rounded-xl bg-gray-900/90 px-6 py-4 shadow-xl">
            <p className="text-sm font-semibold text-blue-300">{dropLabel}</p>
          </div>
        </div>
      )}
    </div>
  )
}
