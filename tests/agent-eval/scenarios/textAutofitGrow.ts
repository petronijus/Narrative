import { Checks, callsOf, objectById, plainText, readSlide } from '../lib/checks.js'
import { defineScenario } from '../lib/types.js'
import { bodyBox, buildDeck, deckRef, titleBox } from './helpers.js'

/**
 * A4.2a: "grow with the text" is the box's `autofit`, said only in
 * object.update's prose — the model has to find it there rather than
 * resize the box to today's text.
 */
export default defineScenario({
  id: 'text-autofit-grow',
  title: 'Let the body box grow with its text instead of a fixed height',
  covers: ['object.update'],
  maxTurns: 8,
  replay: true,
  async setup(world) {
    const deck = await buildDeck(world, `Status ${world.tag}`, [
      {
        objects: [
          { key: 'title', object: titleBox('Status') },
          {
            key: 'body',
            object: bodyBox('We shipped the importer. The exporter follows next week.'),
          },
        ],
      },
    ])
    return {
      deckId: deck.deckId,
      title: deck.title,
      heading: deck.objects[0]!['title']!,
      body: deck.objects[0]!['body']!,
    }
  },
  async prepare(world, fx, notes) {
    const slide = await readSlide(world, { deckId: fx.deckId }, { index: 0 })
    notes['title'] = objectById(slide, fx.heading)
    notes['bodyText'] = plainText(objectById(slide, fx.body) ?? {})
  },
  steps: (fx) => [
    `In the Narrative deck ${deckRef(fx)}, make the body text box on the first slide grow with its text instead of keeping a fixed height.`,
  ],
  async grade({ world, fixture: fx, notes, transcript }) {
    const c = new Checks()
    const slide = await readSlide(world, { deckId: fx.deckId }, { index: 0 })
    const body = objectById(slide, fx.body)
    c.eq('the body box grows with its text', body?.['autofit'], 'grow-down')
    c.eq('its text is unchanged', plainText(body ?? {}), notes['bodyText'])
    c.eq('the title is untouched', objectById(slide, fx.heading), notes['title'])
    c.eq('the box was not resized by hand instead', callsOf(transcript, 'object.resize').length, 0)
    return c.done()
  },
})
