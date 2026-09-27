import {
  Checks,
  commandsUsed,
  norm,
  plainText,
  readDeck,
  readSlide,
  type SlideView,
} from '../lib/checks.js'
import { defineScenario } from '../lib/types.js'
import { buildDeck, deckRef, titledSlide } from './helpers.js'

const NEW_TITLE = 'Market outlook 2027'

/** The slide's title box: its largest text (what query.deck's title guess uses too). */
function titleOf(slide: SlideView) {
  return slide.objects
    .filter((o) => o.type === 'text')
    .sort((a, b) => (b.fontSize ?? 0) - (a.fontSize ?? 0) || a.y - b.y)[0]
}

export default defineScenario({
  id: 'slide-duplicate-retitle',
  title: 'Duplicate slide 2 and retitle the copy',
  covers: ['slide.duplicate', 'text.set'],
  maxTurns: 12,
  replay: true,
  async setup(world) {
    const deck = await buildDeck(
      world,
      `Quarterly review ${world.tag}`,
      [
        titledSlide('Quarterly review', 'Agenda: market, product, outlook'),
        titledSlide('Market overview', 'EMEA grew 12% while APAC was flat.'),
        titledSlide('Next steps', 'Hire two engineers.'),
      ],
      world.evalFolderId,
    )
    return { deckId: deck.deckId, title: deck.title, slideIds: deck.slideIds }
  },
  steps: (fx) => [
    `In the Narrative deck ${deckRef(fx)}, duplicate slide 2 and change the title on the copy to "${NEW_TITLE}".`,
  ],
  async grade({ world, fixture: fx, transcript }) {
    const c = new Checks()
    const outline = await readDeck(world, fx.deckId)
    if (!c.eq('deck has 4 slides', outline.slideCount, 4)) return c.done()
    const ids = outline.slides.map((s) => s.id)
    c.eq('slides 1, 2 and the old slide 3 keep their places', [ids[0], ids[1], ids[3]], fx.slideIds)
    c.ok('the copy is a new slide right after slide 2', !fx.slideIds.includes(ids[2]!))

    const original = await readSlide(world, { deckId: fx.deckId }, { index: 1 })
    const copy = await readSlide(world, { deckId: fx.deckId }, { index: 2 })
    const originalTitle = titleOf(original)
    const copyTitle = titleOf(copy)
    c.eq(
      'the original keeps its title',
      originalTitle && norm(plainText(originalTitle)),
      'Market overview',
    )
    c.eq('the copy has the new title', copyTitle && norm(plainText(copyTitle)), NEW_TITLE)
    c.eq(
      'the copy has as many objects as the original',
      copy.objects.length,
      original.objects.length,
    )
    const body = (s: SlideView) =>
      s.objects.filter((o) => o.type === 'text' && o !== titleOf(s)).map((o) => norm(plainText(o)))
    c.eq('the copy keeps the body text', body(copy), body(original))
    c.ok(
      'used slide_duplicate (not a hand-built copy)',
      commandsUsed(transcript).includes('slide.duplicate'),
    )
    return c.done()
  },
})
