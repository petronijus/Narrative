import { Checks, callsOf, finalText, readDeck } from '../lib/checks.js'
import { defineScenario } from '../lib/types.js'
import { buildDeck, deckRef, titledSlide } from './helpers.js'

const TITLES = ['Annual plan', 'Budget', 'Timeline']

interface ExportResult {
  delivery: 'url' | 'base64'
  url?: string
  base64?: string
  slideCount?: number
}

export default defineScenario({
  id: 'export-pptx-roundtrip',
  title: 'Export to PPTX; the link serves a valid .pptx that re-imports with the same slides',
  covers: ['deck.exportPptx'],
  maxTurns: 6,
  requires: ['binaryFetch'],
  replay: {
    reason:
      'the export is rendered and stored by the server (S3); only the live world can fetch and re-import it',
  },
  async setup(world) {
    const deck = await buildDeck(
      world,
      `Annual plan ${world.tag}`,
      TITLES.map((t) => titledSlide(t, `${t}: details to follow.`)),
      world.evalFolderId,
    )
    return { deckId: deck.deckId, title: deck.title }
  },
  steps: (fx) => [
    `Export the Narrative deck ${deckRef(fx)} to PowerPoint and give me the download link.`,
  ],
  async grade({ world, fixture: fx, transcript }) {
    const c = new Checks()
    const exports = callsOf(transcript, 'deck.exportPptx', { ok: true }).filter(
      (x) => x.input['deckId'] === fx.deckId,
    )
    if (!c.ok('deck_exportPptx succeeded on the fixture deck', exports.length > 0)) return c.done()
    const result = exports.at(-1)!.result as ExportResult
    if (
      !c.ok(
        'the export was delivered as a download URL',
        result.delivery === 'url' && typeof result.url === 'string',
      ) ||
      result.url === undefined
    ) {
      return c.done()
    }
    const base = result.url.split('?')[0]!
    c.ok(
      'the answer gives the user the download link',
      finalText(transcript).includes(base),
      `answer: ${finalText(transcript).slice(0, 300)}`,
    )

    let bytes: Uint8Array
    try {
      bytes = await world.fetchBinary(result.url)
    } catch (err) {
      c.error('the download link serves the file', err)
      return c.done()
    }
    c.ok(
      'the file is a ZIP container',
      bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04,
    )
    const { default: JSZip } = await import('jszip')
    let entries: string[] = []
    try {
      const zip = await JSZip.loadAsync(bytes)
      entries = Object.keys(zip.files)
    } catch (err) {
      c.error('the ZIP opens', err)
      return c.done()
    }
    c.ok(
      'it is a PowerPoint package ([Content_Types].xml + ppt/presentation.xml)',
      entries.includes('[Content_Types].xml') && entries.includes('ppt/presentation.xml'),
    )
    c.eq(
      'it holds 3 slides',
      entries.filter((e) => /^ppt\/slides\/slide\d+\.xml$/.test(e)).length,
      TITLES.length,
    )

    const base64 = Buffer.from(bytes).toString('base64')
    const imported = await world.run<{ deckId: string; slideCount: number }>(
      { folderId: world.evalFolderId },
      'deck.importPptx',
      { file: { base64, filename: 'roundtrip.pptx' }, title: `Round trip ${world.tag}` },
    )
    c.eq('re-importing it yields 3 slides', imported.slideCount, TITLES.length)
    const outline = await readDeck(world, imported.deckId)
    c.eq(
      'the re-imported slides carry the same titles',
      outline.slides.map((s) => s.title),
      TITLES,
    )
    return c.done()
  },
})
