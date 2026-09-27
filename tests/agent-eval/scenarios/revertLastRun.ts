import { Checks, deckSnapshot, structuralDiff, type SlideView } from '../lib/checks.js'
import { defineScenario } from '../lib/types.js'
import { bodyBox, buildDeck, deckRef, titleBox } from './helpers.js'

export default defineScenario({
  id: 'revert-last-run',
  title: '"Undo what you just did" restores the deck exactly (agent.revert)',
  covers: ['agent.startRun', 'agent.runs', 'agent.revert'],
  maxTurns: 10,
  replay: true,
  async setup(world) {
    const deck = await buildDeck(
      world,
      `Pitch ${world.tag}`,
      [
        {
          objects: [
            { key: 'title', object: titleBox('Original title') },
            { key: 'body', object: bodyBox('Three reasons to invest.') },
          ],
        },
        {
          objects: [
            {
              key: 'box',
              object: {
                type: 'rectangle',
                x: 200,
                y: 300,
                width: 600,
                height: 300,
                fill: '#f2b705',
                name: 'Callout box',
              },
            },
            { key: 'note', object: bodyBox('Keep this note.', { x: 900, width: 800 }) },
          ],
        },
      ],
      world.evalFolderId,
    )
    return { deckId: deck.deckId, title: deck.title }
  },
  async prepare(world, fx, notes) {
    notes['before'] = await deckSnapshot(world, fx.deckId)
  },
  steps: (fx) => [
    `In the Narrative deck ${deckRef(fx)}, change the title on slide 1 to "Draft title" and delete the rectangle on slide 2.`,
    'Undo what you just did.',
  ],
  async afterStep(world, fx, index, notes) {
    if (index === 0) notes['afterEdit'] = await deckSnapshot(world, fx.deckId)
  },
  async grade({ world, fixture: fx, transcript, notes }) {
    const c = new Checks()
    const before = notes['before'] as SlideView[]
    const afterEdit = notes['afterEdit'] as SlideView[] | undefined
    const edited = afterEdit !== undefined && structuralDiff(afterEdit, before) !== null
    c.ok('the first request changed the deck', edited)
    if (afterEdit !== undefined) {
      c.ok(
        'the first request retitled slide 1 and removed the rectangle',
        JSON.stringify(afterEdit[0]).includes('Draft title') &&
          !afterEdit[1]!.objects.some((o) => o.type === 'rectangle'),
      )
    }
    const secondStep = transcript.steps[1]
    c.ok(
      'the undo used agent_revert',
      secondStep !== undefined &&
        secondStep.calls.some((call) => call.command === 'agent.revert' && !call.isError),
      `calls in step 2: ${secondStep?.calls.map((x) => `${x.tool}${x.isError ? '(error)' : ''}`).join(', ')}`,
    )
    const after = await deckSnapshot(world, fx.deckId)
    c.eq('the deck is back exactly where it was', after, before)
    return c.done()
  },
})
