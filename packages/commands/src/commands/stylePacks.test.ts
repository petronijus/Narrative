/**
 * stylePacks.test.ts — `style.pack.*` against the fake services (which hold
 * the example pack in the fixture folder, as the server would): reading it
 * in parts, refusing an invalid pack whole, an update and its exact undo,
 * delete and set back, and a compile that is idempotent and leaves
 * hand-made tokens alone.
 */

import { describe, expect, it } from 'vitest'
import { exampleStylePack } from '@narrative/shared'
import { readFolderTokens } from '@narrative/slide-model'
import { createDefaultRegistry } from '../catalog.js'
import { runCommand } from '../run.js'
import { CommandError } from '../errors.js'
import { LOCAL_ORIGIN } from '@narrative/slide-model'
import {
  createFakeServices,
  FIXTURE_FOLDER_ID,
  type FakeServices,
} from '../testing/fakeServices.js'
import type { CommandContext } from '../types.js'

const registry = createDefaultRegistry()

function ctx(): CommandContext & { services: FakeServices } {
  return {
    actor: { userId: 'u1', role: 'owner', kind: 'agent' },
    host: 'server',
    origin: LOCAL_ORIGIN,
    target: { folderId: FIXTURE_FOLDER_ID },
    services: createFakeServices(),
  } as CommandContext & { services: FakeServices }
}

const run = <T>(c: CommandContext, id: string, input: unknown) =>
  runCommand(registry, c, id, input) as Promise<T>

async function failure(p: Promise<unknown>): Promise<CommandError> {
  try {
    await p
  } catch (e) {
    if (e instanceof CommandError) return e
    throw e
  }
  throw new Error('expected a CommandError')
}

describe('style.pack.get', () => {
  it('reads a summary, the layouts in brief, one layout and the whole pack', async () => {
    const c = ctx()
    const summary = await run<{ value: Record<string, unknown> }>(c, 'style.pack.get', {
      part: 'summary',
    })
    expect(summary.value).toMatchObject({
      id: 'example',
      variants: [{ axis: 'background', default: 'light', values: ['light', 'dark'] }],
    })
    const layouts = await run<{ value: Array<Record<string, unknown>> }>(c, 'style.pack.get', {
      part: 'layouts',
    })
    expect(layouts.value.map((l) => l['id'])).toEqual(['title', 'title-bullets', 'picture'])
    expect(layouts.value[1]!['slots']).toEqual([
      { slot: 'title', role: 'title', type: 'text' },
      { slot: 'bullets', role: 'body', type: 'text', maxLines: 12 },
    ])
    const one = await run<{ value: { id: string } }>(c, 'style.pack.get', {
      part: 'layout',
      layoutId: 'picture',
    })
    expect(one.value.id).toBe('picture')
    expect(
      (await failure(run(c, 'style.pack.get', { part: 'layout', layoutId: 'nope' }))).code,
    ).toBe('not_found')
  })
})

describe('style.pack.edit', () => {
  it('refuses an invalid result whole and writes nothing', async () => {
    const c = ctx()
    const e = await failure(
      run(c, 'style.pack.edit', {
        op: 'update',
        patch: {
          layouts: {
            title: {
              regions: [
                { slot: 'x', role: 'body', type: 'text', rect: [0, 0, 2, 1], textStyle: 'body' },
              ],
            },
          },
        },
      }),
    )
    expect(e.code).toBe('invalid_input')
    expect(e.message).toContain('layouts[0].regions[0].rect')
    const pack = await run<{ value: { layouts: Array<{ id: string; regions: unknown[] }> } }>(
      c,
      'style.pack.get',
      { part: 'pack' },
    )
    expect(pack.value.layouts[0]!.regions).toHaveLength(2)
  })

  it('an update returns the update that undoes it exactly', async () => {
    const c = ctx()
    const before = (await run<{ value: unknown }>(c, 'style.pack.get', { part: 'pack' })).value
    const { previous } = await run<{ previous: Record<string, unknown> }>(c, 'style.pack.edit', {
      op: 'update',
      patch: {
        tokens: { colors: { red: { value: '#d0021b' }, pink: { name: 'Pink', value: '#ff00aa' } } },
        layouts: { 'title-bullets': { purpose: 'Shorter.' } },
      },
    })
    await run(c, 'style.pack.edit', { op: 'update', patch: previous })
    expect((await run<{ value: unknown }>(c, 'style.pack.get', { part: 'pack' })).value).toEqual(
      before,
    )
  })

  it('delete returns the pack, and set puts it back', async () => {
    const c = ctx()
    const { previous } = await run<{ previous: Record<string, unknown> }>(c, 'style.pack.edit', {
      op: 'delete',
    })
    expect((await run<{ value: unknown }>(c, 'style.pack.get', { part: 'summary' })).value).toBe(
      null,
    )
    await run(c, 'style.pack.edit', { op: 'set', pack: previous })
    expect((await run<{ value: unknown }>(c, 'style.pack.get', { part: 'pack' })).value).toEqual(
      exampleStylePack(),
    )
  })

  it('compiles idempotently, and leaves hand-made tokens alone', async () => {
    const c = ctx()
    const first = await run<{ compiled: Record<string, unknown> }>(c, 'style.pack.edit', {
      op: 'compile',
    })
    // The fixture folder's tokens already hold the example pack's (compiled once).
    expect(first.compiled).toMatchObject({
      colors: { created: 0 },
      textStyles: { created: 0 },
      components: { created: 2, updated: 0 },
      missingFonts: ['Inter 700', 'Inter 400'],
    })
    const second = await run<{ compiled: Record<string, unknown> }>(c, 'style.pack.edit', {
      op: 'compile',
    })
    expect(second.compiled).toMatchObject({ components: { created: 0, updated: 2 } })
    const tokens = (
      c.services.snapshot() as {
        folderTokens: Array<[string, ReturnType<typeof readFolderTokens>]>
      }
    ).folderTokens.find(([id]) => id === FIXTURE_FOLDER_ID)![1]
    // The fixture's own "Title" is untouched; the pack's is named after the pack.
    expect(tokens.textStyles['title']).toMatchObject({ name: 'Title', size: 72 })
    expect(tokens.textStyles['p-example-textStyle-title']).toMatchObject({
      name: 'Title (Example)',
    })
  })

  it('a compile takes off a compiled token what the pack no longer sets', async () => {
    const c = ctx()
    await run(c, 'style.pack.edit', { op: 'compile' })
    const body = () =>
      (
        c.services.snapshot() as {
          folderTokens: Array<[string, ReturnType<typeof readFolderTokens>]>
        }
      ).folderTokens.find(([id]) => id === FIXTURE_FOLDER_ID)![1].textStyles[
        'p-example-textStyle-body'
      ]
    expect(body()).toMatchObject({ minSize: 24 })
    expect(body()?.levels).toHaveLength(2)
    await run(c, 'style.pack.edit', {
      op: 'update',
      patch: { textStyles: { body: { levels: null, minSize: null } } },
    })
    await run(c, 'style.pack.edit', { op: 'compile' })
    expect(body()).toMatchObject({ name: 'Body (Example)', size: 32 })
    expect(body()?.levels).toBeUndefined()
    expect(body()?.minSize).toBeUndefined()
  })
})
