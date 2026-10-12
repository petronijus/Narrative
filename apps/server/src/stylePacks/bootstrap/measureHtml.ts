/**
 * stylePacks/bootstrap/measureHtml.ts — an HTML deck measured as a browser
 * lays it out (agentic A4.7): the Woodgrove house deck places its content in
 * flow (vw/vh, clamp(), flex and grid), so its layouts are read from the
 * render, not from the CSS. Each slide is shown in turn at 1920×1080 in
 * headless Chromium with transitions off, and every element whose class
 * the caller names is measured: its box, its text, and the computed type
 * (size, weight, line height, letter spacing, colour, transform).
 *
 * The browser: `PLAYWRIGHT_CHROME_EXECUTABLE`, else Playwright's own
 * Chromium, else the system's `chromium` / `google-chrome`.
 */

import { existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { chromium, type Browser } from 'playwright'

export interface MeasuredElement {
  /** The first of the element's classes the caller asked for. */
  cls: string
  /** All its classes. */
  classes: string[]
  rect: { x: number; y: number; width: number; height: number }
  text: string
  fontSize: number
  fontWeight: number
  /** × the font size; null for `normal`. */
  lineHeight: number | null
  /** px. */
  letterSpacing: number
  color: string
  backgroundColor: string
  textTransform: string
  /** Index among the measured elements of the same class on the slide (0-based). */
  nth: number
}

export interface MeasuredSlide {
  index: number
  elements: MeasuredElement[]
  /** The deck's CSS custom properties as this slide resolves them. */
  vars: Record<string, string>
}

async function launch(): Promise<Browser> {
  const env = process.env['PLAYWRIGHT_CHROME_EXECUTABLE']
  if (env !== undefined && env !== '') return chromium.launch({ executablePath: env })
  try {
    return await chromium.launch()
  } catch {
    for (const path of ['/usr/bin/chromium', '/usr/bin/google-chrome', '/usr/bin/chromium-browser'])
      if (existsSync(path)) return chromium.launch({ executablePath: path })
    throw new Error('no Chromium to measure with: set PLAYWRIGHT_CHROME_EXECUTABLE')
  }
}

/**
 * Measure every slide (`.slide`) of an HTML deck: the elements of the given
 * classes, and the custom properties `vars` names.
 */
export async function measureHtmlDeck(
  file: string,
  classes: readonly string[],
  vars: readonly string[],
): Promise<MeasuredSlide[]> {
  const browser = await launch()
  try {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } })
    await page.goto(pathToFileURL(file).href, { waitUntil: 'load' })
    await page.addStyleTag({
      content: '*,*::before,*::after{transition:none!important;animation:none!important}',
    })
    await page.evaluate(() => document.fonts.ready)
    const count = await page.locator('.slide').count()
    const out: MeasuredSlide[] = []
    for (let i = 0; i < count; i++) {
      const measured = await page.evaluate(
        ({ i, classes, vars }) => {
          const slides = [...document.querySelectorAll<HTMLElement>('.slide')]
          slides.forEach((s, k) => s.classList.toggle('active', k === i))
          const slide = slides[i]!
          // Layout settles synchronously once read.
          void slide.offsetHeight
          const cs = getComputedStyle(slide)
          const resolved: Record<string, string> = {}
          for (const v of vars) resolved[v] = cs.getPropertyValue(v).trim()
          const seen = new Map<string, number>()
          const elements: unknown[] = []
          for (const el of slide.querySelectorAll<HTMLElement>('*')) {
            const cls = classes.find((c) => el.classList.contains(c))
            if (cls === undefined) continue
            const r = el.getBoundingClientRect()
            if (r.width === 0 && r.height === 0) continue
            const s = getComputedStyle(el)
            const size = parseFloat(s.fontSize)
            const nth = seen.get(cls) ?? 0
            seen.set(cls, nth + 1)
            elements.push({
              cls,
              classes: [...el.classList],
              rect: { x: r.x, y: r.y, width: r.width, height: r.height },
              text: (el.innerText ?? '').trim(),
              fontSize: size,
              fontWeight: Number(s.fontWeight),
              lineHeight: s.lineHeight === 'normal' ? null : parseFloat(s.lineHeight) / size,
              letterSpacing: s.letterSpacing === 'normal' ? 0 : parseFloat(s.letterSpacing),
              color: s.color,
              backgroundColor: s.backgroundColor,
              textTransform: s.textTransform,
              nth,
            })
          }
          return { elements, vars: resolved }
        },
        { i, classes: [...classes], vars: [...vars] },
      )
      out.push({
        index: i,
        elements: measured.elements as MeasuredElement[],
        vars: measured.vars,
      })
    }
    return out
  } finally {
    await browser.close()
  }
}
