import { Checks, objectById, readSlide, type SlideView } from '../lib/checks.js'
import { defineScenario } from '../lib/types.js'
import { buildDeck, deckRef, titleBox } from './helpers.js'

const BLUE = '#2e86ab'
const BADGE = { x: 760, y: 420, width: 400, height: 240 }

const channels = (hex: string): number[] => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))

export default defineScenario({
  id: 'badge-gradient',
  title: 'Give a shape a left-to-right gradient from its own colour',
  covers: ['object.fill.gradient'],
  maxTurns: 8,
  replay: true,
  async setup(world) {
    const deck = await buildDeck(
      world,
      `Launch badge ${world.tag}`,
      [
        {
          objects: [
            { key: 'title', object: titleBox('New in spring') },
            {
              key: 'badge',
              object: { type: 'rectangle', ...BADGE, fill: BLUE, name: 'Badge' },
            },
          ],
        },
      ],
      world.evalFolderId,
    )
    const ids = deck.objects[0]!
    return {
      deckId: deck.deckId,
      title: deck.title,
      badgeId: ids['badge']!,
      titleId: ids['title']!,
    }
  },
  async prepare(world, fx, notes) {
    notes['before'] = await readSlide(world, { deckId: fx.deckId }, { index: 0 })
  },
  steps: (fx) => [
    `On slide 1 of the Narrative deck ${deckRef(fx)}, give the blue "Badge" rectangle a left-to-right gradient that starts with its current blue and runs into a darker shade of that blue.`,
  ],
  async grade({ world, fixture: fx, notes }) {
    const c = new Checks()
    const before = notes['before'] as SlideView
    const after = await readSlide(world, { deckId: fx.deckId }, { index: 0 })
    const badge = objectById(after, fx.badgeId)
    if (!c.ok('the badge still exists', badge !== undefined) || badge === undefined) return c.done()
    const fill = badge['fillStyle'] as
      | { kind?: string; angleDeg?: number; stops?: Array<{ color: string; offset: number }> }
      | undefined
    c.eq('a linear gradient', fill?.kind, 'linearGradient')
    c.ok(
      'running left to right (90 degrees)',
      typeof fill?.angleDeg === 'number' && Math.abs(fill.angleDeg - 90) < 0.5,
      String(fill?.angleDeg),
    )
    const stops = [...(fill?.stops ?? [])].sort((a, b) => a.offset - b.offset)
    const first = stops[0]
    const last = stops[stops.length - 1]
    c.ok(
      'it starts with the badge blue',
      first !== undefined && first.offset === 0 && first.color.toLowerCase() === BLUE,
      JSON.stringify(first),
    )
    const base = channels(BLUE)
    c.ok(
      'it ends in a darker shade of that blue',
      last !== undefined &&
        last.offset === 1 &&
        channels(last.color).every((v, i) => v <= base[i]!) &&
        channels(last.color).some((v, i) => v < base[i]!),
      JSON.stringify(last),
    )
    c.eq(
      'the badge did not move',
      { x: badge.x, y: badge.y, width: badge.width, height: badge.height },
      BADGE,
    )
    c.eq('the title is untouched', objectById(after, fx.titleId), objectById(before, fx.titleId))
    return c.done()
  },
})
