/**
 * commands/src/commands/stylePacks.ts — `style.pack.*` (agentic A4.3/A4.4):
 * a folder's style pack, the client's brand as Narrative's building blocks
 * (docs/plans/a4-style-packs.md). Two tools with an operation each (A4.0
 * decided few tools): `style.pack.get` reads a part of it, sized for a
 * model; `style.pack.edit` sets, patches or compiles it. Backed by the
 * server's StylePackService, which validates every change.
 */

import { z } from 'zod'
import type { PackLayout, StylePack } from '@narrative/shared'
import { defineCommand } from '../registry.js'
import { requireServices } from '../services.js'
import { CommandError } from '../errors.js'
import { serverCommand, targetFolderId } from './serverShared.js'

const packCommand = {
  ...serverCommand,
  domain: 'style',
  scope: 'folder',
  effects: ['server'],
  confirm: 'never',
} as const

/** A layout in brief: what a model picks a layout by. */
export function layoutBrief(layout: PackLayout): Record<string, unknown> {
  return {
    id: layout.id,
    name: layout.name,
    family: layout.family,
    purpose: layout.purpose,
    ...(layout.surface !== undefined ? { surface: layout.surface } : {}),
    slots: layout.regions.map((r) => ({
      slot: r.slot,
      role: r.role,
      type: r.type,
      ...(r.required === true ? { required: true } : {}),
      ...(r.maxLines !== undefined ? { maxLines: r.maxLines } : {}),
    })),
  }
}

/** The pack in brief: its variants, styles, layouts and rules by name. */
export function packSummary(pack: StylePack): Record<string, unknown> {
  return {
    id: pack.id,
    name: pack.name,
    variants: pack.tokens.axes.map((a) => ({
      axis: a.id,
      default: a.default,
      values: a.values.map((v) => v.id),
    })),
    surfaces: Object.keys(pack.tokens.surfaces ?? {}),
    colors: Object.fromEntries(Object.entries(pack.tokens.colors).map(([id, c]) => [id, c.value])),
    fonts: Object.fromEntries(Object.entries(pack.fonts).map(([id, f]) => [id, f.family])),
    textStyles: Object.fromEntries(
      Object.entries(pack.textStyles).map(([id, s]) => [id, `${s.name} ${s.size}px`]),
    ),
    layouts: pack.layouts.map((l) => `${l.id}: ${l.purpose}`),
    components: pack.components.map((c) => `${c.id} (${c.kind})`),
    furniture: Object.keys(pack.furniture.items),
    archetypeMap: pack.archetypeMap,
    editorial: {
      titleMode: pack.editorial.titleMode,
      title: pack.editorial.title,
      languages: pack.editorial.languages,
      ...(pack.editorial.voice !== undefined ? { voice: pack.editorial.voice } : {}),
    },
  }
}

export const stylePackGet = defineCommand({
  ...packCommand,
  id: 'style.pack.get',
  role: 'viewer',
  title: "Read the folder's style pack",
  description:
    "The folder's style pack — its brand as layouts, text styles, colour variants, components and rules. " +
    '`part`: "summary" (start here), "layouts" (each id, purpose and slots: pick one by purpose), "layout" ' +
    '(one in full, with `layoutId`) or "pack" (all, large). null when the folder has none. Any folder member, or anyone with access to one of its decks.',
  input: z.strictObject({
    part: z.enum(['summary', 'layouts', 'layout', 'pack']),
    layoutId: z.string().min(1).max(48).optional(),
  }),
  output: z.object({ part: z.string(), value: z.unknown() }),
  folderReaders: 'content',
  readOnly: true,
  undo: 'n/a',
  examples: [
    { title: "What the folder's brand offers", input: { part: 'summary' } },
    { title: 'The layouts to choose from', input: { part: 'layouts' } },
    { title: 'One layout in full', input: { part: 'layout', layoutId: 'title-bullets' } },
  ],
  async handler(ctx, input) {
    const pack = await requireServices(ctx).stylePacks.get({
      userId: ctx.actor.userId,
      folderId: targetFolderId(ctx),
    })
    if (pack === null) return { part: input.part, value: null }
    switch (input.part) {
      case 'summary':
        return { part: 'summary', value: packSummary(pack) }
      case 'layouts':
        return { part: 'layouts', value: pack.layouts.map(layoutBrief) }
      case 'pack':
        return { part: 'pack', value: pack }
      case 'layout': {
        if (input.layoutId === undefined)
          throw new CommandError('invalid_input', 'part "layout" needs `layoutId`')
        const layout = pack.layouts.find((l) => l.id === input.layoutId)
        if (layout === undefined)
          throw new CommandError(
            'not_found',
            `no layout '${input.layoutId}'; the pack has ${pack.layouts.map((l) => l.id).join(', ')}`,
          )
        return { part: 'layout', value: layout }
      }
    }
  },
})

