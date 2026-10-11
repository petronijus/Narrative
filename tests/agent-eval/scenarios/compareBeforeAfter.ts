import { Checks, callsOf, objectById, paragraphsOf, readSlide } from '../lib/checks.js'
import { defineScenario } from '../lib/types.js'
import { buildDeck, deckRef, titledSlide } from './helpers.js'

const TITLES = ['Annual plan', 'Budget', 'Timeline']

/** Red enough: a strong red channel, weak green and blue. */
function isRed(color: unknown): boolean {
  const hex = typeof color === 'number' ? color.toString(16).padStart(6, '0') : String(color)
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex)
  if (m === null) return false
  const [r, g, b] = [m[1]!, m[2]!, m[3]!].map((x) => parseInt(x, 16))
  return r! >= 180 && g! <= 90 && b! <= 90
}

/**
 * The agent changes a slide, then shows the user the slide before its run
 * and now, side by side — `query.render` with `compare: "before"` (agentic
 * A3.6), after the change.
 */
export default defineScenario({
  id: 'compare-before-after',
  title: 'Change a title, then show the slide before and after side by side',
  covers: ['query.render'],
  maxTurns: 8,
  replay: {
    reason:
      'the before/after picture comes from the render worker (a frozen page and the live deck); only the live world draws it',
  },
  async setup(world) {
    const deck = await buildDeck(
      world,
      `Annual plan ${world.tag}`,
      TITLES.map((t) => titledSlide(t, `${t}: details to follow.`)),
      world.evalFolderId,
    )
    return {
      deckId: deck.deckId,
      title: deck.title,
      budgetSlideId: deck.slideIds[1]!,
      titleId: deck.objects[1]!['title']!,
    }
  },
  steps: (fx) => [
    `On the "Budget" slide of the Narrative deck ${deckRef(fx)}, make the title red. ` +
      'Then show me that slide before and after your change, side by side.',
  ],
  async grade({ world, fixture: fx, transcript }) {
    const c = new Checks()
    const slide = await readSlide(world, { deckId: fx.deckId }, fx.budgetSlideId)
    const title = objectById(slide, fx.titleId)
    const colors =
      title === undefined
        ? []
        : [
            title['color'],
            ...paragraphsOf(title).flatMap((p) =>
              (p.runs ?? []).map((r) => r.color ?? title['color']),
            ),
          ]
    c.ok(
      'the Budget title is red',
      colors.length > 0 && colors.every(isRed),
      JSON.stringify(colors),
    )
    const compares = callsOf(transcript, 'query.render', { ok: true }).filter(
      (x) => x.input['deckId'] === fx.deckId && x.input['compare'] === 'before',
    )
    c.ok(
      'it showed the slide before and after (query_render compare: "before")',
      compares.length > 0,
    )
    const onBudget = compares.some((x) => {
      const s = x.input['slide'] as { index?: number; id?: string } | string | undefined
      return (
        s === fx.budgetSlideId ||
        (typeof s === 'object' && (s.index === 1 || s.id === fx.budgetSlideId))
      )
    })
    c.ok('the compare was of the Budget slide', onBudget)
    return c.done()
  },
})
