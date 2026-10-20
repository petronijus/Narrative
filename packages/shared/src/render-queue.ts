/**
 * render-queue.ts
 *
 * The BullMQ queue and job shapes between the server (which asks for a render)
 * and apps/render-worker (which drives headless Chromium on the real web app's
 * render page, `/deck/:id/render`). Agentic A3, docs/plans/a3-render-worker.md.
 * Kept in @narrative/shared so neither app depends on the other.
 *
 * The worker holds no storage credentials: the server hands it one presigned
 * PUT URL per picture, so it can write exactly those objects and nothing
 * else.
 *
 * Two clocks bound a job: `deadline`, when its caller stops waiting (the same
 * for every request, under Cloudflare's 100 s), and `workBudgetMs`, how long
 * the worker may spend on it once it starts (by its size). The worker stops a
 * job at whichever comes first, so no job holds the one-at-a-time worker
 * longer than its size warrants, however long it waited.
 */

export const RENDER_QUEUE = 'render'

/** Where one picture goes: a presigned PUT of `image/png`, expiring with the job. */
export interface RenderTarget {
  url: string
  /**
   * Headers the PUT must send exactly as given: they are part of the
   * signature (the stored object's type and caching), so storage refuses a
   * PUT without them.
   */
  headers: Record<string, string>
}

export interface RenderUpload extends RenderTarget {
  slideId: string
}

/**
 * The render page a job opens: a deck's (`/deck/:id/render`), or a component
 * master's (`/folder/:f/component/:c/render`, for the master's card).
 */
export type RenderPage =
  { kind: 'deck'; deckId: string } | { kind: 'component'; componentId: string; folderId: string }

/** The page's path (no query). */
export function renderPagePath(page: RenderPage): string {
  return page.kind === 'deck'
    ? `/deck/${encodeURIComponent(page.deckId)}/render`
    : `/folder/${encodeURIComponent(page.folderId)}/component/${encodeURIComponent(page.componentId)}/render`
}

/** A short name of the page's document, for logs and keys (`deck:<id>`, `component:<id>`). */
export function renderPageName(page: RenderPage): string {
  return page.kind === 'deck' ? `deck:${page.deckId}` : `component:${page.componentId}`
}

interface RenderJobBase {
  page: RenderPage
  /**
   * A render token (`nrr_…`, apps/server/src/auth/renderTokens.ts): the page
   * opens with it as `share_token`. The server keeps one per person and deck
   * for a few minutes (a render session) and the worker keeps the page it
   * opened with it, switching slides in place, so the next job for that deck
   * skips loading the app. Never logged.
   */
  token: string
  /**
   * Base64 of Y.encodeStateVector of the live deck when the job was made:
   * the page draws only once its own copy holds those edits, so a job right
   * after a command shows that command — a page kept from an earlier job
   * included.
   */
  stateVector: string
  /**
   * Epoch milliseconds after which nobody waits for this job: the worker does
   * not start it, and stops it (closing its page) if it is still running.
   */
  deadline: number
  /** Milliseconds the worker may spend on the job from its start (stopped like at the deadline). */
  workBudgetMs: number
  /**
   * false: close the page after the job instead of keeping it warm — the
   * server's background work (a deck's card picture), which must not push a
   * person's warm page out. Absent means keep it.
   */
  keepPage?: boolean
}

/** PNGs of slides at their own size (1920×1080), one upload each: the PNG export. */
export interface RenderExportJob extends RenderJobBase {
  kind: 'export'
  /** The slides to render, in the order the result lists them, each with where its picture goes. */
  uploads: RenderUpload[]
  /**
   * How each slide is encoded in the page: `png` (absent: the PNG export,
   * lossless) or `jpeg` — a PDF's pages, flattened on white at
   * `RENDER_JPEG_QUALITY`, which the server embeds as they are instead of
   * decoding a PNG and encoding it again. A page older than this field
   * answers PNG whatever it is asked; the server checks what it got.
   */
  format?: 'png' | 'jpeg'
}

/** The JPEG quality of a PDF page encoded in the render page (0–1, the canvas API's scale). */
export const RENDER_JPEG_QUALITY = 0.85

