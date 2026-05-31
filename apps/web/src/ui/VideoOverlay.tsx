/**
 * ui/VideoOverlay.tsx
 *
 * M12: DOM <video> overlay for VideoObject in present mode.
 *
 * Architecture:
 *   - Positioned via OverlayCompositor over the Pixi VideoObject container.
 *   - Plays the progressive MP4 directly via <video src=playbackUrl>.
 *     MinIO serves byte-range requests so seeking works without HLS.
 *   - Honors VideoObject.autoplay, loop, muted props.
 *   - Only renders if transcodeStatus === 'done' (renderer shows poster otherwise).
 *
 * Accessibility:
 *   - <video> has aria-label from VideoObject.alt.
 *   - pointer-events: auto in present mode (user can interact with controls if added later).
 *
 * Cleanup:
 *   - overlay handle.destroy() on unmount.
 */

import { useEffect, useRef } from 'react'
import type { Container } from 'pixi.js'
import type { VideoObject } from '@narrative/shared'
import type { SceneGraph } from '../renderer/SceneGraph.js'
import type { OverlayCompositor } from '../renderer/overlay/OverlayCompositor.js'
import { useVideoInfo } from '../state/useVideoInfo.js'
import {
  attachLiveVideo as attachLiveVideoToRenderer,
  detachLiveVideo as detachLiveVideoFromRenderer,
} from '../renderer/objectRenderers/videoRenderer.js'

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface VideoOverlayProps {
  videoObject: VideoObject
  sceneGraph: SceneGraph
  compositor: OverlayCompositor
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function VideoOverlay({ videoObject, sceneGraph, compositor }: VideoOverlayProps) {
  const { info } = useVideoInfo(videoObject.assetId !== '' ? videoObject.assetId : null)

  const videoRef = useRef<HTMLVideoElement | null>(null)
  const overlayHandleRef = useRef<ReturnType<typeof compositor.registerOverlay> | null>(null)
  const objectUrlRef = useRef<string | null>(null)

  // Effect: set up video element when transcode is done
  useEffect(() => {
    if (info?.transcodeStatus !== 'done') return
    if (info.playbackUrl === null) return

    const playbackUrl = info.playbackUrl

    // The Pixi scene may not yet have created a node for this video when we
    // mount (edit → present navigation can reach React render before the
    // renderer has reconciled). SceneGraph doesn't emit events, so poll per
    // rAF for up to ~1 s, then give up.
    let raf = 0
    let cancelled = false
    let retries = 0
    const MAX_RETRIES = 60 // ~1 s at 60 fps

    function mount(pixiContainer: Container): void {
      // Build video element
      const videoEl = document.createElement('video')
      videoEl.style.width = `${videoObject.width}px`
      videoEl.style.height = `${videoObject.height}px`
      videoEl.style.objectFit = videoObject.fit ?? 'contain'
      videoEl.autoplay = videoObject.autoplay ?? false
      videoEl.loop = videoObject.loop ?? false
      videoEl.muted = videoObject.muted ?? true
      // P8: explicit volume — ignored when muted but still set so unmute
      // produces the right level.
      videoEl.volume = Math.max(0, Math.min(1, videoObject.volume ?? 1))
      videoEl.playsInline = true
      // P8: native control bar is opt-in. Default off (clean canvas
      // preview). When off, click-to-toggle still gives the user
      // play / pause via the addEventListener('click') handler below.
      videoEl.controls = videoObject.showControls === true
      if (videoObject.alt !== undefined && videoObject.alt !== '') {
        videoEl.setAttribute('aria-label', videoObject.alt)
      }

      // P8: playback range guards. Best-effort — no actual file
      // clipping, just seek + pause based on schema fields.
      const trimStart = Math.max(0, videoObject.trimStart ?? 0)
      const trimEnd = videoObject.trimEnd
      const posterTime = videoObject.posterTime

      // Initial seek: poster frame wins (it's a still preview), falls
      // back to trimStart, otherwise stays at 0. Single listener so
      // duplicates can't fight each other (the previous version had
      // two separate listeners, the second one — poster — clobbered
      // trimStart and made play() start from posterTime).
      const initialSeek =
        posterTime !== undefined && posterTime > 0 ? Math.max(trimStart, posterTime) : trimStart
      if (initialSeek > 0) {
        videoEl.addEventListener(
          'loadedmetadata',
          () => {
            videoEl.currentTime = initialSeek
          },
          { once: true },
        )
      }

      // Before each play, rewind to trimStart so the user gets a
      // proper "from the top" start instead of resuming from the
      // poster frame the overlay was showing as a still preview.
      videoEl.addEventListener('play', () => {
        // Only rewind if we're sitting on the poster preview AND
        // playback would otherwise start past it.
        if (
          posterTime !== undefined &&
          posterTime > 0 &&
          Math.abs(videoEl.currentTime - posterTime) < 0.05
        ) {
          videoEl.currentTime = trimStart
        }
      })

      if (trimEnd !== undefined && trimEnd > 0) {
        videoEl.addEventListener('timeupdate', () => {
          if (videoEl.currentTime >= trimEnd) videoEl.pause()
        })
      }

      // Fallback click-to-toggle as safety net.
      videoEl.addEventListener('click', () => {
        if (videoEl.paused) {
          void videoEl.play().catch(() => undefined)
        } else {
          videoEl.pause()
        }
      })

      // P8: publish the live currentTime so Inspector's "Use current
      // frame as poster" button can capture it without reaching into
      // the React tree. Keyed by object id so multiple videos coexist.
      const reg = window as unknown as {
        __narrative_video_currents?: Record<string, { currentTime: number }>
      }
      if (reg.__narrative_video_currents === undefined) {
        reg.__narrative_video_currents = {}
      }
      const currents = reg.__narrative_video_currents
      currents[videoObject.id] = { currentTime: 0 }
      videoEl.addEventListener('timeupdate', () => {
        currents[videoObject.id] = { currentTime: videoEl.currentTime }
      })
      videoEl.addEventListener('seeked', () => {
        currents[videoObject.id] = { currentTime: videoEl.currentTime }
      })

      videoRef.current = videoEl
      videoEl.src = playbackUrl

      // Hand the videoEl to the Pixi videoRenderer so the visible
      // representation lives inside the scene graph (layer order works
      // naturally). The DOM <video> stays invisible — kept around for
      // VideoSource to decode into and for click-to-toggle.
      videoEl.style.opacity = '0'
      const onCanPlayAttach = (): void => {
        attachLiveVideoToRenderer(videoObject.id, videoEl)
      }
      if (videoEl.readyState >= 2) attachLiveVideoToRenderer(videoObject.id, videoEl)
      else videoEl.addEventListener('canplay', onCanPlayAttach, { once: true })

      const handle = compositor.registerOverlay({
        pixiContainer,
        domElement: videoEl,
        worldOffset: { x: 0, y: 0 },
        interactive: true,
        // P8: rotation + opacity flow through from Pixi container so the
        // present-mode video reflects transforms authored in the editor.
        applyContainerTransform: true,
      })
      overlayHandleRef.current = handle
    }

    function tryMount(): void {
      if (cancelled) return
      const node = sceneGraph.getNode(videoObject.id)
      if (node === undefined) {
        if (retries++ < MAX_RETRIES) {
          raf = requestAnimationFrame(tryMount)
        }
        return
      }
      mount(node.container)
    }

    tryMount()

    return () => {
      cancelled = true
      if (raf !== 0) cancelAnimationFrame(raf)
      detachLiveVideoFromRenderer(videoObject.id)
      if (overlayHandleRef.current !== null) {
        overlayHandleRef.current.destroy()
        overlayHandleRef.current = null
      }
      if (objectUrlRef.current !== null) {
        URL.revokeObjectURL(objectUrlRef.current)
        objectUrlRef.current = null
      }
      // P12g: drop the per-video currentTime publication so the global
      // registry doesn't grow unbounded across present-mode mounts /
      // unmounts. Without this, every reopen of a deck added another
      // entry that nothing ever cleared.
      const reg = window as unknown as {
        __narrative_video_currents?: Record<string, { currentTime: number }>
      }
      if (reg.__narrative_video_currents !== undefined) {
        delete reg.__narrative_video_currents[videoObject.id]
      }
      videoRef.current = null
    }
    // Re-run when video geometry or playback props change, or when the
    // SceneGraph / Compositor identity changes (edit → present navigation
    // mounts a fresh Canvas, so these references change and the overlay must
    // re-attach against the new Pixi scene).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    info?.transcodeStatus,
    info?.playbackUrl,
    videoObject.id,
    videoObject.width,
    videoObject.height,
    videoObject.autoplay,
    videoObject.loop,
    videoObject.muted,
    videoObject.volume,
    videoObject.showControls,
    videoObject.fit,
    videoObject.trimStart,
    videoObject.trimEnd,
    videoObject.posterTime,
    sceneGraph,
    compositor,
  ])

  // This component renders nothing into the React tree — everything is DOM-injected via compositor
  return null
}
