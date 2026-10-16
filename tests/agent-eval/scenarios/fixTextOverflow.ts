import { Checks, callsOf, objectById, paragraphsOf, plainText, readSlide } from '../lib/checks.js'
import { defineScenario } from '../lib/types.js'
import { buildDeck, bodyBox, deckRef, titleBox } from './helpers.js'

interface Look {
  overflow: Array<{ slideId: string; objectId: string; boxHeight: number; textHeight: number }>
}

/**
 * A text box whose text runs far below it — visible only once laid out with
 * the real fonts (`query.render`'s `overflow`, agentic A3.6). The agent must
 * find it by looking and fix it without shrinking the type below the size
 * asked for. The grader measures again with the render worker.
 */
export default defineScenario({
  id: 'fix-text-overflow',
  title: 'Find the text that does not fit its box, and fix it without tiny type',
  covers: ['query.render'],
  maxTurns: 10,
  replay: {
    reason:
      'whether text fits is measured by the render worker with the real fonts; only the live world measures it',
  },
  async setup(world) {
    const deck = await buildDeck(
      world,
      `Quarterly results ${world.tag}`,
      [
        {
          objects: [
            { key: 'title', object: titleBox('Results') },
            {
              key: 'body',
              object: bodyBox(
                'Revenue grew in every region this quarter, led by the north, where two new ' +
                  'distribution partners opened in spring and the online store doubled its ' +
                  'orders compared with the same quarter last year, while costs stayed flat.',
                { height: 60, fontSize: 40 },
              ),
            },
          ],
        },
      ],
      world.evalFolderId,
    )
    // The fixture must overflow, or every check below passes for nothing.
    const before = await world.run<Look>({ deckId: deck.deckId }, 'query.render', {
      slide: { index: 0 },
    })
    if (!before.overflow.some((o) => o.objectId === deck.objects[0]!['body'])) {
      throw new Error('fixture: the body text box does not overflow')
    }
    return {
      deckId: deck.deckId,
      title: deck.title,
      slideId: deck.slideIds[0]!,
      bodyId: deck.objects[0]!['body']!,
    }
  },
  steps: (fx) => [
    `Check that all text on the slide of the Narrative deck ${deckRef(fx)} fits inside its box, ` +
      'and fix whatever does not. Keep the text at 32 px or larger.',
  ],
  async grade({ world, fixture: fx, transcript }) {
    const c = new Checks()
    c.ok(
      'it looked at the slide (query_render)',
      callsOf(transcript, 'query.render', { ok: true }).some(
        (x) => x.input['deckId'] === fx.deckId,
      ),
    )
    const look = await world.run<Look>({ deckId: fx.deckId }, 'query.render', {
      slide: { index: 0 },
    })
    c.eq('no text box overflows any more (measured again)', look.overflow, [])
    const slide = await readSlide(world, { deckId: fx.deckId }, fx.slideId)
    const body = objectById(slide, fx.bodyId)
    c.ok('the body text box is still there', body !== undefined)
    // The smallest type in it — a run's own size too, not only the box's.
    const boxSize = Number(body?.['fontSize'] ?? 0)
    const sizes =
      body === undefined
        ? []
        : paragraphsOf(body).flatMap((p) =>
            (p.runs ?? []).map((r) => Number(r.fontSize ?? boxSize)),
          )
    const smallest = Math.min(boxSize, ...sizes)
    c.ok('its type is 32 px or larger', smallest >= 32, `smallest ${smallest}`)
    c.ok(
      'it still says what it said (the revenue sentence is there)',
      body !== undefined && /revenue/i.test(plainText(body)),
      body === undefined ? 'no body' : plainText(body).slice(0, 120),
    )
    return c.done()
  },
})
