import { Checks } from '../lib/checks.js'
import { gradientPng } from '../lib/png.js'
import { defineScenario } from '../lib/types.js'

/** 480 × 240: a picture far too big to write out as base64 through the model. */
const BADGE = gradientPng(480, 240)

interface MasterObject {
  id: string
  type: string
  x: number
  y: number
  width: number
  height: number
  assetId?: string
}

export default defineScenario({
  id: 'component-master-picture',
  title: "Add a local picture to a folder component's master (shell upload session)",
  covers: ['media.uploadSession'],
  maxTurns: 14,
  requires: ['componentRoute'],
  replay: {
    reason: 'the component comes from the web app REST route and lives in its own server document',
  },
  workspace: () => ({ files: { 'badge.png': BADGE }, shell: true }),
  async setup(world) {
    const componentName = `Footer ${world.tag}`
    const componentId = await world.createComponent(world.evalFolderId, componentName)
    await world.batch({ componentId }, [
      {
        command: 'object.create',
        input: {
          slide: { index: 0 },
          object: {
            type: 'text',
            name: 'footer',
            text: 'Confidential',
            x: 80,
            y: 1000,
            width: 600,
            height: 40,
            fontSize: 20,
          },
        },
      },
    ])
    return { componentId, componentName, folderId: world.evalFolderId }
  },
  steps: (fx) => [
    `The file badge.png in the current directory is our quality badge. Add it to the master of the folder component "${fx.componentName}" in Narrative, in the bottom-right corner, 160 px wide with its proportions kept, so every future stamp of the component shows it.`,
  ],
  async grade({ world, fixture: fx, transcript }) {
    const c = new Checks()
    const calls = transcript.steps.flatMap((s) => s.calls)
    c.ok(
      'the file went through an upload session for the master, not as base64 through the model',
      calls.some((call) => call.command === 'media.uploadSession' && !call.isError) &&
        !calls.some(
          (call) =>
            call.command === 'media.upload' &&
            typeof (call.input['file'] as Record<string, unknown> | undefined)?.['base64'] ===
              'string',
        ),
      calls.map((call) => call.tool).join(' > '),
    )
    const master = await world.run<{ objects: MasterObject[] }>(
      { folderId: fx.folderId },
      'component.get',
      { componentId: fx.componentId },
    )
    const badge = master.objects.find((o) => o.type === 'image')
    if (!c.ok('the master has an image', badge !== undefined) || badge === undefined) {
      return c.done()
    }
    const served = await world
      .run<{ url: string }>({ componentId: fx.componentId }, 'media.url', {
        assetId: badge.assetId,
      })
      .then(() => true)
      .catch(() => false)
    c.ok('it shows a picture the component owns', served, String(badge.assetId))
    c.ok(
      '160 px wide, proportions kept (480 × 240 → 160 × 80)',
      Math.abs(badge.width - 160) <= 2 && Math.abs(badge.height - 80) <= 2,
      `${badge.width} × ${badge.height}`,
    )
    c.ok(
      'in the bottom-right corner',
      badge.x + badge.width >= 1920 - 200 &&
        badge.x + badge.width <= 1920 &&
        badge.y + badge.height >= 1080 - 200 &&
        badge.y + badge.height <= 1080,
      `${badge.x}, ${badge.y}`,
    )
    c.ok(
      'the footer text is still there',
      master.objects.some((o) => o.type === 'text'),
    )
    return c.done()
  },
})
