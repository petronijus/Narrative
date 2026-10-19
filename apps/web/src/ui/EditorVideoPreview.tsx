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
 * Present mode renders it too, with the video the presentation buffered
 * before it started (renderer/presentVideos.ts, through
 * present/presentVideosContext.ts): that element is already on its first
 * frame and attached to the renderer, so the preview only plays it — no
 * video-info request, no load, no poster-to-live swap on the advance — and
 * hands it back paused on its first frame when the slide leaves the stage.
 */

import { useEffect, useRef, useState, useCallback } from 'react'
import { Play, Pause, Volume2, VolumeX } from 'lucide-react'
import type { VideoObject } from '@narrative/shared'
import { useVideoInfo } from '../state/useVideoInfo.js'
import { usePresentVideos } from '../present/presentVideosContext.js'
import { useActiveSlide } from '../state/ActiveSlideContext.js'
import { useCommand } from '../state/useCommand.js'
import { useZoomLevel } from '../state/useZoomLevel.js'
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
  // Present mode: the element the presentation buffered for this object.
  const presentVideos = usePresentVideos()
  const pooled = isPresent ? (presentVideos?.pool.get(videoObject.id) ?? null) : null
  const { info: fetchedInfo, refresh } = useVideoInfo(
    pooled === null && videoObject.assetId !== '' ? videoObject.assetId : null,
  )
  const info = pooled?.info ?? fetchedInfo
  const videoRef = useRef<HTMLVideoElement | null>(null)
  // Read by the playback effect's listeners and cleanup (the context value is set once).
  const presentVideosRef = useRef(presentVideos)
  useEffect(() => {
    presentVideosRef.current = presentVideos
  }, [presentVideos])
  // MEDIA-1: refresh via ref so the playback effect's dep array stays stable.
  const refreshRef = useRef(refresh)
  refreshRef.current = refresh
  // The preview shows an object of the active slide (it is the slide the
  // editor and present mode render).
  const { activeSlideId } = useActiveSlide()
  const command = useCommand()
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
    const el = pooled?.element ?? videoRef.current
    if (el !== null) el.muted = videoObject.muted ?? true
  }, [videoObject.muted, pooled])

  const handlePlayPause = useCallback(() => {
    const el = pooled?.element ?? videoRef.current
    if (el === null) return
    if (el.paused) {
      void el.play().catch(() => undefined)
    } else {
      el.pause()
    }
  }, [pooled])

  const handleMuteToggle = useCallback(() => {
    const el = pooled?.element ?? videoRef.current
    if (el === null) return
    const next = !muted
    el.muted = next
    setMutedState(next)
    // Persist on the object so the Inspector stays in sync.
    if (activeSlideId !== null) {
      command.tryRun('object.update', {
        slide: activeSlideId,
        object: videoObject.id,
        patch: { muted: next },
      })
    }
  }, [muted, activeSlideId, command, videoObject.id, pooled])

  // Clean up hover timeout on unmount.
  useEffect(() => {
    return () => {
      if (hoverTimeoutRef.current !== null) clearTimeout(hoverTimeoutRef.current)
    }
  }, [])

  // Latest trim / poster values held in refs so the playback-attach effect's
  // listeners always read the current value WITHOUT re-running (which
  // would tear down the video source and rewind to the start — that's
  // exactly what made trim-end-handle scrubs jump to the wrong frame).
  const trimStartRef = useRef(videoObject.trimStart ?? 0)
  const trimEndRef = useRef(videoObject.trimEnd ?? 0)
  const posterTimeRef = useRef(videoObject.posterTime ?? 0)
  useEffect(() => {
    trimStartRef.current = Math.max(0, videoObject.trimStart ?? 0)
    trimEndRef.current = videoObject.trimEnd ?? 0
    posterTimeRef.current = videoObject.posterTime ?? 0
  }, [videoObject.trimStart, videoObject.trimEnd, videoObject.posterTime])

  // Wire up the progressive MP4 the moment we have a playbackUrl.
  useEffect(() => {
    if (info?.transcodeStatus !== 'done') return
    const playbackUrl = info.playbackUrl
    if (playbackUrl === null) return
    const videoEl = pooled?.element ?? videoRef.current
    if (videoEl === null) return

    // Volume + autoplay only matter in present mode. Editor stays muted/paused.
    if (isPresent) {
      videoEl.volume = Math.max(0, Math.min(1, videoObject.volume ?? 1))
    }

    // A pooled element has its source, its first frame and its renderer
    // attachment already (renderer/presentVideos.ts).
    if (pooled === null) videoEl.src = playbackUrl

    // MEDIA-1: recover from an expired short-TTL presigned playback URL. If a
    // byte-range request 403s after the URL's TTL lapses, the <video> fires
    // `error`; re-fetch a freshly-signed URL once and re-point src, restoring
    // the play position. Guarded so a truly broken asset doesn't loop.
    let refreshing = false
    const onSrcError = (): void => {
      if (refreshing) return
      const code = videoEl.error?.code
      if (
        code !== MediaError.MEDIA_ERR_NETWORK &&
        code !== MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED
      ) {
        return
      }
      refreshing = true
      if (pooled !== null) {
        void presentVideosRef.current?.pool.refresh(videoObject.id).finally(() => {
          refreshing = false
        })
        return
      }
      const resumeAt = videoEl.currentTime
      const wasPlaying = !videoEl.paused
      void refreshRef
        .current()
        .then((fresh) => {
          if (fresh?.playbackUrl == null) return
          videoEl.src = fresh.playbackUrl
          videoEl.addEventListener(
            'loadedmetadata',
            () => {
              if (resumeAt > 0) videoEl.currentTime = resumeAt
              if (wasPlaying) void videoEl.play().catch(() => undefined)
            },
            { once: true },
          )
          videoEl.load()
        })
        .finally(() => {
          refreshing = false
        })
    }
    videoEl.addEventListener('error', onSrcError)

    // Hand the videoEl to the Pixi videoRenderer the moment it's ready —
    // the renderer rebuilds the sprite from a live VideoSource so the
    // video lives inside the Pixi scene graph (and therefore respects
    // Y.Array layer order). Used in BOTH editor and present mode so the
    // visible representation is always the Pixi sprite. The DOM <video>
    // stays around (invisible) so VideoSource can decode into it and
    // audio plays normally.
    const onCanPlay = (): void => {
      attachLiveVideoToRenderer(videoObject.id, videoEl)
    }
    if (pooled === null) {
      if (videoEl.readyState >= 2) attachLiveVideoToRenderer(videoObject.id, videoEl)
      else videoEl.addEventListener('canplay', onCanPlay, { once: true })
    }

    if (isPresent && videoObject.autoplay === true && videoObject.playOnClick !== true) {
      if (videoEl.readyState >= 2) {
        void videoEl.play().catch(() => undefined)
      } else {
        const onCanPlay = (): void => {
          void videoEl.play().catch(() => undefined)
        }
        videoEl.addEventListener('canplay', onCanPlay, { once: true })
      }
    }

    // Initial seek: poster frame wins, then trimStart, then 0. Computed
    // on the first loadedmetadata so it reflects the latest values from
    // the refs (not a stale closure capture). A pooled element is there already.
    if (pooled === null)
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
      videoEl.removeEventListener('error', onSrcError)
      delete currents[videoObject.id]
      if (pooled !== null) {
        // The pool's element stays attached: its slide's scene is kept.
        videoEl.removeEventListener('canplay', onCanPlay)
        presentVideosRef.current?.released(videoObject.id)
      } else {
        detachLiveVideoFromRenderer(videoObject.id)
      }
    }
    // Trim / poster deps intentionally omitted — we read them from refs
    // inside the listeners so updates don't tear down the video source.
  }, [
    info?.transcodeStatus,
    info?.playbackUrl,
    videoObject.id,
    videoObject.autoplay,
    videoObject.volume,
    isPresent,
    pooled,
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
      {pooled !== null ? (
        // The pooled element decodes out of sight (renderer/presentVideos.ts);
        // its box here takes the click that plays or pauses it.
        <div
          aria-hidden="true"
          style={{ width: '100%', height: '100%', pointerEvents: 'auto' }}
          onClick={handlePlayPause}
        />
      ) : (
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
            // for VideoSource to decode into and for audio.
            opacity: 0,
          }}
        />
      )}

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
