import { Checks, objectById, paragraphText, paragraphsOf, readSlide } from '../lib/checks.js'
import { defineScenario } from '../lib/types.js'
import { bodyBox, buildDeck, deckRef } from './helpers.js'

/**
 * A4.2b: a box whose list comes from its list levels (no paragraph says
 * "bullet"): one paragraph made plain has to say `list: "none"` — removing
 * an attribute it never had changes nothing — and the others keep taking
 * their level's bullets.
 */
export default defineScenario({
  id: 'list-level-plain-paragraph',
  title: 'Make one paragraph plain in a box whose bullets come from its list levels',
  covers: ['text.list'],
  maxTurns: 8,
  replay: true,
  async setup(world) {
    const deck = await buildDeck(world, `Levels ${world.tag}`, [
      {
        objects: [
          {
            key: 'body',
            object: bodyBox('Revenue up 12%\n\nCosts flat\n\nSource: annual report', {
              listLevels: [{ list: 'bullet', bulletChar: '–', indent: 36, hanging: 36 }],
            }),
          },
        ],
      },
    ])
    return { deckId: deck.deckId, title: deck.title, body: deck.objects[0]!['body']! }
  },
  steps: (fx) => [
    `In the Narrative deck ${deckRef(fx)}, the body text on the first slide is a bulleted list. Keep the bullets, but make the third paragraph ("Source: annual report") plain text without a bullet.`,
  ],
  async grade({ world, fixture: fx }) {
    const c = new Checks()
    const slide = await readSlide(world, { deckId: fx.deckId }, { index: 0 })
    const body = objectById(slide, fx.body)
    const paras = paragraphsOf(body ?? {})
    c.eq('three paragraphs, text unchanged', paras.map(paragraphText), [
      'Revenue up 12%',
      'Costs flat',
      'Source: annual report',
    ])
    c.eq('the third is plain', paras[2]?.list, 'none')
    c.ok(
      'the first two keep the bullets of their level',
      paras.slice(0, 2).every((p) => p.list === undefined || p.list === 'bullet'),
    )
    c.ok('the box keeps its list levels', Array.isArray(body?.['listLevels']))
    return c.done()
  },
})
