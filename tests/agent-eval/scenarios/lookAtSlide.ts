import { Checks, callsOf, finalText } from '../lib/checks.js'
import { solidPng } from '../lib/png.js'
import { defineScenario } from '../lib/types.js'
import { buildDeck, deckRef, titledSlide } from './helpers.js'

const TITLES = ['Annual plan', 'Budget', 'Timeline']

/**
 * The agent has to look: the colour of a picture is in its pixels, not in
 * anything query.slide returns (an image object names only its asset).
 */
export default defineScenario({
  id: 'look-at-slide',
  title: 'Look at a slide to tell the colour of a picture on it',
  covers: ['query.render'],
  maxTurns: 6,
  replay: {
    reason:
      'the picture comes from the render worker (headless Chromium on the live deck); only the live world draws it',
  },
  async setup(world) {
    const deck = await buildDeck(
      world,
      `Annual plan ${world.tag}`,
      TITLES.map((t) => titledSlide(t)),
      world.evalFolderId,
    )
    const assetId = await world.uploadImage(
      deck.deckId,
      solidPng(400, 300, [0x1e, 0x40, 0xff]),
      'swatch.png',
    )
    await world.batch({ deckId: deck.deckId }, [
      {
        command: 'object.create',
        input: {
          slide: { index: 1 },
          object: { type: 'image', assetId, x: 760, y: 400, width: 400, height: 300 },
        },
      },
    ])
    return { deckId: deck.deckId, title: deck.title, budgetSlideId: deck.slideIds[1]! }
  },
  steps: (fx) => [
    `On the "Budget" slide of the Narrative deck ${deckRef(fx)} there is a picture. ` +
      'Look at the slide and tell me in one word what colour that picture is.',
  ],
  async grade({ fixture: fx, transcript }) {
    const c = new Checks()
    const looks = callsOf(transcript, 'query.render', { ok: true }).filter(
      (x) => x.input['deckId'] === fx.deckId,
    )
    c.ok('query_render succeeded on the fixture deck', looks.length > 0)
    const onBudget = looks.some((x) => {
      const slide = x.input['slide'] as { index?: number; id?: string } | string | undefined
      const slides = x.input['slides']
      return (
        slide === fx.budgetSlideId ||
        (typeof slide === 'object' && (slide.index === 1 || slide.id === fx.budgetSlideId)) ||
        slides === 'all' ||
        (Array.isArray(slides) && slides.length > 0)
      )
    })
    c.ok('it looked at the Budget slide (alone or on a sheet)', onBudget)
    const answer = finalText(transcript)
    c.ok(
      'the answer names the colour (blue)',
      /\bblue\b/i.test(answer),
      `answer: ${answer.slice(0, 300)}`,
    )
    return c.done()
  },
})
