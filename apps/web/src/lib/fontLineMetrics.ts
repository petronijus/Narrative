/**
 * lib/fontLineMetrics.ts
 *
 * One answer to "how tall is a line of this text", shared by the Pixi
 * renderer, the DOM edit overlay, the clip mask and the Inspector, so the
 * four can never disagree by a few pixels again.
 *
 * Two notions of line height coexist in the model and mean different things:
 *
 * - `lineHeight` — a multiple of the **font size**. CSS semantics. What the
 *   Inspector edits and what the default text-style tokens carry.
 * - `lineSpacing` — a multiple of the **font's own normal line height**.
 *   PowerPoint semantics: `<a:lnSpc><a:spcPct val="75000"/>` is 0.75, and
 *   100% means "whatever this font says a line is" (ascender − descender +
 *   line gap; 1.162 em for Proseware Pro, 1.15 for Calibri, 1.2 for Inter).
 *
 * The importer used to fold the second into the first with a flat ×1.2,
 * which is only right for fonts whose normal happens to be 1.2 em, and the
 * exporter sent `lineHeight` back out as if it were a normal-multiple. An
 * imported frame that PowerPoint had auto-sized to its text came out 3%
 * taller here and overflowed; a 100% import round-tripped as 120%. Keeping
 * both fields, resolved through this module, ends that.
 *
 * "Normal" comes from two sources, in this order:
 *
 * 1. **Declared** — the font file's own `hhea` metrics, registered by the
 *    folder-font loader from the bytes it installs (`fontFileMetrics.ts`).
 *    This is what PowerPoint uses, and it is the only source that is right
 *    for fonts that set USE_TYPO_METRICS: Proseware Pro declares 1.162 em in
 *    hhea while the browser's `line-height: normal` gives 0.977 for it.
 * 2. **Measured** — a hidden span in the font at a reference size with
 *    `line-height: normal`, for system fonts and anything the loader could
 *    not read (WOFF2). Measurements taken while a webfont is still loading
 *    describe the fallback face, so they are only cached once
 *    `document.fonts.check()` says the font is there.
 *
 * Where the text sits inside its line boxes is the second half of the
 * answer, see {@link powerpointLineOffsetPx}: PowerPoint puts all of a
 * line's spare height above the glyphs, CSS splits it above and below.
 */

export interface LineMetricsSource {
  fontSize: number
  fontFamily?: string
  fontWeight?: number | string
  italic?: boolean
  /** Multiple of the font size. Wins over `lineSpacing` when both are set. */
  lineHeight?: number
  /** Multiple of the font's normal line height (PowerPoint `spcPct / 100000`). */
  lineSpacing?: number
}

/**
 * What `line-height: normal` resolves to when it cannot be measured — no
 * DOM (jsdom, SSR) or a zero-height measurement. 1.2 is what the renderer
 * and overlay used unconditionally before; it stays the value of last
 * resort so those environments render exactly as they did.
 */
export const FALLBACK_NORMAL_RATIO = 1.2

/**
 * Reference size for the probe. Chrome rounds a line box to whole pixels, so
 * the ratio is quantised to 1/PROBE_PX: at 100px that is 1%, which showed up
 * as an 8-line frame landing 6px short of PowerPoint's height (1.15 instead
 * of Proseware Pro's 1.162). At 1000px the quantum is 0.1%, and the fractional
 * px value we then hand to CSS and Pixi is honoured as written.
 */
const PROBE_PX = 1000

const ratioCache = new Map<string, number>()
/** Browser layout ascent/descent per face, in ems — see {@link browserFontBox}. */
const fontBoxCache = new Map<string, { ascent: number; descent: number }>()
let boxContext: CanvasRenderingContext2D | null | undefined

/** What a font file declares, in ems of the font size. */
export interface DeclaredLineMetrics {
  /** PowerPoint's single line height: hhea ascender − descender + gap. */
  lineHeight: number
  /** PowerPoint's descent below the baseline: −hhea descender. */
  descent: number
}
/** Metrics read from font files, keyed like the cache. Never invalidated: a file's metrics do not change. */
const declared = new Map<string, DeclaredLineMetrics>()
let probe: HTMLSpanElement | null = null

/**
 * Text objects carry CSS weights ('normal', 'bold', '600', 400); folder
 * fonts carry numbers. One numeric scale, or the two never meet.
 */
export function numericWeight(weight: number | string | undefined): number {
  if (typeof weight === 'number') return Number.isFinite(weight) ? weight : 400
  const w = (weight ?? '').trim().toLowerCase()
  if (w === '' || w === 'normal' || w === 'regular') return 400
  if (w === 'bold') return 700
  const n = parseInt(w, 10)
  return Number.isFinite(n) ? n : 400
}

function metricKey(
  family: string | undefined,
  weight: number | string | undefined,
  italic: boolean | undefined,
): string {
  return `${cssFamily(family)}|${numericWeight(weight)}|${italic === true ? 'italic' : 'normal'}`
}

