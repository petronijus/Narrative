/**
 * htmltext-face-subset.spec.ts — embedding only the matched faces draws the
 * same pixels as embedding the whole family (docs/plans/performance.md → E2).
 *
 * HTMLText rasterises an SVG image that sees only the `@font-face` rules
 * embedded into it; the renderer embeds per family just the faces a text's
 * weights, slopes and width match (renderer/fontChanges.ts →
 * `htmlTextFontKeys`, the matching in renderer/fontFaceMatch.ts). That is
 * sound only if our matching picks the face the browser picks. Here the
 * browser decides: every request is drawn in an SVG image twice — with every
 * face of a seven-face family, and with the subset `matchFaces` chose — and
 * the pixels must be equal. The faces are different files under awkward
 * descriptors (a block font at 400 and 900, Inter upright at 300 and 700,
 * italic, oblique, a condensed range), so a wrong pick changes the glyphs,
 * and the requests cover the weight rules between and around them, slopes
 * with no face of their own, synthetic bold and both sides of normal width;
 * a second family of two upright faces has every bold and italic synthesised.
 *
 * No app, no backend: the SVGs are built in a blank page. Runs in Chromium,
 * and in WebKit with `PW_WEBKIT=1 … --project webkit`.
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect } from './fixtures/test'
import { matchFaces, type FaceRequest, type MatchableFace } from '../src/renderer/fontFaceMatch'

const here = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const file = (p: string): string => readFileSync(p).toString('base64')
const block = { mime: 'font/ttf', data: file(join(here, 'fixtures', 'block-font.ttf')) }
const interUp = {
  mime: 'font/woff2',
  data: file(require.resolve('@fontsource-variable/inter/files/inter-latin-wght-normal.woff2')),
}
const interIt = {
  mime: 'font/woff2',
  data: file(require.resolve('@fontsource-variable/inter/files/inter-latin-wght-italic.woff2')),
}

interface ProbeFace extends MatchableFace {
  id: string
  src: { mime: string; data: string }
}

const FACES: ProbeFace[] = [
  { id: 'inter-300', weight: '300', style: 'normal', stretch: '100%', src: interUp },
  { id: 'block-400', weight: '400', style: 'normal', stretch: '100%', src: block },
  { id: 'inter-700', weight: '700', style: 'normal', stretch: '100%', src: interUp },
  { id: 'block-900', weight: '900', style: 'normal', stretch: '100%', src: block },
  { id: 'italic-400', weight: '400', style: 'italic', stretch: '100%', src: interIt },
  { id: 'oblique-800', weight: '800', style: 'oblique', stretch: '100%', src: interIt },
  { id: 'narrow-range', weight: '200 500', style: 'normal', stretch: '75% 90%', src: interUp },
]

/** No italic and no bold of its own: italic and bold requests are synthesised from the matched face. */
const PLAIN_FACES: ProbeFace[] = [FACES[0]!, FACES[1]!]

const css = (faces: readonly ProbeFace[]): string =>
  faces
    .map(
      (f) =>
        `@font-face { font-family: "Subset Probe"; font-weight: ${f.weight}; font-style: ${f.style}; ` +
        `font-stretch: ${f.stretch}; src: url('data:${f.src.mime};base64,${f.src.data}'); }`,
    )
    .join('\n')

const REQUESTS: FaceRequest[] = []
for (const stretch of [100, 80, 112.5])
  for (const style of ['normal', 'italic'] as const)
    for (const weight of [100, 200, 300, 350, 400, 450, 500, 550, 600, 700, 800, 900, 950])
      REQUESTS.push({ weight, style, stretch })

test('the matched faces draw what the whole family draws, for every request', async ({ page }) => {
  await page.setContent('<!doctype html><html><body></body></html>')
  const cases = [FACES, PLAIN_FACES].flatMap((family) =>
    REQUESTS.map((r) => ({
      request: r,
      fullCss: css(family),
      subset: matchFaces(family, r).map((f) => f.id),
      subsetCss: css(matchFaces(family, r)),
    })),
  )
  const result = await page.evaluate(
    async ({ cases }) => {
      const W = 720
      const H = 90
      async function draw(fontCss: string, r: FaceRequest): Promise<string> {
        const svg =
          `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">` +
          `<foreignObject width="${W}" height="${H}"><style>${fontCss}</style>` +
          `<div xmlns="http://www.w3.org/1999/xhtml" style="font-family: 'Subset Probe', serif; ` +
          `font-size: 40px; font-weight: ${r.weight}; font-style: ${r.style}; ` +
          `font-stretch: ${r.stretch}%; color: #000">Hamburgefonstiv 0123</div></foreignObject></svg>`
        const img = new Image(W, H)
        await new Promise<void>((resolve, reject) => {
          img.onload = () => resolve()
          img.onerror = () => reject(new Error('svg failed to load'))
          img.src = `data:image/svg+xml;charset=utf8,${encodeURIComponent(svg)}`
        })
        // Let a face that decodes late land too, so a flaky first frame cannot pass or fail us.
        await new Promise((resolve) => setTimeout(resolve, 30))
        const canvas = document.createElement('canvas')
        canvas.width = W
        canvas.height = H
        const ctx = canvas.getContext('2d')!
        ctx.drawImage(img, 0, 0)
        const px = ctx.getImageData(0, 0, W, H).data
        let hash = 0
        for (let i = 3; i < px.length; i += 4) hash = (Math.imul(hash, 31) + px[i]!) | 0
        return String(hash)
      }
      const out: { full: string; subset: string; ids: string[]; r: FaceRequest }[] = []
      for (const c of cases) {
        const full = await draw(c.fullCss, c.request)
        const subset = await draw(c.subsetCss, c.request)
        out.push({ full, subset, ids: c.subset, r: c.request })
      }
      return out
    },
    { cases },
  )
  const mismatches = result
    .filter((r) => r.full !== r.subset)
    .map((r) => `${r.r.weight} ${r.r.style} ${r.r.stretch}% → ${r.ids.join('+')}`)
  expect(mismatches).toEqual([])
  // The probe tells faces apart: the requests drew more than one picture.
  expect(new Set(result.map((r) => r.full)).size).toBeGreaterThan(5)
})
