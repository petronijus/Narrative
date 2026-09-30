import { Checks, callsOf, readSlide } from '../lib/checks.js'
import { defineScenario } from '../lib/types.js'
import { buildDeck, deckRef } from './helpers.js'

interface Slot {
  name: string
  type: string
  text?: string
}

export default defineScenario({
  id: 'component-promote-headline',
  title: "Make a slide's headline block a folder component with named slots",
  covers: ['component.promote'],
  maxTurns: 12,
  replay: {
    reason: 'the memory world does not model components (their masters are server documents)',
  },
  async setup(world) {
    const deck = await buildDeck(
      world,
      `Section openers ${world.tag}`,
      [
        {
          objects: [
            {
              key: 'title',
              object: {
                type: 'text',
                text: 'Market overview',
                x: 120,
                y: 120,
                width: 1200,
                height: 100,
                fontSize: 64,
                fontWeight: 'bold',
              },
            },
            {
              key: 'subtitle',
              object: {
                type: 'text',
                text: 'Where we stand in Q3',
                x: 120,
                y: 230,
                width: 1200,
                height: 60,
                fontSize: 32,
              },
            },
            {
              key: 'photo',
              object: {
                type: 'rectangle',
                x: 1300,
                y: 400,
                width: 500,
                height: 500,
                fill: '#c8d0da',
              },
            },
          ],
        },
      ],
      world.evalFolderId,
    )
    return {
      deckId: deck.deckId,
      title: deck.title,
      folderId: world.evalFolderId,
      componentName: `Section headline ${world.tag}`,
    }
  },
  steps: (fx) => [
    `The title and subtitle on slide 1 of the Narrative deck ${deckRef(fx)} are the headline block every section opener repeats. Make that block (not the grey picture placeholder) a component of the deck's folder called "${fx.componentName}", so it can be stamped on the other openers with the text filled in: its title box should be the slot "title" and the subtitle box the slot "subtitle".`,
  ],
  async grade({ world, fixture: fx, transcript }) {
    const c = new Checks()
    c.ok(
      'component_promote succeeded',
      callsOf(transcript, 'component.promote', { ok: true }).length > 0,
    )
    const { components } = await world.run<{ components: Array<{ id: string; name: string }> }>(
      { folderId: fx.folderId },
      'component.list',
      {},
    )
    const made = components.filter((k) => k.name === fx.componentName)
    c.eq(`exactly one component is called "${fx.componentName}"`, made.length, 1)
    if (made.length === 1) {
      const master = await world.run<{ slots: Slot[]; objects: Array<{ type: string }> }>(
        { folderId: fx.folderId },
        'component.get',
        { componentId: made[0]!.id },
      )
      c.eq(
        'the master is the two text boxes, without the placeholder',
        master.objects.map((o) => o.type),
        ['text', 'text'],
      )
      c.eq(
        'its text slots are title and subtitle, keeping their text',
        master.slots
          .filter((s) => s.type === 'text')
          .map((s) => [s.name, s.text])
          .sort(),
        [
          ['subtitle', 'Where we stand in Q3'],
          ['title', 'Market overview'],
        ],
      )
    }
    const slide = await readSlide(world, { deckId: fx.deckId }, { index: 0 })
    c.eq('the slide keeps its three objects', slide.objects.length, 3)
    return c.done()
  },
})
