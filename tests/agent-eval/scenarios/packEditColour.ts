import { Checks } from '../lib/checks.js'
import { defineScenario } from '../lib/types.js'
import { packDeck } from './packHelpers.js'

/**
 * A4.3: a brand colour is changed in the folder's style pack and compiled,
 * so the folder's tokens (and every slide drawn with them) follow — not by
 * editing the compiled token, which the next compile would overwrite.
 */
export default defineScenario({
  id: 'pack-edit-colour',
  title: "Change a brand colour in the folder's style pack and compile it",
  covers: ['style.pack.edit', 'style.pack.get'],
  maxTurns: 10,
  replay: true,
  async setup(world) {
    return packDeck(world, 'Pack colour')
  },
  steps: (fx) => [
    `In the Narrative folder that holds the deck "${fx.title}" (folder id ${fx.folderId}), change the brand's red to #d0021b in its style pack and compile the pack so the folder's colours follow.`,
  ],
  async grade({ world, fixture: fx }) {
    const c = new Checks()
    const pack = await world.run<{
      value: { tokens: { colors: Record<string, { value: string }> } }
    }>({ folderId: fx.folderId }, 'style.pack.get', { part: 'pack' })
    c.eq("the pack's red", pack.value.tokens.colors['red']?.value.toLowerCase(), '#d0021b')
    const tokens = await world.run<{ colors: Array<{ id: string; value: string }> }>(
      { folderId: fx.folderId },
      'token.list',
      {},
    )
    const red = tokens.colors.find((t) => t.id === 'p-example-color-red')
    c.eq('the compiled red token follows', red?.value.toLowerCase(), '#d0021b')
    c.eq('the navy is untouched', pack.value.tokens.colors['navy']?.value.toLowerCase(), '#001e50')
    return c.done()
  },
})
