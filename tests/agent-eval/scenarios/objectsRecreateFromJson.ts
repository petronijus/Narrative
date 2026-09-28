import { Checks, readSlide } from '../lib/checks.js'
import { defineScenario } from '../lib/types.js'
import { buildDeck, deckRef, titleBox } from './helpers.js'

/** A callout as query.slide read it before it was deleted. */
const CALLOUT = [
  {
    id: 'old-card',
    type: 'rectangle',
    x: 100,
    y: 700,
    width: 600,
    height: 240,
    rotation: 0,
    opacity: 1,
    fill: '#1b2a4a',
    cornerRadius: 20,
    name: 'Callout card',
  },
  {
    id: 'old-label',
    type: 'text',
    x: 140,
    y: 760,
    width: 520,
    height: 120,
    rotation: 0,
    opacity: 1,
    fontSize: 44,
    color: '#ffffff',
    name: 'Callout label',
    text: 'Growth 32%',
    paragraphs: [{ runs: [{ text: 'Growth ' }, { text: '32%', fontWeight: 700 }] }],
  },
]

export default defineScenario({
  id: 'objects-recreate-from-json',
  title: 'Put a deleted callout back from its JSON, centred on another slide',
  covers: ['object.insert'],
  maxTurns: 8,
  replay: true,
  async setup(world) {
    const deck = await buildDeck(
      world,
      `Results ${world.tag}`,
      [
        { objects: [{ key: 'title', object: titleBox('Q3 results') }] },
        { objects: [{ key: 'title', object: titleBox('Highlights') }] },
        { objects: [{ key: 'title', object: titleBox('Next quarter') }] },
      ],
      world.evalFolderId,
    )
    return { deckId: deck.deckId, title: deck.title }
  },
  steps: (fx) => [
    `A colleague deleted a callout from the Narrative deck ${deckRef(fx)}. This is how it read before (JSON from query_slide):\n\n${JSON.stringify(CALLOUT)}\n\nPut it back exactly as it was — card and label, the label's bold "32%" included — but centred on slide 3 (the centre of the slide).`,
  ],
  async grade({ world, fixture: fx }) {
    const c = new Checks()
    const slide = await readSlide(world, { deckId: fx.deckId }, { index: 2 })
    const card = slide.objects.find((o) => o.type === 'rectangle' && o.name === 'Callout card')
    const label = slide.objects.find((o) => o.type === 'text' && o.name === 'Callout label')
    c.ok('the card is back on slide 3', card !== undefined)
    c.ok('the label is back on slide 3', label !== undefined)
    if (card === undefined || label === undefined) return c.done()
    c.eq(
      'the card kept its look',
      {
        fill: card['fill'],
        cornerRadius: card['cornerRadius'],
        width: card.width,
        height: card.height,
      },
      {
        fill: '#1b2a4a',
        cornerRadius: 20,
        width: 600,
        height: 240,
      },
    )
    const runs = (label.paragraphs?.[0] as { runs?: Array<Record<string, unknown>> } | undefined)
      ?.runs
    c.ok(
      '"32%" is still bold',
      runs?.some((r) => r['text'] === '32%' && r['fontWeight'] === 700) === true,
      JSON.stringify(label.paragraphs),
    )
    c.ok(
      'the label sits on the card as before (40, 60 in)',
      Math.abs(label.x - card.x - 40) <= 1 && Math.abs(label.y - card.y - 60) <= 1,
      JSON.stringify({ card: [card.x, card.y], label: [label.x, label.y] }),
    )
    const cx = card.x + card.width / 2
    const cy = card.y + card.height / 2
    c.ok(
      'the callout is centred on the slide',
      Math.abs(cx - 960) <= 2 && Math.abs(cy - 540) <= 2,
      `${cx}, ${cy}`,
    )
    const others = await Promise.all(
      [0, 1].map((index) => readSlide(world, { deckId: fx.deckId }, { index })),
    )
    c.eq(
      'slides 1 and 2 are untouched',
      others.map((s) => s.objects.length),
      [1, 1],
    )
    return c.done()
  },
})
