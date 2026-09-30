import { Checks, norm, objectById, plainText, readDeck, readSlide } from '../lib/checks.js'
import { defineScenario } from '../lib/types.js'
import { textStylesOf } from './folderStylesApply.js'
import { buildDeck, deckRef } from './helpers.js'

function quote(text: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'text',
    x: 200,
    y: 360,
    width: 1520,
    height: 240,
    text,
    fontFamily: 'Arial',
    fontSize: 28,
    ...extra,
  }
}

const QUOTES = ['“Design is how it works.”', '“Less, but better.”', '“Good design is honest.”']

export default defineScenario({
  id: 'quote-style-from-box',
  title: 'Save a hand-styled quote as a folder text style and use it for the other quotes',
  covers: ['text.style.createFromObject', 'text.style.apply'],
  maxTurns: 12,
  replay: true,
  async setup(world) {
    const folderId = await world.createFolder(`Quotes ${world.tag}`)
    const deck = await buildDeck(
      world,
      `Principles ${world.tag}`,
      [
        {
          objects: [
            {
              key: 'q',
              object: quote(QUOTES[0]!, {
                fontFamily: 'Inter',
                fontWeight: 300,
                fontSize: 40,
                color: '#1b4fd8',
              }),
            },
          ],
        },
        { objects: [{ key: 'q', object: quote(QUOTES[1]!) }] },
        { objects: [{ key: 'q', object: quote(QUOTES[2]!) }] },
      ],
      folderId,
    )
    return {
      folderId,
      deckId: deck.deckId,
      title: deck.title,
      quotes: deck.objects.map((o) => o['q']!),
    }
  },
  steps: (fx) => [
    `In the Narrative deck ${deckRef(fx)}, save the look of the quote on slide 1 as a text style called "Testimonial" and use it for the quotes on slides 2 and 3.`,
  ],
  async grade({ world, fixture: fx }) {
    const c = new Checks()
    const style = (await textStylesOf(world, fx.folderId)).find((s) => s.name === 'Testimonial')
    if (!c.ok('the folder has a "Testimonial" style', style !== undefined) || style === undefined)
      return c.done()
    c.eq('Testimonial keeps the size', style.size, 40)
    c.eq('Testimonial keeps the weight', style.weight, 300)
    c.eq('Testimonial keeps the colour', (style as { color?: unknown }).color, '#1b4fd8')
    const outline = await readDeck(world, fx.deckId)
    c.eq('no slide was added or removed', outline.slideCount, 3)
    for (let i = 0; i < 3; i++) {
      const obj = objectById(
        await readSlide(world, { deckId: fx.deckId }, { index: i }),
        fx.quotes[i]!,
      )
      if (!c.ok(`the quote on slide ${i + 1} exists`, obj !== undefined) || obj === undefined)
        continue
      c.eq(`the quote on slide ${i + 1} is linked to Testimonial`, obj['textStyleId'], style.id)
      c.eq(`the quote on slide ${i + 1} is 40 px`, obj.fontSize, 40)
      c.eq(`the quote on slide ${i + 1} keeps its text`, norm(plainText(obj)), norm(QUOTES[i]!))
    }
    return c.done()
  },
})
