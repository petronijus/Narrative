/**
 * renderer/videoPlaybackTrial.ts — can this engine play a video's original
 * smoothly on this canvas? Played for a moment and measured, during present
 * mode's upfront load (docs/plans/performance.md → P3).
 *
 * A playing video costs a decode, an upload of every decoded frame into the
 * canvas's WebGL context (Pixi's VideoSource) and the slide drawn around it,
 * every display frame. What that adds up to depends on the engine, the GPU,
 * the file and the canvas's size, and nothing cheaper predicts it: an upload
 * into a scratch context took 1–3 ms for a 4K frame in WebKit, whose window
 * at 2× then played it at 26 fps, and 10.7 ms in Chromium, which played it
 * without a miss (2026-10-26). So the buffered original is played here,
 * muted, for `TRIAL_MS`, through the presentation's own renderer: its frames
 * uploaded through the shared VideoSource as the slide's scene will upload
 * them (objectRenderers/videoRenderer.ts → borrowVideoSource), drawn each
 * animation frame into a render texture of the canvas's size and density
 * (antialiased, as the canvas is). The animation-frame intervals and the
 * video frames handed on decide (videoRendition.ts → playbackTrialSmooth).
 * Afterwards the element is paused and put back where it was, unmuted as it
 * was; its texture leaves the GPU.
 *
 * One trial per frame size and canvas: its verdict is reused for every video
 * of that size in the presentation. Present mode may take its time before
 * the first slide; it must not hitch after it.
 */

import { Container, RenderTexture, Sprite, Texture, type Renderer } from 'pixi.js'
import { borrowVideoSource, returnVideoSource } from './objectRenderers/videoRenderer.js'
import { playbackTrialSmooth } from './videoRendition.js'

/** How long a trial plays (ms). */
export const TRIAL_MS = 1200

const verdicts = new Map<string, Promise<boolean>>()
/** The perf harness's override (e2e/present-video-rendition.spec.ts): every trial's verdict, without playing. */
let forcedVerdict: boolean | null = null

/** Decide every trial from now on (null: play them). Perf harness only. */
export function forceTrialVerdict(smooth: boolean | null): void {
  forcedVerdict = smooth
}
/** Trials run one at a time: two playing at once would each see the other's cost. */
let lastTrial: Promise<unknown> = Promise.resolve()

type FrameCallbackVideo = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: (now: number, meta: { mediaTime: number }) => void) => number
}

/**
 * Whether `el` (buffered, paused on its first frame) plays smoothly through
 * `renderer` at the canvas's size. True when it cannot be tried (it would
 * not play): the screen decides then, as without a trial.
 */
export function playsSmoothly(renderer: Renderer, el: HTMLVideoElement): Promise<boolean> {
  if (forcedVerdict !== null) return Promise.resolve(forcedVerdict)
  const { width, height } = renderer.screen
  const key = `${el.videoWidth}x${el.videoHeight}@${width}x${height}x${renderer.resolution}`
  let verdict = verdicts.get(key)
  if (verdict === undefined) {
    verdict = lastTrial.then(() => trial(renderer, el, width, height))
    lastTrial = verdict.catch(() => undefined)
    verdicts.set(key, verdict)
  }
  return verdict
}

async function trial(
  renderer: Renderer,
  el: FrameCallbackVideo,
  width: number,
  height: number,
): Promise<boolean> {
  if (el.videoWidth === 0 || typeof el.requestVideoFrameCallback !== 'function') return true
  const startAt = el.currentTime
  const muted = el.muted
  const source = borrowVideoSource(el)
  const texture = new Texture({ source })
  const sprite = new Sprite(texture)
  sprite.width = width
  sprite.height = height
  const stage = new Container()
  stage.addChild(sprite)
  const target = RenderTexture.create({
    width,
    height,
    resolution: renderer.resolution,
    antialias: true,
  })
  const frameMs: number[] = []
  const mediaTimes: number[] = []
  let stopped = false
  try {
    el.muted = true
    await el.play()
    const onFrame = (_now: number, meta: { mediaTime: number }): void => {
      if (stopped) return
      mediaTimes.push(meta.mediaTime)
      el.requestVideoFrameCallback!(onFrame)
    }
    el.requestVideoFrameCallback(onFrame)
    await new Promise<void>((resolve) => {
      let last = -1
      const t0 = performance.now()
      const tick = (t: number): void => {
        if (last >= 0) frameMs.push(t - last)
        last = t
        renderer.render({ container: stage, target, clear: true })
        if (t - t0 < TRIAL_MS && !el.ended) requestAnimationFrame(tick)
        else resolve()
      }
      requestAnimationFrame(tick)
    })
  } catch {
    // It would not play (a policy, a decode error): untried.
    return true
  } finally {
    stopped = true
    el.pause()
    el.muted = muted
    stage.destroy({ children: true })
    texture.destroy(false)
    target.destroy(true)
    returnVideoSource(el)
    if (Math.abs(el.currentTime - startAt) > 0.01) {
      el.currentTime = startAt
      await new Promise((resolve) => {
        el.addEventListener('seeked', resolve, { once: true })
        setTimeout(resolve, 5000)
      })
    }
  }
  const smooth = playbackTrialSmooth({ frameMs, mediaTimes })
  if (!smooth)
    console.info(
      `[presentVideos] a ${el.videoWidth}×${el.videoHeight} video did not play smoothly on this ` +
        `canvas (${frameMs.length} frames, ${mediaTimes.length} video frames): its rendition plays`,
    )
  return smooth
}

/** Forget the verdicts (tests). */
export function _resetPlaybackTrials(): void {
  verdicts.clear()
  lastTrial = Promise.resolve()
}
