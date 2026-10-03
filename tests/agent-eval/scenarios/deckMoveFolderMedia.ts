import { Checks, callsOf, readSlide } from '../lib/checks.js'
import { gradientPng } from '../lib/png.js'
import { EvalCommandError, defineScenario } from '../lib/types.js'
import { buildDeck, deckRef, titledSlide } from './helpers.js'

/**
 * deck.moveToFolder, positive: a deck whose second slide shows a stamped
 * component picture (linked from the eval folder, not owned by the deck)
 * moves into another folder. The move needs the user's confirmation; the
 * harness approves it between the steps, as the user would on Narrative's
 * page. Afterwards the deck is in the destination, its picture is a copy
 * the deck owns (a new asset id that `media.url` resolves on the deck,
 * while the component's own picture no longer does there), and the
 * confirmation the user saw said that the deck's active share link will
 * show the destination folder's component media.
 *
 * Written 2026-10-03 (folder sharing step 2); live-only, and not run yet —
 * it needs a live run before it can be trusted (`just eval --filter
 * deck-move-folder-media`).
 */

const LOGO = gradientPng(120, 60)

/** The id in `"confirmationId": "<id>"` of a confirmation_required message. */
function confirmationIdIn(text: string): string | null {
  return /"confirmationId": "([A-Za-z0-9_-]{22})"/.exec(text)?.[1] ?? null
}

export default defineScenario({
  id: 'deck-move-folder-media',
  title: 'Move a deck with a stamped component picture into another folder',
  covers: ['deck.moveToFolder'],
  maxTurns: 10,
  requires: ['componentRoute'],
  replay: {
    reason:
      'the move copies linked component media on the server and needs a confirmation approved on the page; the memory world models neither',
  },
  async setup(world) {
    const componentName = `Logo block ${world.tag}`
    const componentId = await world.createComponent(world.evalFolderId, componentName)
    const { assetId } = await world.run<{ assetId: string }>({ componentId }, 'media.upload', {
      file: { base64: Buffer.from(LOGO).toString('base64'), filename: 'logo.png' },
    })
    await world.batch({ componentId }, [
      {
        command: 'object.create',
        input: {
          slide: { index: 0 },
          object: { type: 'image', name: 'logo', assetId, x: 80, y: 60, width: 240, height: 120 },
        },
      },
    ])
    const deck = await buildDeck(
      world,
      `Quarterly ${world.tag}`,
      [titledSlide('Quarterly'), { objects: [] }],
      world.evalFolderId,
    )
    // Linked, not copied: the stamp points at the master's own picture.
    await world.run({ deckId: deck.deckId }, 'component.stamp', {
      componentId,
      slide: { index: 1 },
    })
    await world.run(
      { deckId: deck.deckId },
      'share.links.create',
      { role: 'viewer' },
      { confirm: ['share.links.create'] },
    )
    const destFolderName = `Archive ${world.tag}`
    const destFolderId = await world.createFolder(destFolderName)
    return {
      deckId: deck.deckId,
      title: deck.title,
      componentId,
      assetId,
      destFolderId,
      destFolderName,
    }
  },
  steps: (fx) => [
    `Move the Narrative deck ${deckRef(fx)} into my folder "${fx.destFolderName}".`,
    'I approved it in Narrative. Go ahead.',
  ],
  async afterStep(world, _fx, index, notes, transcript) {
    if (index !== 0) return
    const asked = (transcript.steps[0]?.calls ?? []).filter(
      (call) => call.command === 'deck.moveToFolder' && call.errorCode === 'confirmation_required',
    )
    const last = asked.at(-1)
    if (last === undefined) return
    notes['confirmationText'] = last.text
    const id = confirmationIdIn(last.text)
    if (id !== null) await world.approveConfirmation(id)
  },
  async grade({ world, fixture: fx, transcript, notes }) {
    const c = new Checks()
    const asked = (transcript.steps[0]?.calls ?? []).filter(
      (call) => call.command === 'deck.moveToFolder' && call.errorCode === 'confirmation_required',
    )
    c.ok('the move asked for the user’s confirmation first', asked.length > 0)
    const text = typeof notes['confirmationText'] === 'string' ? notes['confirmationText'] : ''
    c.ok(
      "the confirmation said the share link will show the destination folder's component media",
      /Share links: 1 active: whoever holds one will also see the destination folder's component pictures and videos/.test(
        text,
      ),
      text.slice(0, 600),
    )
    const moves = callsOf(transcript, 'deck.moveToFolder', { ok: true })
    c.ok('deck.moveToFolder succeeded once approved', moves.length > 0)
    const report = moves.at(-1)?.result as { media?: { copied?: number } } | undefined
    c.ok(
      'the move reported the stamped picture as taken along',
      (report?.media?.copied ?? 0) >= 1,
      JSON.stringify(report),
    )

    const deck = await world.run<{ folderId: string | null }>({ deckId: fx.deckId }, 'deck.get')
    c.eq('the deck is in the destination folder', deck.folderId, fx.destFolderId)

    const slide = await readSlide(world, { deckId: fx.deckId }, { index: 1 })
    const picture = slide.objects.find((o) => o.type === 'image') as
      | { assetId?: string }
      | undefined
    if (!c.ok('the stamped picture is still on slide 2', picture?.assetId !== undefined)) {
      return c.done()
    }
    c.ok(
      "the picture is the deck's own copy now, not the component's",
      picture!.assetId !== fx.assetId,
      `assetId ${picture!.assetId}`,
    )
    try {
      const served = await world.run<{ url: string }>({ deckId: fx.deckId }, 'media.url', {
        assetId: picture!.assetId,
      })
      c.ok('media.url resolves the copy on the deck', served.url.length > 0)
    } catch (err) {
      c.error('media.url resolves the copy on the deck', err)
    }
    let componentPictureShown = true
    try {
      await world.run({ deckId: fx.deckId }, 'media.url', { assetId: fx.assetId })
    } catch (err) {
      if (err instanceof EvalCommandError) componentPictureShown = false
      else throw err
    }
    c.ok(
      "the component's own picture is not the deck's to show in the new folder",
      !componentPictureShown,
    )
    return c.done()
  },
})
