import { Checks, readDeck } from '../lib/checks.js'
import { defineScenario } from '../lib/types.js'
import { buildDeck, deckRef, titledSlide } from './helpers.js'

const TITLES = ['Kickoff', 'Scope', 'Timeline']

interface DeckItem {
  id: string
  title: string
  folderId: string | null
}

export default defineScenario({
  id: 'deck-duplicate-named',
  title: 'Duplicate a deck under a new title',
  covers: ['deck.duplicate'],
  maxTurns: 8,
  replay: {
    reason:
      'deck.duplicate copies a stored deck with its media into a new deck on the server; the memory world does not model it',
  },
  async setup(world) {
    const deck = await buildDeck(
      world,
      `Client pitch ${world.tag}`,
      TITLES.map((t) => titledSlide(t, `${t} details`)),
      world.evalFolderId,
    )
    return {
      deckId: deck.deckId,
      title: deck.title,
      copyTitle: `Client pitch v2 ${world.tag}`,
    }
  },
  steps: (fx) => [
    `Make a copy of the Narrative deck ${deckRef(fx)} called "${fx.copyTitle}", in the same folder.`,
  ],
  async grade({ world, fixture: fx }) {
    const c = new Checks()
    const inFolder = await world.run<{ decks: DeckItem[] }>({}, 'deck.list', {
      folderId: world.evalFolderId,
      limit: 50,
    })
    const copies = inFolder.decks.filter((d) => d.title === fx.copyTitle)
    c.eq('exactly one deck carries the new title, next to the original', copies.length, 1)
    c.ok(
      'the original is still there',
      inFolder.decks.some((d) => d.id === fx.deckId && d.title === fx.title),
    )
    const copy = copies[0]
    if (copy === undefined) return c.done()
    const original = await readDeck(world, fx.deckId)
    const duplicate = await readDeck(world, copy.id)
    c.eq(
      'the copy has the same slides',
      duplicate.slides.map((s) => s.title),
      original.slides.map((s) => s.title),
    )
    c.eq(
      'the original is unchanged',
      original.slides.map((s) => s.title),
      TITLES,
    )
    return c.done()
  },
})
