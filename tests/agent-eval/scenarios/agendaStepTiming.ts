import { Checks, readSlide } from '../lib/checks.js'
import { defineScenario } from '../lib/types.js'
import { buildDeck, deckRef, titleBox } from './helpers.js'

const point = (text: string, y: number) => ({
  type: 'text',
  x: 160,
  y,
  width: 1200,
  height: 90,
  text,
  fontSize: 40,
  name: text,
})

/**
 * Three agenda points fade in one after another (0 s, 0.6 s, 1.2 s). The ask
 * is in absolute times, which animation.retime takes directly; getting there
 * with animation.update means working out triggers and delays by hand
 * (Point 2 overlaps Point 1: withPrevious 0.3 s; Point 3: afterPrevious
 * 1.1 s after Point 2 ends at 0.9 s).
 */
export default defineScenario({
  id: 'agenda-step-timing',
  title: 'Put two agenda fades at given times on the timeline',
  covers: ['animation.retime'],
  maxTurns: 8,
  replay: true,
  async setup(world) {
    const deck = await buildDeck(
      world,
      `Agenda ${world.tag}`,
      [
        {
          objects: [
            { key: 'title', object: titleBox('Agenda') },
            { key: 'p1', object: point('Point 1', 300) },
            { key: 'p2', object: point('Point 2', 420) },
            { key: 'p3', object: point('Point 3', 540) },
          ],
          animations: [
            { key: 's1', objectKey: 'p1', preset: 'fadeIn' },
            { key: 's2', objectKey: 'p2', preset: 'fadeIn' },
            { key: 's3', objectKey: 'p3', preset: 'fadeIn' },
          ],
        },
      ],
      world.evalFolderId,
    )
    const ids = deck.objects[0]!
    return {
      deckId: deck.deckId,
      title: deck.title,
      p1: ids['p1']!,
      p2: ids['p2']!,
      p3: ids['p3']!,
    }
  },
  steps: (fx) => [
    `On slide 1 of the Narrative deck ${deckRef(fx)}, the three agenda points fade in one after another. Change the timing: "Point 2" should start fading in 0.3 seconds after "Point 1" starts, while Point 1 is still fading, and "Point 3" should start exactly 2 seconds after the slide appears. Leave Point 1 as it is and keep every fade's duration.`,
  ],
  async grade({ world, fixture: fx }) {
    const c = new Checks()
    const slide = await readSlide(world, { deckId: fx.deckId }, { index: 0 })
    const stepOf = (objectId: string) => slide.animations.filter((s) => s.objectId === objectId)
    const [s1, s2, s3] = [stepOf(fx.p1), stepOf(fx.p2), stepOf(fx.p3)]
    if (
      !c.ok(
        'each point still has exactly one step',
        s1.length === 1 && s2.length === 1 && s3.length === 1,
        JSON.stringify(slide.animations.map((s) => s.objectId)),
      )
    )
      return c.done()
    const close = (a: number, b: number) => Math.abs(a - b) < 0.01
    c.ok('Point 1 starts with the slide', close(s1[0]!.start, 0), String(s1[0]!.start))
    c.ok('Point 2 starts at 0.3 s', close(s2[0]!.start, 0.3), String(s2[0]!.start))
    c.ok('Point 3 starts at 2 s', close(s3[0]!.start, 2), String(s3[0]!.start))
    c.eq(
      'every fade still lasts 0.6 s and is a fade-in',
      slide.animations.map((s) => [s.preset, s.duration]),
      [
        ['fadeIn', 0.6],
        ['fadeIn', 0.6],
        ['fadeIn', 0.6],
      ],
    )
    c.ok(
      'nothing waits for a click',
      slide.animations.every((s) => s.trigger !== 'onClick'),
      JSON.stringify(slide.animations.map((s) => s.trigger)),
    )
    return c.done()
  },
})
