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

/**
 * What `query.render` looks at: a slide, a region of one (slide px), a sheet
 * of slides, or a slide before and after the agent run `runId` changed it.
 */
export type RenderView =
  | { slide: RenderSlideRef; region?: { x: number; y: number; width: number; height: number } }
  | { sheet: RenderSlideRef[] | 'all' }
  | { compare: RenderSlideRef; runId: string | null }

/**
 * A text box whose text, laid out with the real fonts, runs below its box
 * (slide px) — it overflows on the slide as people see it.
 */
export interface TextOverflowInfo {
  slideId: string
  /** 0-based position in the deck. */
  index: number
  objectId: string
  boxHeight: number
  textHeight: number
}

export interface RenderLookResult {
  mode: 'slide' | 'region' | 'sheet' | 'compare'
  width: number
  height: number
  /** The slides in the picture, in the order shown. */
  slides: Array<{ slideId: string; index: number; failedLoads: number }>
  /** Text boxes of those slides whose text overflows (a compare: the slide now), at most 50. */
  overflow: TextOverflowInfo[]
  /** More boxes overflow than `overflow` lists. */
  overflowTruncated?: boolean
  /** A compare of a slide the run added: there is no "before". */
  newSlide?: boolean
  failedFonts: string[]
  /** The picture; an MCP client gets it as image content, not as text. */
  image: { mimeType: 'image/png'; base64: string }
}

/**
 * The text of slides measured on the page with the real fonts (A4.5, the
 * brand checker's fit rules): boxes that overflow, every growing box's
 * drawn height. No picture comes back.
 */
export interface TextMeasurement {
  slides: Array<{ slideId: string; index: number }>
  /** Every overflowing box (not capped like `look`'s). */
  overflow: TextOverflowInfo[]
  /** Growing boxes (`autofit: 'grow-down'`) as drawn; null from a renderer older than A4.5. */
  grown: Array<{ slideId: string; objectId: string; height: number }> | null
  failedFonts: string[]
}

/** Slides one `measure` call takes: it renders them in sheets of `MAX_RENDER_SLIDES`. */
export const MAX_MEASURE_SLIDES = 100

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
  /**
   * A picture of the live deck for the model to look at (any reader of the
   * deck): a slide, a region at full resolution, or a numbered sheet.
   */
  look(args: { userId: string; deckId: string; view: RenderView }): Promise<RenderLookResult>
  /**
   * Measure the text of slides of the live deck (any reader of the deck),
   * at most MAX_MEASURE_SLIDES; `'all'` of a longer deck is refused.
   */
  measure(args: {
    userId: string
    deckId: string
    slides: RenderSlideRef[] | 'all'
  }): Promise<TextMeasurement>
  /**
   * Redraw a card picture from the first slide now (editors of the deck,
   * or of a master's folder); bad_request for a deck without slides.
   */
  refreshThumbnail(args: {
    userId: string
    /** A deck's card, or a component master's (folder editors). */
    target: { deckId: string } | { componentId: string }
  }): Promise<{ thumbnailUrl: string; updatedAt: string }>
}
