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
import type { VideoObject } from '@narrative/shared'
import type { SceneGraph } from '../renderer/SceneGraph.js'
import type { OverlayCompositor } from '../renderer/overlay/OverlayCompositor.js'
import { useVideoInfo } from '../state/useVideoInfo.js'
import { openMediaCache } from '../state/mediaCache.js'

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

    // Get the Pixi container for this video object
    const node = sceneGraph.getNode(videoObject.id)
    if (node === undefined) return

    // Build video element
    const videoEl = document.createElement('video')
    videoEl.style.width = `${videoObject.width}px`
    videoEl.style.height = `${videoObject.height}px`
    videoEl.style.objectFit = videoObject.fit ?? 'contain'
    videoEl.autoplay = videoObject.autoplay ?? false
    videoEl.loop = videoObject.loop ?? false
    videoEl.muted = videoObject.muted ?? true
    videoEl.playsInline = true
    if (videoObject.alt !== undefined && videoObject.alt !== '') {
      videoEl.setAttribute('aria-label', videoObject.alt)
    }

    videoRef.current = videoEl

    // Attach HLS or fallback to native (Safari)
    async function attachHls() {
      let manifestSrc = hlsUrl

      // Try to serve from IndexedDB cache (reduces first-manifest-fetch latency)
      try {
        const cache = await openMediaCache()
        const cached = await cache.get(hlsUrl)
        if (cached !== null && typeof cached.content === 'string') {
          const blob = new Blob([cached.content], { type: 'application/vnd.apple.mpegurl' })
          const objUrl = URL.createObjectURL(blob)
          objectUrlRef.current = objUrl
          manifestSrc = objUrl
        }
      } catch {
        // Cache unavailable — use original URL
      }

      if (Hls.isSupported()) {
        const hls = new Hls()
        hlsRef.current = hls
        hls.loadSource(manifestSrc)
        hls.attachMedia(videoEl)
      } else if (videoEl.canPlayType('application/vnd.apple.mpegurl')) {
        // Safari — native HLS support
        videoEl.src = manifestSrc
      } else {
        console.warn('[VideoOverlay] HLS not supported in this browser')
      }
    }

    void attachHls()

    // Register with OverlayCompositor
    const handle = compositor.registerOverlay({
      pixiContainer: node.container,
      domElement: videoEl,
      worldOffset: { x: 0, y: 0 },
      interactive: true,
    })
    overlayHandleRef.current = handle

    return () => {
      // Cleanup on unmount or when info changes
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
    // Re-run when video geometry or playback props change
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
  ])

  // This component renders nothing into the React tree — everything is DOM-injected via compositor
  return null
}
