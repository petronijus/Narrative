/**
 * ui/VideoOverlay.tsx
 *
 * M12: DOM <video> overlay for VideoObject in present mode.
 *
 * Architecture:
 *   - Positioned via OverlayCompositor over the Pixi VideoObject container.
 *   - Uses hls.js for HLS playback (non-Safari browsers).
 *     Safari natively supports HLS via <video src>.
 *   - Honors VideoObject.autoplay, loop, muted props.
 *   - Only renders if transcodeStatus === 'done' (renderer shows poster otherwise).
 *
 * HLS manifest caching:
 *   The IndexedDB cache stores the manifest text but NOT HLS segments.
 *   Cached manifests reduce first-fetch latency; segments still stream on demand.
 *   We create an object URL from the cached manifest blob (if available) and pass it
 *   to hls.js. Segment URLs within the manifest still point to the server.
 *
 * Accessibility:
 *   - <video> has aria-label from VideoObject.alt.
 *   - pointer-events: auto in present mode (user can interact with controls if added later).
 *
 * Cleanup:
 *   - hls.destroy() on unmount.
 *   - overlay handle.destroy() on unmount.
 */

import { useEffect, useRef } from 'react'
import Hls from 'hls.js'
import type { Container } from 'pixi.js'
import type { VideoObject } from '@narrative/shared'
import type { SceneGraph } from '../renderer/SceneGraph.js'
import type { OverlayCompositor } from '../renderer/overlay/OverlayCompositor.js'
import { useVideoInfo } from '../state/useVideoInfo.js'

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
  const hlsRef = useRef<Hls | null>(null)
  const overlayHandleRef = useRef<ReturnType<typeof compositor.registerOverlay> | null>(null)
  const objectUrlRef = useRef<string | null>(null)

  // Effect: set up video element when transcode is done
  useEffect(() => {
    if (info?.transcodeStatus !== 'done') return
    if (info.hlsManifestUrl === null) return

    const hlsUrl = info.hlsManifestUrl

    // The Pixi scene may not yet have created a node for this video when we
    // mount (edit → present navigation can reach React render before the
    // renderer has reconciled). SceneGraph doesn't emit events, so poll per
    // rAF for up to ~1 s, then give up.
    let raf = 0
    let cancelled = false
    let retries = 0
    const MAX_RETRIES = 60 // ~1 s at 60 fps

    function attachHls(videoEl: HTMLVideoElement): void {
      if (Hls.isSupported()) {
        const hls = new Hls()
        hlsRef.current = hls
        hls.loadSource(hlsUrl)
        hls.attachMedia(videoEl)
      } else if (videoEl.canPlayType('application/vnd.apple.mpegurl')) {
        // Safari — native HLS support
        videoEl.src = hlsUrl
      } else {
        console.warn('[VideoOverlay] HLS not supported in this browser')
      }
    }

    function mount(pixiContainer: Container): void {
      // Build video element
      const videoEl = document.createElement('video')
      videoEl.style.width = `${videoObject.width}px`
      videoEl.style.height = `${videoObject.height}px`
      videoEl.style.objectFit = videoObject.fit ?? 'contain'
      videoEl.autoplay = videoObject.autoplay ?? false
      videoEl.loop = videoObject.loop ?? false
      videoEl.muted = videoObject.muted ?? true
      videoEl.playsInline = true
      // Always show native controls in present mode so the user has a play
      // button, progress bar and volume. Without this the overlay shows only
      // the first frame and no UI — looks broken.
      videoEl.controls = true
      if (videoObject.alt !== undefined && videoObject.alt !== '') {
        videoEl.setAttribute('aria-label', videoObject.alt)
      }
      // Fallback click-to-toggle as safety net.
      videoEl.addEventListener('click', () => {
        if (videoEl.paused) {
          void videoEl.play().catch(() => undefined)
        } else {
          videoEl.pause()
        }
      })

      videoRef.current = videoEl
      attachHls(videoEl)

      const handle = compositor.registerOverlay({
        pixiContainer,
        domElement: videoEl,
        worldOffset: { x: 0, y: 0 },
        interactive: true,
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
      if (hlsRef.current !== null) {
        hlsRef.current.destroy()
        hlsRef.current = null
      }
      if (overlayHandleRef.current !== null) {
        overlayHandleRef.current.destroy()
        overlayHandleRef.current = null
      }
      if (objectUrlRef.current !== null) {
        URL.revokeObjectURL(objectUrlRef.current)
        objectUrlRef.current = null
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
    info?.hlsManifestUrl,
    videoObject.id,
    videoObject.width,
    videoObject.height,
    videoObject.autoplay,
    videoObject.loop,
    videoObject.muted,
    videoObject.fit,
    sceneGraph,
    compositor,
  ])

  // This component renders nothing into the React tree — everything is DOM-injected via compositor
  return null
}
