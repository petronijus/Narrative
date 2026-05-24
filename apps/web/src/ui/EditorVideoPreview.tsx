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
// hls.js stays as a static import here — manual-chunks splits it into its
// own vendor file (vendor-hls) so it doesn't bloat the main app chunk, but
// importing eagerly preserves the original sync attach-order that the
// videoRenderer relies on.
import Hls from 'hls.js'
import { Play, Pause, Volume2, VolumeX } from 'lucide-react'
import type { VideoObject, SlideObjectPatch } from '@narrative/shared'
import { useVideoInfo } from '../state/useVideoInfo.js'
import { useSlideObjects } from '../state/useSlideObjects.js'
import { useZoomLevel } from '../state/useZoomLevel.js'
import { updateObject } from '@narrative/slide-model'
import {
  attachLiveVideo as attachLiveVideoToRenderer,
  detachLiveVideo as detachLiveVideoFromRenderer,
} from '../renderer/objectRenderers/videoRenderer'

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

  // Latest trim / poster values held in refs so the HLS-attach effect's
  // listeners always read the current value WITHOUT re-running (which
  // would tear down HLS and rewind the video to the start — that's
  // exactly what made trim-end-handle scrubs jump to the wrong frame).
  const trimStartRef = useRef(videoObject.trimStart ?? 0)
  const trimEndRef = useRef(videoObject.trimEnd ?? 0)
  const posterTimeRef = useRef(videoObject.posterTime ?? 0)
  useEffect(() => {
    trimStartRef.current = Math.max(0, videoObject.trimStart ?? 0)
    trimEndRef.current = videoObject.trimEnd ?? 0
    posterTimeRef.current = videoObject.posterTime ?? 0
  }, [videoObject.trimStart, videoObject.trimEnd, videoObject.posterTime])

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

    // Hand the videoEl to the Pixi videoRenderer the moment it's ready —
    // the renderer rebuilds the sprite from a live VideoSource so the
    // video lives inside the Pixi scene graph (and therefore respects
    // Y.Array layer order). Used in BOTH editor and present mode so the
    // visible representation is always the Pixi sprite. The DOM <video>
    // stays around (invisible) so hls.js / VideoSource can decode into
    // it and audio plays normally.
    const onCanPlay = (): void => {
      attachLiveVideoToRenderer(videoObject.id, videoEl)
    }
    if (videoEl.readyState >= 2) attachLiveVideoToRenderer(videoObject.id, videoEl)
    else videoEl.addEventListener('canplay', onCanPlay, { once: true })

    if (isPresent && videoObject.autoplay === true && videoObject.playOnClick !== true) {
      const onCanPlay = (): void => {
        void videoEl.play().catch(() => undefined)
      }
      videoEl.addEventListener('canplay', onCanPlay, { once: true })
    }

    // Initial seek: poster frame wins, then trimStart, then 0. Computed
    // on the first loadedmetadata so it reflects the latest values from
    // the refs (not a stale closure capture).
    videoEl.addEventListener(
      'loadedmetadata',
      () => {
        const trimStart = trimStartRef.current
        const posterTime = posterTimeRef.current
        const initialSeek = posterTime > 0 ? Math.max(trimStart, posterTime) : trimStart
        if (initialSeek > 0) videoEl.currentTime = initialSeek
      },
      { once: true },
    )
    // Rewind to trimStart on Play if we're sitting on the poster preview.
    const onPlay = (): void => {
      const posterTime = posterTimeRef.current
      const trimStart = trimStartRef.current
      if (posterTime > 0 && Math.abs(videoEl.currentTime - posterTime) < 0.05) {
        videoEl.currentTime = trimStart
      }
    }
    videoEl.addEventListener('play', onPlay)
    const onTimeUpdate = (): void => {
      const trimEnd = trimEndRef.current
      if (trimEnd > 0 && videoEl.currentTime >= trimEnd) {
        // With loop enabled, jump back to trimStart and keep playing —
        // the native videoEl.loop only loops between 0 and full
        // duration, ignoring our trim range.
        if (videoObject.loop === true) {
          videoEl.currentTime = trimStartRef.current
          if (videoEl.paused) void videoEl.play().catch(() => undefined)
        } else {
          videoEl.pause()
        }
      }
    }
    videoEl.addEventListener('timeupdate', onTimeUpdate)

    // Publish currentTime + a seek() handle on a window registry. The
    // Inspector's trim filmstrip / poster-frame slider use seek() to
    // scrub the underlying <video> while dragging so the user sees the
    // exact frame they're trimming to.
    const reg = window as unknown as {
      __narrative_video_currents?: Record<
        string,
        { currentTime: number; seek?: (sec: number) => void }
      >
    }
    if (reg.__narrative_video_currents === undefined) reg.__narrative_video_currents = {}
    const currents = reg.__narrative_video_currents
    currents[videoObject.id] = {
      currentTime: 0,
      seek: (sec: number) => {
        if (videoEl.readyState < 1) return
        if (!videoEl.paused) videoEl.pause()
        const safe = Math.max(0, Math.min(videoEl.duration || sec, sec))
        if (Math.abs(videoEl.currentTime - safe) > 0.01) {
          videoEl.currentTime = safe
        }
      },
    }
    const onTime = (): void => {
      const entry = currents[videoObject.id]
      if (entry !== undefined) entry.currentTime = videoEl.currentTime
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
      delete currents[videoObject.id]
      detachLiveVideoFromRenderer(videoObject.id)
      if (hlsRef.current !== null) {
        hlsRef.current.destroy()
        hlsRef.current = null
      }
    }
    // Trim / poster deps intentionally omitted — we read them from refs
    // inside the listeners so updates don't tear down HLS.
  }, [
    info?.transcodeStatus,
    info?.hlsManifestUrl,
    videoObject.id,
    videoObject.autoplay,
    videoObject.volume,
    isPresent,
  ])

  // While transcode hasn't finished, render nothing — the Pixi
  // poster placeholder painted by videoRenderer is enough.
  if (info?.transcodeStatus !== 'done') return null

  // The visible video lives inside the Pixi scene graph
  // (videoRenderer's VideoSource sprite), in BOTH editor and present
  // modes — that's what makes Y.Array layer order work. The DOM wrapper
  // here still spans the video's bounds so present-mode click-to-toggle
  // and the editor's hover-controls bar land on the right region; the
  // inner <video> element itself is invisible because Pixi paints it.
  return (
    <div
      style={{
        position: 'absolute',
        left: videoObject.x,
        top: videoObject.y,
        width: videoObject.width,
        height: videoObject.height,
        transform: `rotate(${videoObject.rotation}rad)`,
        transformOrigin: 'center',
        // Pixi sprite handles opacity for the visible representation;
        // the wrapper itself just hosts the (invisible) <video> + the
        // hover-controls bar.
        opacity: 1,
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
        // The Pixi sprite is the visible representation; the DOM
        // <video> is just a decoder host. Hide it from accessibility
        // tree so screen readers don't announce it twice (alt text is
        // already exposed by whatever the deck / present mode chooses
        // to surface).
        aria-hidden="true"
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
          // The Pixi sprite is the visible representation in both modes,
          // so always hide this <video> — keeping it in DOM is required
          // for hls.js / VideoSource to decode into and for audio.
          opacity: 0,
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
            transform: `translateX(-50%) scale(${zoom === 0 ? 1 : 1 / zoom})`,
            transformOrigin: 'bottom center',
            zIndex: 50,
          }}
          // Stop pointer events from bubbling to canvas-backdrop. Without
          // this, EditorLayout's onPointerDown hit-tests the click,
          // selects the video, and (worse) sets pointer-capture on the
          // backdrop — so the subsequent mouseup never reaches our
          // button and click never fires.
          onPointerDown={(e) => e.stopPropagation()}
          onPointerUp={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
          onMouseEnter={() => {
            if (hoverTimeoutRef.current !== null) {
              clearTimeout(hoverTimeoutRef.current)
              hoverTimeoutRef.current = null
            }
          }}
          onMouseLeave={() => {
            hoverTimeoutRef.current = setTimeout(() => setHovered(false), 80)
          }}
          className="absolute bottom-1.5 left-1/2 flex items-center gap-1 rounded-md bg-black/60 px-2 py-1 backdrop-blur-xs"
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