/**
 * The declared ratio for this face, or for the nearest declared weight of
 * the same family and style — which is the face the browser would render
 * with when the exact weight is not installed.
 */
function declaredFor(
  family: string | undefined,
  weight: number | string | undefined,
  italic: boolean | undefined,
): DeclaredLineMetrics | undefined {
  const exact = declared.get(metricKey(family, weight, italic))
  if (exact !== undefined) return exact
  const fam = cssFamily(family)
  const style = italic === true ? 'italic' : 'normal'
  const want = numericWeight(weight)
  let best: { dist: number; metrics: DeclaredLineMetrics } | undefined
  for (const [key, metrics] of declared) {
    const [kFam, kWeight, kStyle] = key.split('|')
    if (kFam !== fam || kStyle !== style) continue
    const dist = Math.abs(Number(kWeight) - want)
    if (best === undefined || dist < best.dist) best = { dist, metrics }
  }
  return best?.metrics
}
/**
 * Record a font's declared metrics (PowerPoint's 100% line height and its
 * descent) so they are used ahead of any measurement. Called by the
 * folder-font loader with the values read from the installed file.
 */
export function registerDeclaredLineMetrics(
  family: string,
  weight: number | string,
  style: 'normal' | 'italic',
  metrics: DeclaredLineMetrics,
): void {
  if (!(metrics.lineHeight > 0) || !(metrics.descent >= 0)) return
  declared.set(metricKey(family, weight, style === 'italic'), metrics)
}

if (typeof document !== 'undefined' && typeof document.fonts?.addEventListener === 'function') {
  // A face finishing its load can change the answer for any family measured
  // against a fallback in the meantime; those were not cached, but a cached
  // system-font answer can also be superseded by a same-named webfont.
  document.fonts.addEventListener('loadingdone', () => {
    ratioCache.clear()
    fontBoxCache.clear()
  })
}

function cssFamily(family: string | undefined): string {
  const f = (family ?? '').trim()
  if (f === '') return 'sans-serif'
  // Already a stack, or a generic: pass through. Otherwise quote it.
  if (f.includes(',') || /^(sans-serif|serif|monospace|system-ui|cursive|fantasy)$/i.test(f)) {
    return f
  }
  return `"${f.replace(/"/g, '')}"`
}

/**
 * The font's normal line height as a multiple of its size, measured in the
 * browser. Falls back to {@link FALLBACK_NORMAL_RATIO} where measurement is
 * impossible.
 */
export function normalLineHeightRatio(
  family: string | undefined,
  weight: number | string | undefined,
  italic: boolean | undefined,
): number {
  const key = metricKey(family, weight, italic)
  const known = declaredFor(family, weight, italic)
  if (known !== undefined) return known.lineHeight
  if (typeof document === 'undefined' || document.body === null) return FALLBACK_NORMAL_RATIO
  const w = String(weight ?? 400)
  const style = italic === true ? 'italic' : 'normal'
  const fam = cssFamily(family)
  const cached = ratioCache.get(key)
  if (cached !== undefined) return cached

  if (probe === null || !probe.isConnected) {
    probe = document.createElement('span')
    probe.setAttribute('aria-hidden', 'true')
    // Off-screen, non-interactive, and immune to inherited layout: the
    // number we want is the span's own line box and nothing else.
    probe.style.cssText =
      'position:absolute;left:-99999px;top:0;visibility:hidden;pointer-events:none;' +
      'white-space:nowrap;line-height:normal;padding:0;margin:0;border:0;' +
      'letter-spacing:0;text-transform:none;display:inline-block'
    probe.textContent = 'Hg'
    document.body.appendChild(probe)
  }
  probe.style.font = `${style} ${w} ${PROBE_PX}px ${fam}`
  const height = probe.getBoundingClientRect().height
  if (!(height > 0)) return FALLBACK_NORMAL_RATIO
  const ratio = height / PROBE_PX

  // Only remember an answer that came from the real face. `check()` is
  // false exactly when a matching FontFace exists and has not loaded yet;
  // for system fonts and unknown families it is true.
  let settled = true
  try {
    settled = document.fonts.check(`${style} ${w} ${PROBE_PX}px ${fam}`)
  } catch {
    /* an unparsable descriptor: treat as settled, there is nothing to wait for */
  }
  if (settled) ratioCache.set(key, ratio)
  return ratio
}

/**
 * Forget every measurement of one family. `check()` is also true when no
 * face of the family exists at all, so a family measured before its folder
 * font was installed was measured — and remembered — in a fallback. The
 * loader's refresh calls this so the next question is put to the real face.
 * Declared file metrics are untouched; they describe the file, not a probe.
 */
export function forgetMeasuredLineHeight(family: string | undefined): void {
  const prefix = `${cssFamily(family)}|`
  for (const key of ratioCache.keys()) {
    if (key.startsWith(prefix)) ratioCache.delete(key)
  }
  for (const key of fontBoxCache.keys()) {
    if (key.startsWith(prefix)) fontBoxCache.delete(key)
  }
}

