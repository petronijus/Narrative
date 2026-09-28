import { Checks, readSlide } from '../lib/checks.js'
import { gradientPng } from '../lib/png.js'
import { defineScenario } from '../lib/types.js'
import { buildDeck, deckRef, titleBox } from './helpers.js'

export default defineScenario({
  id: 'objects-from-other-deck',
  title: "Bring a contact card (photo + text) from another deck's slide onto this one",
  covers: ['object.insertFromDeck'],
  maxTurns: 12,
  replay: {
    reason:
      'object.insertFromDeck copies media between stored decks on the server; the memory world does not model it',
  },
  async setup(world) {
    const source = await buildDeck(
      world,
      `Company profile ${world.tag}`,
      [{ objects: [{ key: 'title', object: titleBox('Contact') }] }],
      world.evalFolderId,
    )
    const assetId = await world.uploadImage(source.deckId, gradientPng(300, 300), 'jana.png')
    await world.batch({ deckId: source.deckId }, [
      {
        command: 'object.create',
        input: {
          slide: { index: 0 },
          object: {
            type: 'image',
            assetId,
            x: 200,
            y: 300,
            width: 300,
            height: 300,
            name: 'Contact photo',
          },
        },
      },
      {
        command: 'object.create',
        input: {
          slide: { index: 0 },
          object: {
            type: 'text',
            x: 540,
            y: 340,
            width: 700,
            height: 160,
            fontSize: 36,
            name: 'Contact details',
            text: {
              paragraphs: [
                { runs: [{ text: 'Jana Nováková', fontWeight: 700 }] },
                { text: 'jana@example.com' },
              ],
            },
          },
        },
      },
    ])
    const target = await buildDeck(
      world,
      `Proposal ${world.tag}`,
      [{ objects: [{ key: 'title', object: titleBox('Your contact') }] }],
      world.evalFolderId,
    )
    return {
      source: { deckId: source.deckId, title: source.title },
      target: { deckId: target.deckId, title: target.title },
      assetId,
    }
  },
  steps: (fx) => [
    `Slide 1 of the Narrative deck ${deckRef(fx.source)} has a contact card: a photo and the contact details next to it. Put that same card — photo and details, formatting included — onto slide 1 of the deck ${deckRef(fx.target)}.`,
  ],
  async grade({ world, fixture: fx }) {
    const c = new Checks()
    const slide = await readSlide(world, { deckId: fx.target.deckId }, { index: 0 })
    const photo = slide.objects.find((o) => o.type === 'image')
    const details = slide.objects.find(
      (o) => o.type === 'text' && (o.text ?? '').includes('jana@example.com'),
    )
    c.ok('the photo is on the target slide', photo !== undefined)
    c.ok(
      "the photo is the target deck's own copy (not the source deck's asset)",
      photo !== undefined && photo['assetId'] !== fx.assetId,
      String(photo?.['assetId']),
    )
    c.ok('the details are on the target slide', details !== undefined)
    const runs = (details?.paragraphs?.[0] as { runs?: Array<Record<string, unknown>> } | undefined)
      ?.runs
    c.ok(
      'the name is still bold',
      runs?.some((r) => r['text'] === 'Jana Nováková' && r['fontWeight'] === 700) === true,
      JSON.stringify(details?.paragraphs),
    )
    const source = await readSlide(world, { deckId: fx.source.deckId }, { index: 0 })
    c.eq('the source slide still has its three objects', source.objects.length, 3)
    return c.done()
  },
})
