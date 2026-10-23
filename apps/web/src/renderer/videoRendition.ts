/**
 * renderer/videoRendition.ts — which file present mode plays for a video
 * (docs/plans/performance.md, P3).
 *
 * A video larger than 1920×1080 has a second playback file fitted into
 * 1920×1080 (the video worker's present.mp4). A 4K original decodes and
 * uploads 8.3 Mpx a frame however small it is shown; the rendition a quarter
 * of that. It is played when it is enough: when the video's picture, as the
 * slide draws it at the presentation's device-pixel scale, needs no more
 * pixels than the rendition has. Where more are shown (a Retina display, a
 * 4K screen at 2×) the original plays, so nothing looks softer than before.
 *
 * The device-pixel scale (`presentDeviceScale`) is the smaller of two: the
 * slide's size on screen in device pixels, and the present canvas's own
 * density. Present mode draws into a 1920×1080 canvas at the renderer's
 * resolution (Canvas.tsx) and the browser scales that canvas to the screen,
 * so a 4K projector at 1× still shows the canvas's 1920 pixels, and a small
 * window shows fewer than the canvas has.
 */

export interface PlaybackChoice {
  url: string
  /** Which file: the rendition, or the original playback. */
  kind: 'present' | 'playback'
}

/**
 * A diagnostic of the perf harness (present.spec.ts, PERF_VIDEO_RENDITION_AB):
 * play this file wherever the video has it, whatever the screen. Null: choose.
 */
let forcedKind: PlaybackChoice['kind'] | null = null

/** Force a file for every video chosen from now on (null: choose again). Perf harness only. */
export function forcePlaybackKind(kind: PlaybackChoice['kind'] | null): void {
  forcedKind = kind
}

/**
 * The file to play: `presentPlayback` when its pixels cover what the video
 * shows, else `playbackUrl`.
 *
 * @param video     the object's box on the slide (slide px) and its fit
 * @param deviceScale device pixels per slide pixel of the presentation
 *                   (`presentDeviceScale`)
 */
export function choosePlayback(
  info: {
    playbackUrl: string | null
    presentPlayback: { url: string; width: number; height: number } | null
  },
  video: { width: number; height: number; fit?: 'cover' | 'contain' | undefined },
  deviceScale: number,
): PlaybackChoice | null {
  const present = info.presentPlayback
  const hasPresent = present !== null && present.width > 0 && present.height > 0
  if (forcedKind === 'present' && hasPresent) return { url: present.url, kind: 'present' }
  if (forcedKind !== 'playback' && hasPresent) {
    // The picture's scale in its box, measured against the rendition (the
    // original has the same aspect): cover fills the box, contain fits it.
    const sx = video.width / present.width
    const sy = video.height / present.height
    const k = (video.fit === 'cover' ? Math.max(sx, sy) : Math.min(sx, sy)) * deviceScale
    // Device pixels per rendition pixel: at most one, and the rendition is enough.
    if (k <= 1 + 1e-6) return { url: present.url, kind: 'present' }
  }
  if (info.playbackUrl !== null) return { url: info.playbackUrl, kind: 'playback' }
  return hasPresent ? { url: present.url, kind: 'present' } : null
}

/** Device pixels per slide pixel when a 1920×1080 slide fills this window (present mode). */
export function presentStageScale(
  view: { innerWidth: number; innerHeight: number; devicePixelRatio: number } = window,
): number {
  return Math.min(view.innerWidth / 1920, view.innerHeight / 1080) * (view.devicePixelRatio || 1)
}

/**
 * Device pixels a slide pixel of the presentation shows: the slide's width
 * on screen (CSS px, its scale-to-fit applied; null: the window's fit) in
 * device pixels, but no more than the canvas's density (device pixels per
 * slide unit, SceneGraph.getPixelDensity; null: unknown, not capped).
 */
export function presentDeviceScale(
  canvasDensity: number | null,
  shownWidth: number | null,
  view: { innerWidth: number; innerHeight: number; devicePixelRatio: number } = window,
): number {
  const onScreen =
    shownWidth !== null && shownWidth > 0
      ? (shownWidth / 1920) * (view.devicePixelRatio || 1)
      : presentStageScale(view)
  return canvasDensity !== null && canvasDensity > 0 ? Math.min(canvasDensity, onScreen) : onScreen
}