/**
 * The line height in px this text should be laid out with:
 *
 *   lineHeight set   → lineHeight × fontSize
 *   lineSpacing set  → lineSpacing × normal(font) × fontSize
 *   neither          → normal(font) × fontSize
 */
export function resolveLineHeightPx(src: LineMetricsSource): number {
  const fontSize = src.fontSize
  if (!(fontSize > 0)) return 0
  if (src.lineHeight !== undefined && src.lineHeight > 0) return src.lineHeight * fontSize
  const normal = normalLineHeightRatio(src.fontFamily, src.fontWeight, src.italic)
  if (src.lineSpacing !== undefined && src.lineSpacing > 0) {
    return src.lineSpacing * normal * fontSize
  }
  return normal * fontSize
}

/**
 * The effective line height as a multiple of the font size — what the
 * Inspector shows, whichever field is driving it.
 */
export function effectiveLineHeightMultiple(src: LineMetricsSource): number {
  if (!(src.fontSize > 0)) return FALLBACK_NORMAL_RATIO
  return resolveLineHeightPx(src) / src.fontSize
}

/**
 * The font's ascent and descent as the browser lays text out with them, in
 * ems — the "content area" CSS centres in each line box. Read from canvas
 * `fontBoundingBox*`, which reports exactly the metrics layout uses (typo for
 * a USE_TYPO_METRICS face such as Proseware Pro: 0.704 + 0.198, hhea otherwise).
 * Undefined where there is no canvas (jsdom), so callers can fall back.
 */
function browserFontBox(
  family: string | undefined,
  weight: number | string | undefined,
  italic: boolean | undefined,
): { ascent: number; descent: number } | undefined {
  const key = metricKey(family, weight, italic)
  const cached = fontBoxCache.get(key)
  if (cached !== undefined) return cached
  if (typeof document === 'undefined') return undefined
  if (boxContext === undefined) {
    try {
      boxContext = document.createElement('canvas').getContext('2d')
    } catch {
      boxContext = null
    }
  }
  if (boxContext === null) return undefined
  const style = italic === true ? 'italic' : 'normal'
  const font = `${style} ${String(weight ?? 400)} ${PROBE_PX}px ${cssFamily(family)}`
  boxContext.font = font
  const m = boxContext.measureText('Hg')
  const ascent = m.fontBoundingBoxAscent
  const descent = m.fontBoundingBoxDescent
  if (!(ascent > 0) || !(descent >= 0)) return undefined
  const box = { ascent: ascent / PROBE_PX, descent: descent / PROBE_PX }
  let settled = true
  try {
    settled = document.fonts.check(font)
  } catch {
    /* unparsable descriptor: nothing to wait for */
  }
  if (settled) fontBoxCache.set(key, box)
  return box
}

/**
 * How far to move laid-out text down so its lines sit where PowerPoint puts
 * them, in px (negative moves it up).
 *
 * A line box is `L` tall and the glyphs need less (or, below 100%, more).
 * PowerPoint puts the whole difference ABOVE the glyphs — the baseline sits
 * the font's descent above the bottom of the line box. CSS splits it into
 * equal half-leading above and below. Because the difference is the same for
 * every line of the frame, the two layouts differ by one constant: the whole
 * block moves, its height does not, so auto-fitted frame heights and wrapping
 * are untouched and a single translation of the laid-out text reconciles
 * them:
 *
 *   PowerPoint baseline = L − descent_ppt
 *   CSS baseline        = (L − (ascent_css + descent_css)) / 2 + ascent_css
 *   offset              = L/2 − descent_ppt − (ascent_css − descent_css)/2
 *
 * `descent_ppt` is the file's hhea descent when the loader read the file,
 * else the browser's own (the two agree for fonts without USE_TYPO_METRICS),
 * which reduces the offset to plain half-leading. On the Proseware deck's
 * "We made it to our first Camp!" (72 px, exactly 65 pt) this is 32.5 px —
 * the gap between our render and PowerPoint's.
 *
 * Applied by the renderer and the edit overlay alike, so both keep drawing
 * the same line boxes; zero where the browser's metrics cannot be read.
 */
export function powerpointLineOffsetPx(src: LineMetricsSource): number {
  const fontSize = src.fontSize
  if (!(fontSize > 0)) return 0
  const box = browserFontBox(src.fontFamily, src.fontWeight, src.italic)
  if (box === undefined) return 0
  const lineHeight = resolveLineHeightPx(src)
  const declaredDescent = declaredFor(src.fontFamily, src.fontWeight, src.italic)?.descent
  const pptDescent = (declaredDescent ?? box.descent) * fontSize
  return lineHeight / 2 - pptDescent - ((box.ascent - box.descent) * fontSize) / 2
}

/** Test hook: forget every measurement. */
export function __resetFontLineMetricsForTests(): void {
  ratioCache.clear()
  fontBoxCache.clear()
  boxContext = undefined
  declared.clear()
  if (probe !== null) {
    probe.remove()
    probe = null
  }
}
