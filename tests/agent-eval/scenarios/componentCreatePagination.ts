import { Checks, callsOf, readDeck } from '../lib/checks.js'
import { defineScenario } from '../lib/types.js'
import { buildDeck, deckRef, titledSlide } from './helpers.js'

interface Slot {
  name: string
  objectId: string
  type: string
  role?: string
}

interface MasterObject {
  id: string
  type: string
  x: number
  y: number
  width: number
  height: number
}

export default defineScenario({
  id: 'component-create-pagination',
  title: 'Create an empty pagination component and give it a page-number slot',
  covers: ['component.create'],
  maxTurns: 12,
  replay: {
    reason: 'the memory world does not model components (their masters are server documents)',
  },
  async setup(world) {
    const deck = await buildDeck(
      world,
      `Brand template ${world.tag}`,
      [titledSlide('Brand template'), titledSlide('Agenda')],
      world.evalFolderId,
    )
    return {
      deckId: deck.deckId,
      title: deck.title,
      folderId: world.evalFolderId,
      componentName: `Pagination ${world.tag}`,
    }
  },
  steps: (fx) => [
    `In the folder of the Narrative deck ${deckRef(fx)}, create a new, empty component called "${fx.componentName}". In its master, add a small text box in the bottom-right corner that shows the slide number; make it the component's slot "pagenum" with the role furniture. Do not place the component on any slide yet.`,
  ],
  async grade({ world, fixture: fx, transcript }) {
    const c = new Checks()
    c.ok(
      'component_create succeeded',
      callsOf(transcript, 'component.create', { ok: true }).length > 0,
    )
    c.ok(
      'it did not promote slide content instead',
      callsOf(transcript, 'component.promote').length === 0,
    )
    const { components } = await world.run<{ components: Array<{ id: string; name: string }> }>(
      { folderId: fx.folderId },
      'component.list',
      {},
    )
    const made = components.filter((k) => k.name === fx.componentName)
    c.eq(`exactly one component is called "${fx.componentName}"`, made.length, 1)
    if (made.length === 1) {
      const master = await world.run<{ slots: Slot[]; objects: MasterObject[] }>(
        { folderId: fx.folderId },
        'component.get',
        { componentId: made[0]!.id },
      )
      const slot = master.slots.find((s) => s.name === 'pagenum')
      c.ok(
        'the master has a text slot "pagenum"',
        slot?.type === 'text',
        JSON.stringify(master.slots),
      )
      c.eq('its role is furniture', slot?.role, 'furniture')
      const box = master.objects.find((o) => o.id === slot?.objectId) as
        | (MasterObject & { isSlideNumber?: boolean })
        | undefined
      c.ok('it shows the slide number', box?.isSlideNumber === true)
      c.ok(
        'it sits in the bottom-right corner',
        box !== undefined && box.x + box.width / 2 > 1440 && box.y + box.height / 2 > 810,
        JSON.stringify(box),
      )
    }
    const outline = await readDeck(world, fx.deckId)
    c.eq(
      'no slide got anything new',
      outline.slides.map((s) => s.objectCount),
      [1, 1],
    )
    return c.done()
  },
})
