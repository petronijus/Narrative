import { Checks, callsOf, norm, plainText, readSlide } from '../lib/checks.js'
import { defineScenario } from '../lib/types.js'
import { buildDeck, deckRef, titledSlide } from './helpers.js'

/** The accent the master had when the stamps were made, and the one it has now. */
const OLD_ACCENT = '#e03c31'
const NEW_ACCENT = '#1f4fd8'

/** A colour as query.slide returns it ("#rrggbb" or a 0xRRGGBB integer), lower-case hex. */
function hex(v: unknown): string {
  if (typeof v === 'number') return `#${v.toString(16).padStart(6, '0')}`
  return String(v).toLowerCase()
}

interface StampedObject {
  id: string
  type: string
  fill?: unknown
  fontSize?: number
  text?: unknown
}

export default defineScenario({
  id: 'component-restamp',
  title: 'Bring the stamps of a changed component up to date on one slide, keeping their text',
  covers: ['component.restamp'],
  maxTurns: 10,
  requires: ['componentRoute'],
  replay: {
    reason: 'the component comes from the web app REST route and lives in its own server document',
  },
  async setup(world) {
    const componentName = `Section headline ${world.tag}`
    const componentId = await world.createComponent(world.evalFolderId, componentName)
    await world.batch({ componentId }, [
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
            fill: OLD_ACCENT,
          },
        },
      },
      {
        command: 'object.create',
        input: {
          slide: { index: 0 },
          object: {
            type: 'text',
            slot: 'title',
            role: 'title',
            text: 'Title here',
            x: 120,
            y: 90,
            width: 1200,
            height: 90,
            fontSize: 48,
          },
        },
      },
    ])
    const deck = await buildDeck(
      world,
      `Quarterly review ${world.tag}`,
      [titledSlide('Quarterly review'), { objects: [] }, { objects: [] }],
      world.evalFolderId,
    )
    // Two section openers stamped from the master as it was.
    for (const [index, title] of [
      [1, 'Revenue'],
      [2, 'Costs'],
    ] as const) {
      await world.run({ deckId: deck.deckId }, 'component.stamp', {
        componentId,
        slide: { index },
        slots: { title },
      })
    }
    const stamped = await readSlide(world, { deckId: deck.deckId }, { index: 1 })
    // Then the master changes: a new accent colour, a bigger title.
    const master = await world.run<{ objects: Array<{ id: string; type: string }> }>(
      { folderId: world.evalFolderId },
      'component.get',
      { componentId },
    )
    const accent = master.objects.find((o) => o.type === 'rectangle')!.id
    const title = master.objects.find((o) => o.type === 'text')!.id
    await world.batch({ componentId }, [
      {
        command: 'object.update',
        input: { slide: { index: 0 }, object: accent, patch: { fill: NEW_ACCENT } },
      },
      {
        command: 'object.update',
        input: { slide: { index: 0 }, object: title, patch: { fontSize: 64 } },
      },
    ])
    return {
      deckId: deck.deckId,
      title: deck.title,
      componentName,
      stampedIds: stamped.objects.map((o) => o.id),
    }
  },
  steps: (fx) => [
    `We changed the folder component "${fx.componentName}" (a new accent colour, a bigger title). In the Narrative deck ${deckRef(fx)}, bring the copy of it on slide 2 up to date with the component, keeping its title text. Leave slide 3 as it is.`,
  ],
  async grade({ world, fixture: fx, transcript }) {
    const c = new Checks()
    const calls = callsOf(transcript, 'component.restamp', { ok: true })
    c.ok('component_restamp succeeded', calls.length > 0)
    c.ok(
      'it restamped slide 2 only, not the whole deck',
      calls.length > 0 &&
        calls.every((call) => (call.input as { slide?: unknown }).slide !== undefined),
    )
    const two = await readSlide(world, { deckId: fx.deckId }, { index: 1 })
    const objects = two.objects as unknown as StampedObject[]
    c.eq(
      'slide 2 keeps the same objects (updated in place, ids kept)',
      objects.map((o) => o.id),
      fx.stampedIds,
    )
    const accent = objects.find((o) => o.type === 'rectangle')
    c.eq('the accent bar on slide 2 has the new colour', hex(accent?.fill), NEW_ACCENT)
    const title = objects.find((o) => o.type === 'text')
    c.eq('the title on slide 2 keeps its text', norm(plainText(title ?? {})), 'Revenue')
    c.eq('the title on slide 2 has the master’s new size', title?.fontSize, 64)
    const three = await readSlide(world, { deckId: fx.deckId }, { index: 2 })
    const oldAccent = (three.objects as unknown as StampedObject[]).find(
      (o) => o.type === 'rectangle',
    )
    c.eq('slide 3 is untouched (old accent colour)', hex(oldAccent?.fill), OLD_ACCENT)
    return c.done()
  },
})
