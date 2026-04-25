/**
 * ui/EditorVideoPreview.tsx
 *
 * P8: editor-only DOM <video> preview rendered in slide-space coords.
 *
 * Why a separate component (instead of reusing the present-mode
 * VideoOverlay): VideoOverlay positions its <video> via
 * OverlayCompositor, which reads `pixiContainer.toGlobal()`. That gives
 * canvas-internal CSS px and is correct in present mode where the
 * canvas has no CSS-transformed ancestor. In the editor, the canvas
 * sits inside `.artboard { transform: scale(zoom) }` — `toGlobal` still
 * returns canvas-internal px (untouched by the parent transform), but
 * the videoEl's `translate(x, y)` is interpreted relative to the
 * overlayRoot, which IS inside the scaled artboard, so the actual
 * visual position drifts away from the Pixi-painted poster. Visually
 * users see two overlapping video boxes at different positions, plus
 * the size doesn't track zoom because videoEl uses raw pixel widths.
 *
 * This component sidesteps the whole compositor: the videoEl is mounted
 * as a direct child of the artboard, positioned via slide-space CSS
 * coords (left/top/width/height). The artboard's existing
 * `transform: scale(zoom)` then scales it together with everything else
 * — the Pixi canvas, transform handles, snap guides — so it stays in
 * lockstep.
 *
 * Present mode keeps using VideoOverlay (compositor-driven) because
 * there's no CSS scale to fight with there.
 */

import { useEffect, useRef } from 'react'
import Hls from 'hls.js'
import type { VideoObject } from '@narrative/shared'
import { useVideoInfo } from '../state/useVideoInfo.js'

export interface EditorVideoPreviewProps {
  videoObject: VideoObject
  /**
   * 'edit'    → never autoplay, ignore volume, wrapper is pointer-events:none
   *             so selection / transform handles win the click.
   * 'present' → honor videoObject.autoplay + volume; wrapper accepts clicks
   *             so the user can play/pause.
   */
  mode?: 'edit' | 'present'
}

export function EditorVideoPreview({ videoObject, mode = 'edit' }: EditorVideoPreviewProps) {
  const isPresent = mode === 'present'
  const { info } = useVideoInfo(videoObject.assetId !== '' ? videoObject.assetId : null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const hlsRef = useRef<Hls | null>(null)

  // Wire up HLS the moment we have a hlsManifestUrl.
  useEffect(() => {
    if (info?.transcodeStatus !== 'done') return
    const hlsUrl = info.hlsManifestUrl
    if (hlsUrl === null) return
    const videoEl = videoRef.current
    if (videoEl === null) return

    // Volume + autoplay only matter in present mode. Editor stays muted/paused.
    if (isPresent) {
      videoEl.volume = Math.max(0, Math.min(1, videoObject.volume ?? 1))
    }

    if (Hls.isSupported()) {
      const hls = new Hls()
      hlsRef.current = hls
      hls.loadSource(hlsUrl)
      hls.attachMedia(videoEl)
    } else if (videoEl.canPlayType('application/vnd.apple.mpegurl')) {
      videoEl.src = hlsUrl
    }

    if (isPresent && videoObject.autoplay === true) {
      const onCanPlay = (): void => {
        void videoEl.play().catch(() => undefined)
      }
      videoEl.addEventListener('canplay', onCanPlay, { once: true })
    }

    // Initial seek: poster frame wins, then trimStart, then 0.
    const trimStart = Math.max(0, videoObject.trimStart ?? 0)
    const posterTime = videoObject.posterTime
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
    // Rewind to trimStart on Play if we're sitting on the poster preview.
    const onPlay = (): void => {
      if (
        posterTime !== undefined &&
        posterTime > 0 &&
        Math.abs(videoEl.currentTime - posterTime) < 0.05
      ) {
        videoEl.currentTime = trimStart
      }
    }
    videoEl.addEventListener('play', onPlay)
    const trimEnd = videoObject.trimEnd
    const onTimeUpdate = (): void => {
      if (trimEnd !== undefined && trimEnd > 0 && videoEl.currentTime >= trimEnd) {
        videoEl.pause()
      }
    }
    videoEl.addEventListener('timeupdate', onTimeUpdate)

    // Publish currentTime so Inspector's "Use current frame" can read it.
    const reg = window as unknown as {
      __narrative_video_currents?: Record<string, { currentTime: number }>
    }
    if (reg.__narrative_video_currents === undefined) reg.__narrative_video_currents = {}
    const currents = reg.__narrative_video_currents
    currents[videoObject.id] = { currentTime: 0 }
    const onTime = (): void => {
      currents[videoObject.id] = { currentTime: videoEl.currentTime }
    }
    videoEl.addEventListener('timeupdate', onTime)
    videoEl.addEventListener('seeked', onTime)

    return () => {
      videoEl.removeEventListener('play', onPlay)
      videoEl.removeEventListener('timeupdate', onTimeUpdate)
      videoEl.removeEventListener('timeupdate', onTime)
      videoEl.removeEventListener('seeked', onTime)
      if (hlsRef.current !== null) {
        hlsRef.current.destroy()
        hlsRef.current = null
      }
    }
  }, [
    info?.transcodeStatus,
    info?.hlsManifestUrl,
    videoObject.id,
    videoObject.trimStart,
    videoObject.trimEnd,
    videoObject.posterTime,
    videoObject.autoplay,
    videoObject.volume,
    isPresent,
  ])

  // While transcode hasn't finished, render nothing — the Pixi
  // poster placeholder painted by videoRenderer is enough.
  if (info?.transcodeStatus !== 'done') return null

  return (
    <div
      aria-hidden="true"
      style={{
        position: 'absolute',
        left: videoObject.x,
        top: videoObject.y,
        width: videoObject.width,
        height: videoObject.height,
        // Apply rotation around the centre to match the Pixi
        // container's (pivot-at-centre) rotation. opacity directly
        // mirrors the object's opacity.
        transform: `rotate(${videoObject.rotation}rad)`,
        transformOrigin: 'center',
        opacity: videoObject.opacity,
        // Editor: pointer-events:none lets transform handles + selection
        // clicks through. Present: accept clicks so the user can play/pause.
        pointerEvents: isPresent ? 'auto' : 'none',
      }}
    >
      <video
        ref={videoRef}
        muted={videoObject.muted ?? true}
        autoPlay={false}
        loop={videoObject.loop ?? false}
        playsInline
        controls={videoObject.showControls === true}
        aria-label={videoObject.alt ?? undefined}
        onClick={(e) => {
          const v = e.currentTarget
          if (v.paused) void v.play().catch(() => undefined)
          else v.pause()
        }}
        style={{
          width: '100%',
          height: '100%',
          objectFit: videoObject.fit ?? 'contain',
          pointerEvents: 'auto',
          background: 'transparent',
        }}
      />
    </div>
  )
}
