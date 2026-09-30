import { Checks, callsOf, norm, plainText, readSlide } from '../lib/checks.js'
import { defineScenario } from '../lib/types.js'
import { buildDeck, deckRef, titledSlide } from './helpers.js'

const SLOT_TITLE = 'Revenue up 12%'
const SLOT_SUBTITLE = 'Driven by EMEA'

interface Slot {
  name: string
  type: string
  text?: string
}

export default defineScenario({
  id: 'component-stamp-slots',
  title: 'Stamp a folder component and fill its text slots',
  covers: ['component.list', 'component.get', 'component.stamp'],
  maxTurns: 10,
  requires: ['componentRoute'],
  replay: {
    reason: 'the component comes from the web app REST route and lives in its own server document',
  },
  async setup(world) {
    const componentName = `Headline block ${world.tag}`
    const componentId = await world.createComponent(world.evalFolderId, componentName)
    // The server writes a new component's empty master slide; draw the
    // master on it with the ordinary document commands.
    await world.batch({ componentId }, [
      {
        command: 'object.create',
        input: {
          slide: { index: 0 },
          object: {
            type: 'text',
            name: 'title',
            text: 'Title here',
            x: 120,
            y: 90,
            width: 1200,
            height: 90,
            fontSize: 56,
            fontWeight: 'bold',
          },
        },
      },
      {
        command: 'object.create',
        input: {
          slide: { index: 0 },
          object: {
            type: 'text',
            name: 'subtitle',
            text: 'Subtitle here',
            x: 120,
            y: 190,
            width: 1200,
            height: 50,
            fontSize: 28,
          },
        },
      },
      {
        command: 'object.create',
        input: {
          slide: { index: 0 },
          object: {
            type: 'rectangle',
            name: 'accent',
            x: 120,
            y: 60,
            width: 120,
            height: 8,
            fill: '#e03c31',
          },
        },
      },
    ])
    const deck = await buildDeck(
      world,
      `Board update ${world.tag}`,
      [titledSlide('Board update'), { objects: [] }],
      world.evalFolderId,
    )
    return {
      deckId: deck.deckId,
      title: deck.title,
      componentId,
      componentName,
      folderId: world.evalFolderId,
    }
  },
  steps: (fx) => [
    `On slide 2 of the Narrative deck ${deckRef(fx)}, place the folder component "${fx.componentName}" and fill it in: title "${SLOT_TITLE}", subtitle "${SLOT_SUBTITLE}".`,
  ],
  async grade({ world, fixture: fx, transcript }) {
    const c = new Checks()
    c.ok(
      'component_stamp succeeded',
      callsOf(transcript, 'component.stamp', { ok: true }).length > 0,
    )
    const slide = await readSlide(world, { deckId: fx.deckId }, { index: 1 })
    const texts = slide.objects.filter((o) => o.type === 'text').map((o) => norm(plainText(o)))
    c.ok(
      `the title slot says "${SLOT_TITLE}"`,
      texts.includes(SLOT_TITLE),
      `texts: ${JSON.stringify(texts)}`,
    )
    c.ok(`the subtitle slot says "${SLOT_SUBTITLE}"`, texts.includes(SLOT_SUBTITLE))
    c.ok(
      "the master's accent bar came along",
      slide.objects.some((o) => o.type === 'rectangle' && o.width === 120 && o.height === 8),
    )
    c.eq('the stamp placed exactly the three master objects', slide.objects.length, 3)
    const master = await world.run<{ slots: Slot[] }>({ folderId: fx.folderId }, 'component.get', {
      componentId: fx.componentId,
    })
    c.eq(
      'the master itself is unchanged',
      master.slots.filter((s) => s.type === 'text').map((s) => [s.name, s.text]),
      [
        ['title', 'Title here'],
        ['subtitle', 'Subtitle here'],
      ],
    )
    return c.done()
  },
})
