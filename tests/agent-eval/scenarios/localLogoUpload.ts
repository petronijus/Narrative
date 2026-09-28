import { Checks, readSlide } from '../lib/checks.js'
import { gradientPng } from '../lib/png.js'
import { defineScenario } from '../lib/types.js'
import { buildDeck, deckRef, titleBox } from './helpers.js'

/** 600 × 300: a picture far too big to write out as base64 through the model. */
const LOGO = gradientPng(600, 300)

export default defineScenario({
  id: 'local-logo-upload',
  title: 'Put a logo from a local file onto a slide (shell upload session)',
  covers: ['media.uploadSession'],
  maxTurns: 14,
  replay: {
    reason: 'the file goes through the live tus server with curl; the memory world has neither',
  },
  workspace: () => ({ files: { 'logo.png': LOGO }, shell: true }),
  async setup(world) {
    const deck = await buildDeck(
      world,
      `Brand ${world.tag}`,
      [{ objects: [{ key: 'title', object: titleBox('Who we are') }] }],
      world.evalFolderId,
    )
    return { deckId: deck.deckId, title: deck.title }
  },
  steps: (fx) => [
    `The file logo.png in the current directory is our logo. Put it on slide 1 of the Narrative deck ${deckRef(fx)}, in the top-right corner, 300 px wide with its proportions kept.`,
  ],
  async grade({ world, fixture: fx, transcript }) {
    const c = new Checks()
    const calls = transcript.steps.flatMap((s) => s.calls)
    c.ok(
      'the file went through an upload session, not as base64 through the model',
      calls.some((call) => call.command === 'media.uploadSession' && !call.isError) &&
        !calls.some(
          (call) =>
            call.command === 'media.upload' &&
            typeof (call.input['file'] as Record<string, unknown> | undefined)?.['base64'] ===
              'string',
        ),
      calls.map((call) => call.tool).join(' > '),
    )
    const slide = await readSlide(world, { deckId: fx.deckId }, { index: 0 })
    const logo = slide.objects.find((o) => o.type === 'image')
    if (!c.ok('an image is on slide 1', logo !== undefined) || logo === undefined) return c.done()
    const served = await world
      .run<{ url: string }>({ deckId: fx.deckId }, 'media.url', { assetId: logo['assetId'] })
      .then(() => true)
      .catch(() => false)
    c.ok('it shows an asset of this deck (the uploaded file)', served, String(logo['assetId']))
    c.ok(
      '300 px wide, proportions kept (600 × 300 → 300 × 150)',
      Math.abs(logo.width - 300) <= 2 && Math.abs(logo.height - 150) <= 2,
      `${logo.width} × ${logo.height}`,
    )
    c.ok(
      'in the top-right corner',
      logo.x + logo.width >= 1920 - 200 && logo.x + logo.width <= 1920 && logo.y <= 200,
      `${logo.x}, ${logo.y}`,
    )
    return c.done()
  },
})