/**
 * A look's size limits — what a model reads of an image without scaling it
 * down first (Claude: 1568 px on the long edge, about 1.15 megapixels;
 * agentic-layer §4.6). A slide comes out at 1430×804.
 */
export const LOOK_MAX_EDGE = 1568
export const LOOK_MAX_PIXELS = 1_150_000

/**
 * A deck's card picture (`thumbnail` looks): the size the folder page's
 * imgproxy `thumb` variant shows (400×225, which never enlarges).
 */
export const THUMBNAIL_WIDTH = 400
export const THUMBNAIL_HEIGHT = 225

/**
 * What the render page composes from slides: what an agent looks at
 * (`query.render`) or a deck's card — one picture, composed in the page.
 */
export type RenderLookSpec =
  /** A slide, downscaled to `LOOK_MAX_EDGE` on its long edge. */
  | { mode: 'slide'; slideId: string }
  /** A region of a slide (slide px) at full resolution, downscaled only past `LOOK_MAX_EDGE`. */
  | {
      mode: 'region'
      slideId: string
      region: { x: number; y: number; width: number; height: number }
    }
  /** Many slides in a grid, each labelled with its number, within `LOOK_MAX_EDGE`. */
  | { mode: 'sheet'; slideIds: string[] }
  /** A slide as the deck's card picture, `THUMBNAIL_WIDTH`×`THUMBNAIL_HEIGHT`. */
  | { mode: 'thumbnail'; slideId: string }
  /**
   * A slide before and after, side by side, within `LOOK_MAX_EDGE`. `before`
   * is where the server stored the whole document as it was at the start of
   * the current agent run (`Y.encodeStateAsUpdate`, a presigned GET — the
   * state never travels in the queue): the worker fetches it, draws the
   * slide on a page of its own that holds that state and nothing live, then
   * hands the picture to the live page, which draws the slide as it is now
   * beside it.
   */
  | { mode: 'compare'; slideId: string; before: { url: string } }

/**
 * A look as the render page takes it (`__narrativeRenderLook`): a compare
 * carries the "before" picture the worker drew on the frozen page (base64
 * PNG; null when the slide did not exist then), not the document state.
 */
export type RenderPageLookSpec =
  | Exclude<RenderLookSpec, { mode: 'compare' }>
  | { mode: 'compare'; slideId: string; beforePng: string | null }

export interface RenderLookJob extends RenderJobBase {
  kind: 'look'
  look: RenderLookSpec
  /** Where the picture goes. */
  upload: RenderTarget
}

export type RenderJobData = RenderExportJob | RenderLookJob

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

/**
 * A text box whose laid-out text — measured on the page, with the real fonts
 * — runs below its box (slide px).
 */
export interface TextOverflow {
  slideId: string
  objectId: string
  boxHeight: number
  textHeight: number
}

/**
 * A text box that grows with its text (`autofit: 'grow-down'`, A4.2a) and
 * the height it is drawn at, measured on the page (slide px) — what the
 * brand checker compares with the region below it (A4.5).
 */
export interface GrownText {
  slideId: string
  objectId: string
  height: number
}

export interface RenderedLook {
  width: number
  height: number
  sizeBytes: number
  /** The slides in it, in the order shown, with their position and failed loads. */
  slides: Array<{ slideId: string; index: number; failedLoads: number }>
  /** Its slides' text boxes that overflow (a compare: the slide now, not before). */
  overflow: TextOverflow[]
  /** Its slides' growing text boxes as drawn (A4.5); absent from a worker older than A4.5. */
  grown?: GrownText[]
  /** A compare whose slide did not exist at the start of the run: its "before" side is empty. */
  newSlide?: boolean
}

/**
 * A job's result. `failedFonts`: font families with a face that failed to
 * load — text in them shows a fallback face. Fonts load once for the page, so
 * this is the job's, not a slide's.
 */
export type RenderJobResult =
  | { kind: 'export'; slides: RenderedSlide[]; failedFonts: string[] }
  | { kind: 'look'; look: RenderedLook; failedFonts: string[] }

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
