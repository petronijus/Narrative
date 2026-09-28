import { Checks, commandsUsed, readSlide } from '../lib/checks.js'
import { defineScenario } from '../lib/types.js'
import { buildDeck, deckRef, titledSlide } from './helpers.js'

export default defineScenario({
  id: 'slide-notes-talking-points',
  title: 'Write formatted speaker notes on slide 2',
  covers: ['slide.notes.set', 'slide.notes.get'],
  maxTurns: 10,
  replay: true,
  async setup(world) {
    const deck = await buildDeck(
      world,
      `Board update ${world.tag}`,
      [
        titledSlide('Board update', 'September 2026'),
        titledSlide('Revenue', 'Q3 revenue grew 12% year on year.'),
        titledSlide('Next steps', 'Hire two engineers.'),
      ],
      world.evalFolderId,
    )
    return { deckId: deck.deckId, title: deck.title, slideIds: deck.slideIds }
  },
  steps: (fx) => [
    `In the Narrative deck ${deckRef(fx)}, add speaker notes to slide 2 (Revenue): a bulleted list with three ` +
      'points — "Growth came from EMEA", "APAC was flat", "Pricing change lands in Q4" — with "EMEA" in bold.',
  ],
  async grade({ world, fixture: fx, transcript }) {
    const c = new Checks()
    const { markdown } = await world.run<{ markdown: string }>(
      { deckId: fx.deckId },
      'slide.notes.get',
      { slide: { index: 1 } },
    )
    const lines = markdown.split('\n').filter((l) => l.trim() !== '')
    const bullets = lines.filter((l) => /^\s*[-*+] /.test(l))
    c.ok('the notes are a list of three bullets', bullets.length === 3, markdown)
    c.ok(
      'the bullets say the three points in order',
      /Growth came from/.test(bullets[0] ?? '') &&
        /APAC was flat/.test(bullets[1] ?? '') &&
        /Pricing change lands in Q4/.test(bullets[2] ?? ''),
      markdown,
    )
    c.ok('"EMEA" is bold', /\*\*EMEA\*\*/.test(markdown), markdown)
    for (const i of [0, 2]) {
      const other = await readSlide(world, { deckId: fx.deckId }, { index: i })
      c.eq(`slide ${i + 1} has no notes`, other.notes, '')
    }
    c.ok('used slide_notes_set', commandsUsed(transcript).includes('slide.notes.set'))
    return c.done()
  },
})
