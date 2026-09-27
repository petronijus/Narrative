import { Checks, norm, plainText, readDeck, readSlide } from '../lib/checks.js'
import { defineScenario } from '../lib/types.js'

const TITLE_TEXT = 'Project Kickoff'
const SUBTITLE_TEXT = 'Discovery workshop'

interface DeckItem {
  id: string
  title: string
  folderId: string | null
}

export default defineScenario({
  id: 'deck-create-in-folder',
  title: 'Create a deck in a named folder, with a title slide',
  covers: ['folder.list', 'deck.create', 'object.create', 'text.set'],
  maxTurns: 12,
  replay: true,
  async setup(world) {
    const folderName = `Eval Client ${world.tag}`
    const folderId = await world.createFolder(folderName)
    return { folderId, folderName, deckTitle: `Kickoff ${world.tag}` }
  },
  steps: (fx) => [
    `In Narrative, create a new deck called "${fx.deckTitle}" in my folder "${fx.folderName}". Give it a title slide with the title "${TITLE_TEXT}" and the subtitle "${SUBTITLE_TEXT}".`,
  ],
  async grade({ world, fixture: fx }) {
    const c = new Checks()
    const inFolder = await world.run<{ decks: DeckItem[] }>({}, 'deck.list', {
      folderId: fx.folderId,
      limit: 50,
    })
    const matching = inFolder.decks.filter((d) => d.title === fx.deckTitle)
    c.eq(
      'the folder holds exactly one deck, with the exact title',
      inFolder.decks.map((d) => d.title),
      [fx.deckTitle],
    )
    const everywhere = await world.run<{ decks: DeckItem[] }>({}, 'deck.list', {
      query: fx.deckTitle,
      limit: 50,
    })
    c.eq('no stray copy was created elsewhere', everywhere.decks.length, 1)
    const deck = matching[0]
    if (deck === undefined) return c.done()
    const outline = await readDeck(world, deck.id)
    c.eq('the deck has exactly one slide (the title slide)', outline.slideCount, 1)
    const slide = await readSlide(world, { deckId: deck.id }, { index: 0 })
    const texts = slide.objects.filter((o) => o.type === 'text')
    const title = texts.find((o) => norm(plainText(o)) === TITLE_TEXT)
    const subtitle = texts.find((o) => norm(plainText(o)) === SUBTITLE_TEXT)
    c.ok(
      `a text box says exactly "${TITLE_TEXT}"`,
      title !== undefined,
      `texts: ${JSON.stringify(texts.map((t) => plainText(t)))}`,
    )
    c.ok(`a text box says exactly "${SUBTITLE_TEXT}"`, subtitle !== undefined)
    if (title !== undefined && subtitle !== undefined) {
      c.ok(
        'the title is set larger than the subtitle',
        (title.fontSize ?? 0) > (subtitle.fontSize ?? 0),
        `title ${title.fontSize}px, subtitle ${subtitle.fontSize}px`,
      )
    }
    c.eq("the deck outline reads the slide's title", outline.slides[0]?.title, TITLE_TEXT)
    return c.done()
  },
})
