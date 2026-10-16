import { Checks } from '../lib/checks.js'
import { defineScenario } from '../lib/types.js'
import { packDeck } from './packHelpers.js'

/**
 * A4.2d: a folder colour that differs per deck variant is one token with
 * `byVariant` on the pack's axis — not a second token, not a change of the
 * value every light deck uses.
 */
export default defineScenario({
  id: 'token-by-variant',
  title: 'Give a folder colour its own value on dark decks',
  covers: ['token.update', 'token.list'],
  maxTurns: 8,
  replay: true,
  async setup(world) {
    const fx = await packDeck(world, 'Variant colour')
    const { tokenId } = await world.run<{ tokenId: string }>(
      { folderId: fx.folderId },
      'token.create',
      { category: 'colors', name: 'Highlight', value: '#e4002b' },
    )
    return { ...fx, tokenId }
  },
  steps: (fx) => [
    `In the Narrative folder that holds the deck "${fx.title}" (folder id ${fx.folderId}), the folder colour "Highlight" should be white on decks in the brand's dark background variant; on light decks it stays as it is.`,
  ],
  async grade({ world, fixture: fx }) {
    const c = new Checks()
    const tokens = await world.run<{
      colors: Array<{
        id: string
        name: string
        value: string
        byVariant?: { axis: string; values: Record<string, string> }
      }>
    }>({ folderId: fx.folderId }, 'token.list', {})
    const hl = tokens.colors.find((t) => t.id === fx.tokenId)
    c.eq('its light value is unchanged', hl?.value.toLowerCase(), '#e4002b')
    c.eq('it varies on the background axis', hl?.byVariant?.axis, 'background')
    c.eq('white on dark', hl?.byVariant?.values['dark']?.toLowerCase(), '#ffffff')
    c.eq(
      'no second Highlight colour',
      tokens.colors.filter((t) => /highlight/i.test(t.name)).length,
      1,
    )
    return c.done()
  },
})
