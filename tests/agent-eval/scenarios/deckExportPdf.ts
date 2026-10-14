import { Checks, callsOf, finalText } from '../lib/checks.js'
import { defineScenario } from '../lib/types.js'
import { buildDeck, deckRef } from './helpers.js'

/** The deck as a PDF, the link handed back (A5.6). */
export default defineScenario({
  id: 'deck-export-pdf',
  title: 'Export a deck as a PDF and hand back the link',
  covers: ['deck.exportPdf'],
  maxTurns: 6,
  requires: ['binaryFetch'],
  replay: { reason: 'live only: the render worker draws the pages' },
  async setup(world) {
    return buildDeck(world, `PDF export ${world.tag}`, [
      {
        objects: [
          {
            object: {
              type: 'text',
              x: 200,
              y: 200,
              width: 1200,
              height: 160,
              fontSize: 80,
              text: 'Q3 review',
            },
          },
        ],
      },
      {
        objects: [
          {
            object: { type: 'rectangle', x: 200, y: 200, width: 600, height: 300, fill: '#E53935' },
          },
        ],
      },
    ])
  },
  steps: (fx) => [`Give me the Narrative deck ${deckRef(fx)} as a PDF.`],
  async grade({ world, transcript }) {
    const c = new Checks()
    const calls = callsOf(transcript, 'deck.exportPdf', { ok: true })
    c.ok('it exported with deck.exportPdf', calls.length > 0)
    const result = calls.at(-1)?.result as { url?: string; pages?: number } | undefined
    c.eq('the PDF has both slides', result?.pages, 2)
    const url = result?.url
    c.ok(
      'it gave the link',
      url !== undefined && finalText(transcript).includes(url.split('?')[0]!),
    )
    if (url !== undefined) {
      const bytes = await world.fetchBinary(url)
      c.ok('the link is a PDF', Buffer.from(bytes.subarray(0, 5)).toString('latin1') === '%PDF-')
    }
    return c.done()
  },
})
