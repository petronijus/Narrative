import { Checks, norm, objectById, plainText, readSlide, type SlideView } from '../lib/checks.js'
import { defineScenario, type World } from '../lib/types.js'
import { buildDeck, deckRef } from './helpers.js'

interface Style {
  id: string
  name: string
  family?: string
  weight?: number
  size?: number
}

export async function textStylesOf(world: World, folderId: string): Promise<Style[]> {
  return (await world.run<{ textStyles: Style[] }>({ folderId }, 'token.list', {})).textStyles
}

export default defineScenario({
  id: 'folder-styles-apply',
  title: "Put a slide's heading and paragraph on the folder's Title and Body styles",
  covers: ['token.list', 'text.style.apply'],
  maxTurns: 10,
  replay: true,
  async setup(world) {
    // Its own folder: it comes with the default text styles.
    const folderId = await world.createFolder(`Styles ${world.tag}`)
    const deck = await buildDeck(
      world,
      `Quarterly review ${world.tag}`,
      [
        {
          objects: [
            {
              key: 'heading',
              object: {
                type: 'text',
                x: 120,
                y: 80,
                width: 1680,
                height: 140,
                text: 'Results',
                fontFamily: 'Arial',
                fontSize: 50,
              },
            },
            {
              key: 'paragraph',
              object: {
                type: 'text',
                x: 120,
                y: 300,
                width: 1680,
                height: 300,
                text: 'Revenue grew in every region.',
                fontFamily: 'Arial',
                fontSize: 20,
              },
            },
          ],
        },
      ],
      folderId,
    )
    return {
      folderId,
      deckId: deck.deckId,
      title: deck.title,
      heading: deck.objects[0]!['heading']!,
      paragraph: deck.objects[0]!['paragraph']!,
    }
  },
  async prepare(world, fx, notes) {
    notes['before'] = await readSlide(world, { deckId: fx.deckId }, { index: 0 })
  },
  steps: (fx) => [
    `On slide 1 of the Narrative deck ${deckRef(fx)}, use the folder's text styles: the heading "Results" as Title, the paragraph as Body.`,
  ],
  async grade({ world, fixture: fx, notes }) {
    const c = new Checks()
    const styles = await textStylesOf(world, fx.folderId)
    const before = notes['before'] as SlideView
    const after = await readSlide(world, { deckId: fx.deckId }, { index: 0 })
    for (const [role, id, name] of [
      ['heading', fx.heading, 'Title'],
      ['paragraph', fx.paragraph, 'Body'],
    ] as const) {
      const style = styles.find((s) => s.name === name)
      if (!c.ok(`the folder has a ${name} style`, style !== undefined) || style === undefined)
        continue
      const obj = objectById(after, id)
      if (!c.ok(`the ${role} still exists`, obj !== undefined) || obj === undefined) continue
      c.eq(`the ${role} is linked to ${name}`, obj['textStyleId'], style.id)
      c.eq(`the ${role} follows ${name} in every field`, obj['textStyleOverrides'] ?? [], [])
      c.eq(`the ${role} has ${name}'s size`, obj.fontSize, style.size)
      c.eq(
        `the ${role} keeps its text`,
        norm(plainText(obj)),
        norm(plainText(objectById(before, id)!)),
      )
    }
    return c.done()
  },
})
