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
 * Where the original would be chosen, what it costs decides too: during the
 * load present mode plays it for a moment through the real renderer at the
 * canvas's size (renderer/videoPlaybackTrial.ts) and plays the rendition if
 * that missed display frames or skipped video frames (`playbackTrialSmooth`)
 * — present mode never hitches, a softer picture is the lesser evil. Measured
 * because neither the user agent nor an isolated upload says it: an upload
 * into a scratch context took 1–3 ms for a 4K frame in WebKit, whose 2×
 * window then played it at 26 fps, and 10.7 ms in Chromium, which played it
 * without a miss (2026-10-26).
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

/** Whether the perf harness forces a file (then no cost check overrides it). */
export function playbackForced(): boolean {
  return forcedKind !== null
}

/** What a short trial playback through the renderer saw (renderer/videoPlaybackTrial.ts). */
export interface PlaybackTrial {
  /** Animation-frame intervals while it played (ms). */
  frameMs: readonly number[]
  /** The media times of the video frames handed on (requestVideoFrameCallback), in order (s). */
  mediaTimes: readonly number[]
}

/** Display frames a trial may miss, and video frames it may skip, and still count as smooth. */
export const TRIAL_MISSES_ALLOWED = 1
/** The first intervals of a trial are its start (the decoder warming up): not counted. */
const TRIAL_WARMUP_FRAMES = 3

const quantile = (xs: readonly number[], q: number): number => {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor(s.length * q))]!
}

/**
 * Whether a trial playback was smooth: no more than `TRIAL_MISSES_ALLOWED`
 * display frames missed (an interval of n refresh periods misses n − 1; the
 * refresh period is the trial's own shortest common interval) and no more
 * video frames skipped (a media-time step of n frame durations skips n − 1).
 * An empty trial (nothing drawn, nothing played) says nothing: smooth.
 */
export function playbackTrialSmooth(t: PlaybackTrial): boolean {
  const frames = t.frameMs.slice(TRIAL_WARMUP_FRAMES)
  let missed = 0
  if (frames.length > 0) {
    const refresh = quantile(frames, 0.1)
    if (refresh > 0) for (const d of frames) missed += Math.max(0, Math.round(d / refresh) - 1)
  }
  const steps: number[] = []
  for (let i = 1; i < t.mediaTimes.length; i++) {
    const step = t.mediaTimes[i]! - t.mediaTimes[i - 1]!
    if (step > 0 && step < 1) steps.push(step)
  }
  let skipped = 0
  const counted = steps.slice(1)
  if (counted.length > 0) {
    const frame = quantile(steps, 0.5)
    for (const st of counted) skipped += Math.max(0, Math.round(st / frame) - 1)
  }
  return missed <= TRIAL_MISSES_ALLOWED && skipped <= TRIAL_MISSES_ALLOWED
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
