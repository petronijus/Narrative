import { Checks, callsOf, objectById, readSlide } from '../lib/checks.js'
import { defineScenario } from '../lib/types.js'
import { deckRef } from './helpers.js'

/**
 * A guest of one deck reads its folder's design tokens (folder sharing,
 * follow-up of step 4; `folderReaders: 'content'`): a colleague shares ONE
 * deck of their folder with the user — not the folder — and the user asks
 * for a box in the folder's "Kestrel Teal". Only the name is given, so the
 * agent must read the folder's tokens (token.list on the deck's folder,
 * allowed to a deck guest as in the editor) to fill the box with that
 * colour: the token itself, or its exact value.
 *
 * Live-only: the folder belongs to a second person (`World.person`).
 */

interface ColorToken {
  id: string
  name: string
  value: string
}

const TEAL = { name: 'Kestrel Teal', hex: '#0f766e' }

export default defineScenario({
  id: 'folder-guest-reads-tokens',
  title: "A guest of one deck fills a box with its folder's named colour",
  covers: ['token.list', 'object.update'],
  maxTurns: 10,
  replay: {
    reason: 'the folder belongs to a second person, and the memory world has one user',
  },
  async setup(world) {
    const owner = await world.person('folder-owner')
    const folderId = await world.createFolderAs(owner, `Partner Merlin ${world.tag}`)
    await world.runAs(owner, { folderId }, 'token.create', {
      category: 'colors',
      name: TEAL.name,
      value: TEAL.hex,
    })
    const { colors } = await world.runAs<{ colors: ColorToken[] }>(
      owner,
      { folderId },
      'token.list',
    )
    const teal = colors.find((t) => t.name === TEAL.name)
    if (teal === undefined) throw new Error('the colour token was not created')
    const title = `Merlin pitch ${world.tag}`
    const { id: deckId } = await world.runAs<{ id: string }>(owner, {}, 'deck.create', {
      title,
      folderId,
    })
    const { objectId: panelId } = await world.runAs<{ objectId: string }>(
      owner,
      { deckId },
      'object.create',
      {
        slide: { index: 0 },
        object: {
          type: 'rectangle',
          x: 560,
          y: 240,
          width: 800,
          height: 600,
          fill: '#d9d9d9',
          name: 'Panel',
        },
      },
    )
    await world.runAs(
      owner,
      { deckId },
      'share.permissions.invite',
      { email: await world.userEmail(), role: 'editor' },
      { confirm: ['share.permissions.invite'] },
    )
    return { deckId, title, folderId, panelId, tealId: teal.id }
  },
  steps: (fx) => [
    `On slide 1 of the Narrative deck ${deckRef(fx)}, fill the "Panel" rectangle with the "${TEAL.name}" colour from the deck folder's design tokens.`,
  ],
  async grade({ world, fixture: fx, transcript }) {
    const c = new Checks()
    c.eq(
      "the agent read the folder's tokens, as a guest of the deck",
      callsOf(transcript, 'token.list', { ok: true }).length > 0,
      true,
    )
    c.eq(
      'no folder read was refused',
      callsOf(transcript, 'token.list').filter((call) => call.errorCode === 'forbidden').length,
      0,
    )
    const slide = await readSlide(world, { deckId: fx.deckId }, { index: 0 })
    const panel = objectById(slide, fx.panelId)
    const fill = panel?.['fill']
    c.ok(
      'the panel is filled with the folder colour (the token, or its exact value)',
      (typeof fill === 'object' &&
        fill !== null &&
        (fill as Record<string, unknown>)['$token'] === `colors.${fx.tealId}`) ||
        (typeof fill === 'string' && fill.toLowerCase() === TEAL.hex),
      JSON.stringify(fill),
    )
    return c.done()
  },
})
