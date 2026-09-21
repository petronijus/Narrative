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
/** Ratios read from font files, keyed like the cache. Never invalidated: a file's metrics do not change. */
const declared = new Map<string, number>()
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
): number | undefined {
  const exact = declared.get(metricKey(family, weight, italic))
  if (exact !== undefined) return exact
  const fam = cssFamily(family)
  const style = italic === true ? 'italic' : 'normal'
  const want = numericWeight(weight)
  let best: { dist: number; ratio: number } | undefined
  for (const [key, ratio] of declared) {
    const [kFam, kWeight, kStyle] = key.split('|')
    if (kFam !== fam || kStyle !== style) continue
    const dist = Math.abs(Number(kWeight) - want)
    if (best === undefined || dist < best.dist) best = { dist, ratio }
  }
  return best?.ratio
}
/**
 * Record a font's declared line height (PowerPoint's 100%) so it is used
 * ahead of any measurement. Called by the folder-font loader with the ratio
 * read from the installed file.
 */
export function registerDeclaredLineHeight(
  family: string,
  weight: number | string,
  style: 'normal' | 'italic',
  ratio: number,
): void {
  if (!(ratio > 0)) return
  declared.set(metricKey(family, weight, style === 'italic'), ratio)
}

if (typeof document !== 'undefined' && typeof document.fonts?.addEventListener === 'function') {
  // A face finishing its load can change the answer for any family measured
  // against a fallback in the meantime; those were not cached, but a cached
  // system-font answer can also be superseded by a same-named webfont.
  document.fonts.addEventListener('loadingdone', () => ratioCache.clear())
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
  if (known !== undefined) return known
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

/** Test hook: forget every measurement. */
export function __resetFontLineMetricsForTests(): void {
  ratioCache.clear()
  declared.clear()
  if (probe !== null) {
    probe.remove()
    probe = null
  }
}
