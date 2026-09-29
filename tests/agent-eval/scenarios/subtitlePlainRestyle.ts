import {
  Checks,
  isBoldWeight,
  objectById,
  paragraphsOf,
  plainText,
  readSlide,
} from '../lib/checks.js'
import { defineScenario } from '../lib/types.js'
import { buildDeck, deckRef, titleBox } from './helpers.js'

const GREY = '#333333'

export default defineScenario({
  id: 'subtitle-plain-restyle',
  title: 'Make a partly bold, partly coloured subtitle one plain style',
  covers: ['text.setBoxTypography'],
  maxTurns: 10,
  replay: true,
  async setup(world) {
    const deck = await buildDeck(
      world,
      `Regional update ${world.tag}`,
      [
        {
          objects: [
            { key: 'title', object: titleBox('Regional update') },
            {
              key: 'subtitle',
              object: {
                type: 'text',
                x: 120,
                y: 240,
                width: 1680,
                height: 100,
                text: 'x',
                fontSize: 36,
                color: '#1b2a4a',
                name: 'Subtitle',
              },
            },
          ],
        },
      ],
      world.evalFolderId,
    )
    const ids = deck.objects[0]!
    await world.batch({ deckId: deck.deckId }, [
      {
        command: 'text.set',
        input: {
          target: { slide: { index: 0 }, object: ids['subtitle']! },
          text: {
            paragraphs: [
              {
                runs: [
                  { text: 'Growth in ' },
                  { text: 'all', bold: true, color: '#e03c31' },
                  { text: ' regions' },
                ],
              },
            ],
          },
        },
      },
    ])
    return { deckId: deck.deckId, title: deck.title, subtitleId: ids['subtitle']! }
  },
  steps: (fx) => [
    `On slide 1 of the Narrative deck ${deckRef(fx)}, make the whole "Subtitle" text box plain: regular weight and dark grey ${GREY}, with no bold or differently coloured words left in it. Keep its text.`,
  ],
  async grade({ world, fixture: fx }) {
    const c = new Checks()
    const slide = await readSlide(world, { deckId: fx.deckId }, { index: 0 })
    const box = objectById(slide, fx.subtitleId)
    if (!c.ok('the subtitle still exists', box !== undefined) || box === undefined) return c.done()
    c.eq('its text is unchanged', plainText(box), 'Growth in all regions')
    const runs = paragraphsOf(box).flatMap((p) => p.runs)
    c.ok(
      'no run is bold',
      runs.every((r) => !isBoldWeight(r.fontWeight ?? box.fontWeight)),
      JSON.stringify({ box: box.fontWeight, runs }),
    )
    c.ok(
      `every run shows ${GREY}`,
      runs.every((r) => String(r.color ?? box['color']).toLowerCase() === GREY),
      JSON.stringify({ box: box['color'], runs }),
    )
    return c.done()
  },
})
