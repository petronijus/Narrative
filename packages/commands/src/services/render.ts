/**
 * services/render.ts — slides rendered to PNG by the render worker (agentic A3,
 * docs/plans/a3-render-worker.md): the real web renderer in headless Chromium,
 * on the deck's LIVE document, so a render right after an edit shows it.
 */

/** A slide of the deck: by id, or by 0-based position. */
export type RenderSlideRef = { id: string } | { index: number }

export interface RenderedPngInfo {
  slideId: string
  /** 0-based position in the deck when it was rendered. */
  index: number
  width: number
  height: number
  sizeBytes: number
  /**
   * Loads that failed while the slide painted — a picture that no longer
   * exists shows its error mark, as in the editor.
   */
  failedLoads: number
}

export type PngExportResult =
  | {
      delivery: 'url'
      slides: Array<RenderedPngInfo & { url: string }>
      /** When the links stop working. */
      expiresAt: string
      /** Font families with a face that failed to load (their text shows a fallback face). */
      failedFonts: string[]
    }
  | {
      delivery: 'base64'
      slides: Array<RenderedPngInfo & { base64: string }>
      failedFonts: string[]
    }

export interface RenderService {
  /**
   * PNGs (1920×1080) of slides of the live deck (any reader of the deck).
   * `slides: 'all'` renders every slide, up to the per-call limit; a slide that does not
   * exist is `not_found` before anything renders.
   */
  exportPng(args: {
    userId: string
    deckId: string
    slides: RenderSlideRef[] | 'all'
    delivery: 'url' | 'base64'
  }): Promise<PngExportResult>
}
