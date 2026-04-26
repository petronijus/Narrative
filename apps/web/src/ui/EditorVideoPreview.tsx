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

import { useEffect, useRef, useState, useCallback } from 'react'
import Hls from 'hls.js'
import { Play, Pause, Volume2, VolumeX } from 'lucide-react'
import type { VideoObject, SlideObjectPatch } from '@narrative/shared'
import { useVideoInfo } from '../state/useVideoInfo.js'
import { useSlideObjects } from '../state/useSlideObjects.js'
import { useZoomLevel } from '../state/useZoomLevel.js'
import { updateObject } from '@narrative/slide-model'

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
  const { objectsCtx } = useSlideObjects()
  // Editor only — counter-scales the hover bar so it stays a constant
  // size in viewport pixels regardless of artboard zoom. In present mode
  // the slide container is scaled too but we don't render the bar there.
  const { zoom } = useZoomLevel()

  // Hover controls state — only shown in edit mode.
  const [hovered, setHovered] = useState(false)
  const [playing, setPlaying] = useState(false)
  const [muted, setMutedState] = useState(videoObject.muted ?? true)
  const hoverTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Sync muted state when prop changes (e.g. Inspector toggle).
  useEffect(() => {
    setMutedState(videoObject.muted ?? true)
    const el = videoRef.current
    if (el !== null) el.muted = videoObject.muted ?? true
  }, [videoObject.muted])

  const handlePlayPause = useCallback(() => {
    const el = videoRef.current
    if (el === null) return
    if (el.paused) {
      void el.play().catch(() => undefined)
    } else {
      el.pause()
    }
  }, [])

  const handleMuteToggle = useCallback(() => {
    const el = videoRef.current
    if (el === null) return
    const next = !muted
    el.muted = next
    setMutedState(next)
    // Persist to the object via Y.Doc so Inspector stays in sync.
    if (objectsCtx !== null) {
      updateObject(objectsCtx, videoObject.id, {
        muted: next,
      } as SlideObjectPatch<VideoObject>)
    }
  }, [muted, objectsCtx, videoObject.id])

  // Clean up hover timeout on unmount.
  useEffect(() => {
    return () => {
      if (hoverTimeoutRef.current !== null) clearTimeout(hoverTimeoutRef.current)
    }
  }, [])

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

    // Track play/pause state for the hover controls bar icon.
    const onPlayIcon = (): void => setPlaying(true)
    const onPauseIcon = (): void => setPlaying(false)
    videoEl.addEventListener('play', onPlayIcon)
    videoEl.addEventListener('pause', onPauseIcon)

    return () => {
      videoEl.removeEventListener('play', onPlay)
      videoEl.removeEventListener('play', onPlayIcon)
      videoEl.removeEventListener('pause', onPauseIcon)
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
        // Editor: pointer-events:none passes clicks through to transform handles.
        // Present: accept clicks so the user can play/pause.
        pointerEvents: isPresent ? 'auto' : 'none',
      }}
    >
      <video
        ref={videoRef}
        muted={muted}
        autoPlay={false}
        loop={videoObject.loop ?? false}
        playsInline
        controls={videoObject.showControls === true}
        aria-label={videoObject.alt ?? undefined}
        onMouseEnter={() => {
          if (isPresent) return
          if (hoverTimeoutRef.current !== null) {
            clearTimeout(hoverTimeoutRef.current)
            hoverTimeoutRef.current = null
          }
          setHovered(true)
        }}
        onMouseLeave={() => {
          if (isPresent) return
          // Short debounce: allows the mouse to move from the video to the
          // controls bar without the bar disappearing.
          hoverTimeoutRef.current = setTimeout(() => setHovered(false), 80)
        }}
        onClick={(e) => {
          if (!isPresent) return
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

      {/* Edit-mode hover controls bar.
          Hover state is tracked on the video element (pointer-events:auto)
          with a short leave debounce so moving from the video to the bar
          doesn't immediately dismiss it. The bar buttons restore hover on
          mouseenter and clear the timeout. */}
      {!isPresent && hovered && (
        <div
          style={{
            pointerEvents: 'auto',
            // The bar lives inside the artboard, which is CSS-scaled by
            // `zoom`. Counter-scale by 1/zoom so the bar always renders
            // at native viewport size — at zoom=0.4 the bar would
            // otherwise be 40% of intended pixels (icons unreadable,
            // hit-targets tiny). transformOrigin: bottom keeps it
            // anchored to the video's bottom edge as it un-shrinks.
            transform: `translateX(-50%) scale(${zoom === 0 ? 1 : 1 / zoom})`,
            transformOrigin: 'bottom center',
            // Bump above transform handles (they sit on the same
            // coordinate space and would otherwise eat the click).
            zIndex: 50,
          }}
          onMouseEnter={() => {
            if (hoverTimeoutRef.current !== null) {
              clearTimeout(hoverTimeoutRef.current)
              hoverTimeoutRef.current = null
            }
          }}
          onMouseLeave={() => {
            hoverTimeoutRef.current = setTimeout(() => setHovered(false), 80)
          }}
          // -translate-x-1/2 is replaced by the inline transform above; the
          // class wrapper just provides positioning + visual chrome.
          className="absolute bottom-1.5 left-1/2 flex items-center gap-1 rounded-md bg-black/60 px-2 py-1 backdrop-blur-sm"
        >
          <button
            type="button"
            onClick={handlePlayPause}
            aria-label={playing ? 'Pause' : 'Play'}
            title={playing ? 'Pause' : 'Play'}
            className="flex h-6 w-6 items-center justify-center rounded text-white/90 hover:text-white"
          >
            {playing ? (
              <Pause className="h-3.5 w-3.5" aria-hidden="true" />
            ) : (
              <Play className="h-3.5 w-3.5" aria-hidden="true" />
            )}
          </button>
          <button
            type="button"
            onClick={handleMuteToggle}
            aria-label={muted ? 'Unmute' : 'Mute'}
            title={muted ? 'Unmute' : 'Mute'}
            className="flex h-6 w-6 items-center justify-center rounded text-white/90 hover:text-white"
          >
            {muted ? (
              <VolumeX className="h-3.5 w-3.5" aria-hidden="true" />
            ) : (
              <Volume2 className="h-3.5 w-3.5" aria-hidden="true" />
            )}
          </button>
        </div>
      )}
    </div>
  )
}
