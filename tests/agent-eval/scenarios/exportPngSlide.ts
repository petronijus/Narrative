import { Checks, callsOf, finalText } from '../lib/checks.js'
import { defineScenario } from '../lib/types.js'
import { buildDeck, deckRef, titledSlide } from './helpers.js'

const TITLES = ['Annual plan', 'Budget', 'Timeline']

interface PngExport {
  delivery: 'url' | 'base64'
  slides?: Array<{ slideId: string; index: number; width: number; height: number; url?: string }>
}

export default defineScenario({
  id: 'export-png-slide',
  title: 'Export one slide as PNG; the link serves a 1920×1080 PNG of that slide',
  covers: ['deck.exportPng'],
  maxTurns: 6,
  requires: ['binaryFetch'],
  replay: {
    reason:
      'the PNG is rendered by the render worker and stored by the server (S3); only the live world can fetch it',
  },
  async setup(world) {
    const deck = await buildDeck(
      world,
      `Annual plan ${world.tag}`,
      TITLES.map((t) => titledSlide(t, `${t}: details to follow.`)),
      world.evalFolderId,
    )
    return { deckId: deck.deckId, title: deck.title, budgetSlideId: deck.slideIds[1]! }
  },
  steps: (fx) => [
    `Export the "Budget" slide of the Narrative deck ${deckRef(fx)} as a PNG image and give me the download link.`,
  ],
  async grade({ world, fixture: fx, transcript }) {
    const c = new Checks()
    const exports = callsOf(transcript, 'deck.exportPng', { ok: true }).filter(
      (x) => x.input['deckId'] === fx.deckId,
    )
    if (!c.ok('deck_exportPng succeeded on the fixture deck', exports.length > 0)) return c.done()
    const result = exports.at(-1)!.result as PngExport
    const slide = result.slides?.find((s) => s.slideId === fx.budgetSlideId)
    if (!c.ok('the export holds the Budget slide', slide !== undefined) || slide === undefined) {
      return c.done()
    }
    c.eq('only that slide was exported', result.slides?.length, 1)
    if (!c.ok('it was delivered as a download URL', typeof slide.url === 'string') || !slide.url) {
      return c.done()
    }
    const base = slide.url.split('?')[0]!
    c.ok(
      'the answer gives the user the download link',
      finalText(transcript).includes(base),
      `answer: ${finalText(transcript).slice(0, 300)}`,
    )
    let bytes: Uint8Array
    try {
      bytes = await world.fetchBinary(slide.url)
    } catch (err) {
      c.error('the download link serves the image', err)
      return c.done()
    }
    const { PNG } = await import('pngjs')
    try {
      const png = PNG.sync.read(Buffer.from(bytes))
      c.eq('it is a 1920×1080 PNG', [png.width, png.height], [1920, 1080])
    } catch (err) {
      c.error('the file is a PNG', err)
    }
    return c.done()
  },
})
