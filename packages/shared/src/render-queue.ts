/**
 * render-queue.ts
 *
 * The BullMQ queue and job shapes between the server (which asks for a render)
 * and apps/render-worker (which drives headless Chromium on the real web app's
 * render page, `/deck/:id/render`). Agentic A3, docs/plans/a3-render-worker.md.
 * Kept in @narrative/shared so neither app depends on the other.
 *
 * The worker holds no storage credentials: the server hands it one presigned
 * PUT URL per slide, so it can write exactly those objects and nothing else.
 *
 * Two clocks bound a job: `deadline`, when its caller stops waiting (the same
 * for every request, under Cloudflare's 100 s), and `workBudgetMs`, how long
 * the worker may spend on it once it starts (by its size). The worker stops a
 * job at whichever comes first, so no job holds the one-at-a-time worker
 * longer than its size warrants, however long it waited.
 */

export const RENDER_QUEUE = 'render'

export interface RenderUpload {
  slideId: string
  /** Presigned PUT to the slide's object; expires with the job. */
  url: string
  /**
   * Headers the PUT must send exactly as given: they are part of the
   * signature (the stored object's type and caching), so storage refuses a
   * PUT without them.
   */
  headers: Record<string, string>
}

export interface RenderJobData {
  deckId: string
  /** The slides to render, in the order the result lists them, each with where its PNG goes. */
  uploads: RenderUpload[]
  /**
   * A render token (`nrr_…`, apps/server/src/auth/renderTokens.ts): the page
   * opens with it as `share_token`. Minted for this job, valid until a little
   * after `deadline`; never logged.
   */
  token: string
  /**
   * Epoch milliseconds after which nobody waits for this job: the worker does
   * not start it, and stops it (closing its page) if it is still running.
   */
  deadline: number
  /** Milliseconds the worker may spend on the job from its start (stopped like at the deadline). */
  workBudgetMs: number
}

/** Every slide renders at its own size (agentic A3: 1920×1080, no other scale). */
export const RENDER_WIDTH = 1920
export const RENDER_HEIGHT = 1080

export interface RenderedSlide {
  slideId: string
  /** 0-based position in the deck when it was rendered. */
  index: number
  width: number
  height: number
  sizeBytes: number
  /** Loads that failed while this slide painted (a missing picture shows its error mark). */
  failedLoads: number
}

export interface RenderJobResult {
  slides: RenderedSlide[]
  /**
   * Font families with a face that failed to load: text in them shows a
   * fallback face. Fonts load once for the page, so this is the job's, not a
   * slide's.
   */
  failedFonts: string[]
}

/** Why a slide could not be rendered — the render page's error reasons, and the worker's own. */
export type RenderFailureReason =
  | 'access-refused'
  | 'empty-deck'
  | 'slide-not-found'
  | 'fonts-unavailable'
  | 'not-ready'
  | 'not-settled'
  | 'deadline'
  | 'late'
  | 'upload'
  | 'browser'

/**
 * The message of a failed render job: `render failed (<reason>): <detail>`,
 * so the server can tell a missing slide (the caller's mistake) from a
 * renderer fault.
 */
export function renderFailureMessage(reason: RenderFailureReason, detail: string): string {
  return `render failed (${reason}): ${detail}`
}

/** The reason in a failed render job's message, or null when it is not one. */
export function parseRenderFailure(message: string): RenderFailureReason | null {
  const match = /^render failed \(([a-z-]+)\)/.exec(message)
  return (match?.[1] as RenderFailureReason | undefined) ?? null
}