export const stylePackEdit = defineCommand({
  ...packCommand,
  id: 'style.pack.edit',
  role: 'editor',
  title: "Change the folder's style pack",
  description:
    'Change the folder\'s style pack. `op`: "set" replaces it with `pack` (a whole pack, as style.pack.get ' +
    '"pack" returns it); "update" applies `patch`, a JSON merge patch (null removes; `layouts` and ' +
    '`components` may be objects keyed by id, to change, add or (null) remove single ones); "delete" removes ' +
    'it; "compile" turns it into the folder\'s colour and text-style tokens and component masters (updating ' +
    'only what an earlier compile made, never what people made) and names the fonts the folder still needs. ' +
    'The result is validated whole; nothing is written when it is invalid. `previous`: for an update, the ' +
    'update that undoes it; for set/delete, the pack before (null: none). Undo a compile: put the pack back ' +
    'and compile again (what a first compile created stays). Only when the user asked for a brand change. ' +
    'Needs folder editor.',
  input: z.discriminatedUnion('op', [
    z.strictObject({ op: z.literal('set'), pack: z.record(z.string(), z.unknown()) }),
    z.strictObject({ op: z.literal('update'), patch: z.record(z.string(), z.unknown()) }),
    z.strictObject({ op: z.literal('delete') }),
    z.strictObject({ op: z.literal('compile') }),
  ]),
  output: z.object({
    previous: z.record(z.string(), z.unknown()).nullable().optional(),
    compiled: z
      .object({
        colors: z.object({ created: z.number(), updated: z.number() }),
        textStyles: z.object({ created: z.number(), updated: z.number() }),
        components: z.object({ created: z.number(), updated: z.number() }),
        missingFonts: z.array(z.string()),
      })
      .optional(),
  }),
  undo: 'undoable',
  undoneBy: 'style.pack.edit',
  implementedWith: [
    'setStylePack',
    'patchStylePack',
    'deleteStylePack',
    'addFolderToken',
    'updateFolderToken',
    'replaceMasterObjects',
  ],
  examples: [
    {
      title: 'Change one accent colour of the pack',
      input: { op: 'update', patch: { tokens: { colors: { red: { value: '#d0021b' } } } } },
    },
    {
      title: "Reword one layout's purpose",
      input: {
        op: 'update',
        patch: { layouts: { 'title-bullets': { purpose: 'A headline and up to five bullets.' } } },
      },
    },
    { title: "Make the pack the folder's tokens and masters", input: { op: 'compile' } },
  ],
  async handler(ctx, input) {
    const services = requireServices(ctx)
    const args = { userId: ctx.actor.userId, folderId: targetFolderId(ctx) }
    switch (input.op) {
      case 'set':
        return services.stylePacks.set({ ...args, pack: input.pack })
      case 'update':
        return services.stylePacks.update({ ...args, patch: input.patch })
      case 'delete':
        return services.stylePacks.delete(args)
      case 'compile':
        return { compiled: await services.stylePacks.compile(args) }
    }
  },
})

export const stylePackCommands = [stylePackGet, stylePackEdit]
