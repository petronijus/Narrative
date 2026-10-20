/**
 * renderer/videoRendition.ts — which file present mode plays for a video
 * (docs/plans/performance.md, P3).
 *
 * A video larger than 1920×1080 has a second playback file fitted into
 * 1920×1080 (the video worker's present.mp4). A 4K original decodes and
 * uploads 8.3 Mpx a frame however small it is shown; the rendition a quarter
 * of that. It is played when it is enough for the screen: when the video's
 * picture, as the slide draws it at the presentation's size in device
 * pixels, needs no more pixels than the rendition has. On a larger or denser
 * screen (a 4K projector, a Retina display) the original plays, so nothing
 * looks softer than before.
 */

export interface PlaybackChoice {
  url: string
  /** Which file: the rendition, or the original playback. */
  kind: 'present' | 'playback'
}

/**
 * The file to play: `presentPlayback` when its pixels cover what the video
 * shows, else `playbackUrl`.
 *
 * @param video     the object's box on the slide (slide px) and its fit
 * @param stageScale device pixels per slide pixel of the presentation
 *                   (its size on screen × devicePixelRatio)
 */
export function choosePlayback(
  info: {
    playbackUrl: string | null
    presentPlayback: { url: string; width: number; height: number } | null
  },
  video: { width: number; height: number; fit?: 'cover' | 'contain' | undefined },
  stageScale: number,
): PlaybackChoice | null {
  const present = info.presentPlayback
  if (present !== null && present.width > 0 && present.height > 0) {
    // The picture's scale in its box, measured against the rendition (the
    // original has the same aspect): cover fills the box, contain fits it.
    const sx = video.width / present.width
    const sy = video.height / present.height
    const k = (video.fit === 'cover' ? Math.max(sx, sy) : Math.min(sx, sy)) * stageScale
    // Device pixels per rendition pixel: at most one, and the rendition is enough.
    if (k <= 1 + 1e-6) return { url: present.url, kind: 'present' }
  }
  return info.playbackUrl !== null ? { url: info.playbackUrl, kind: 'playback' } : null
}

/** Device pixels per slide pixel when a 1920×1080 slide fills this window (present mode). */
export function presentStageScale(
  view: { innerWidth: number; innerHeight: number; devicePixelRatio: number } = window,
): number {
  return Math.min(view.innerWidth / 1920, view.innerHeight / 1080) * (view.devicePixelRatio || 1)
}
