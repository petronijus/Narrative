/**
 * services/stylePacks.ts — server implementation of `StylePackService`
 * (packages/commands/src/services/stylePacks.ts, agentic A4.3/A4.4): a
 * folder's style pack, in its folder document (slide-model folderPack.ts),
 * written live through the sync server like the folder's tokens.
 *
 *   - `get` reads the stored or live copy; members and deck guests read it.
 *   - `set` / `update` / `delete` validate before the first write (the
 *     whole pack, `parseStylePack`; an update is validated on its result)
 *     and return what they replaced.
 *   - `compile` makes the pack the folder's colour and text-style tokens
 *     and its component masters (stylePack/compile.ts plans it): what an
 *     earlier compile made is updated, everything people made is left as it
 *     is; changed text styles reach the text linked to them as a token
 *     change does (`queuePropagation`).
 */

import { and, eq } from 'drizzle-orm'
import type * as Y from 'yjs'
import {
  addFolderToken,
  deleteStylePack,
  mergeStylePackPatch,
  patchStylePack,
  readFolderTokens,
  readMasterOrigin,
  readStylePack,
  replaceMasterObjects,
  setStylePack,
  updateFolderToken,
} from '@narrative/slide-model'
import {
  compileStylePack,
  linkedTextFields,
  storedStylePack,
  parseNewTokenFields,
  parseStylePack,
  previousOfUpdate,
  type StylePackCompile,
  type StylePackService,
} from '@narrative/commands'
import type { SlideObject, StylePack, TextObject } from '@narrative/shared'
import { components } from '../db/schema.js'
import { listFolderFontAssets } from '../media/assets.js'
import type { ServiceDeps } from './deps.js'
import { notFound } from './errors.js'
import { readDocCopy, writeLiveDoc } from './liveDocs.js'
import { requireFolderContentReader, requireFolderRole } from './shared.js'
import { createEmptyComponent } from './componentStaging.js'
import { queuePropagation } from './tokens.js'

export function createStylePacksService(deps: ServiceDeps): StylePackService {
  const { db } = deps
  const editor = (folderId: string, userId: string) =>
    requireFolderRole(db, folderId, userId, 'editor', { bypass: deps.bypass })

  async function read(folderId: string): Promise<StylePack | null> {
    const copy = await readDocCopy(deps, 'folder', folderId)
    try {
      return readStylePack(copy) as StylePack | null
    } finally {
      copy.destroy()
    }
  }

  return {
    async get(args) {
      // A deck guest's agent builds with its folder's pack, as it reads its tokens.
      await requireFolderContentReader(db, args.folderId, args.userId, { bypass: deps.bypass })
      return read(args.folderId)
    },

    async set(args) {
      await editor(args.folderId, args.userId)
      const pack = parseStylePack(args.pack)
      return writeLiveDoc(deps, 'folder', args.folderId, (doc) => {
        const previous = readStylePack(doc)
        setStylePack(doc, pack as unknown as Record<string, unknown>)
        return { previous }
      })
    },

    async update(args) {
      await editor(args.folderId, args.userId)
      return writeLiveDoc(deps, 'folder', args.folderId, (doc) => {
        const current = readStylePack(doc)
        if (current === null) throw notFound('The folder has no style pack; set one first')
        // Validated on the result, before anything is written.
        parseStylePack(mergeStylePackPatch(current, args.patch))
        patchStylePack(doc, args.patch)
        return { previous: previousOfUpdate(current, args.patch) }
      })
    },

    async delete(args) {
      await editor(args.folderId, args.userId)
      return writeLiveDoc(deps, 'folder', args.folderId, (doc) => {
        const previous = readStylePack(doc)
        if (previous !== null) deleteStylePack(doc)
        return { previous }
      })
    },

    async compile(args): Promise<StylePackCompile> {
      await editor(args.folderId, args.userId)
      const pack = await read(args.folderId)
      if (pack === null) throw notFound('The folder has no style pack to compile')
      const fonts = (await listFolderFontAssets(db, args.folderId)).map((row) => ({
        family: row.fontFamily,
        weight: row.fontWeight,
        ...(row.fontAxes !== null &&
        (row.fontAxes.wght !== undefined || row.fontAxes.wdth !== undefined)
          ? { axes: row.fontAxes }
          : {}),
      }))

      // 1. Tokens: one transaction on the folder document.
      const tokenResult = await writeLiveDoc(deps, 'folder', args.folderId, (doc) => {
        const plan = compileStylePack(storedStylePack(pack), {
          tokens: readFolderTokens(doc),
          fonts,
        })
        const counts = {
          colors: { created: 0, updated: 0 },
          textStyles: { created: 0, updated: 0 },
        }
        const changedStyles = new Set<string>()
        for (const category of ['colors', 'textStyles'] as const) {
          for (const t of plan[category]) {
            // The same validation every token writer passes through.
            const fields = parseNewTokenFields(category, t.fields)
            if (category === 'textStyles') fields['builtin'] = false
            fields['origin'] = t.origin
            if (t.exists) {
              // The token is the pack's: what the pack no longer sets goes.
              updateFolderToken(doc, category, t.id, fields, { replace: true })
              counts[category].updated++
            } else {
              addFolderToken(doc, category, t.id, fields)
              counts[category].created++
            }
            if (category === 'textStyles') changedStyles.add(t.id)
          }
        }
        return { plan, counts, changedStyles, tokens: readFolderTokens(doc) }
      })

      // 2. Masters: the ones the pack made before, by origin; new ones created.
      const rows = await db
        .select({ id: components.id })
        .from(components)
        .where(and(eq(components.folderId, args.folderId)))
      const byOrigin = new Map<string, string>()
      for (const row of rows) {
        const copy = await readDocCopy(deps, 'component', row.id)
        try {
          const o = readMasterOrigin(copy)
          if (o !== undefined && o.pack === pack.id) byOrigin.set(o.key, row.id)
        } finally {
          copy.destroy()
        }
      }
      const componentCounts = { created: 0, updated: 0 }
      for (const c of tokenResult.plan.components) {
        // Linked text takes its compiled style's fields, as text.style.apply writes them.
        const objects = c.objects.map((o): SlideObject => {
          if (o.type !== 'text' || o.textStyleId === undefined) return o
          const style = tokenResult.tokens.textStyles[o.textStyleId]
          if (style === undefined) return o
          return { ...o, ...linkedTextFields(style, tokenResult.tokens) } as TextObject
        })
        let componentId = byOrigin.get(c.origin.key)
        if (componentId === undefined) {
          const created = await createEmptyComponent(deps, {
            userId: args.userId,
            folderId: args.folderId,
            name: c.name,
          })
          componentId = created.id
          componentCounts.created++
        } else {
          componentCounts.updated++
        }
        await writeLiveDoc(deps, 'component', componentId, (doc: Y.Doc) =>
          replaceMasterObjects(doc, objects, c.origin),
        )
      }

      // 3. Text linked to the styles in the folder's decks and masters.
      void queuePropagation(deps, args.folderId, tokenResult.changedStyles).catch((err: unknown) =>
        deps.log.warn({ err, folderId: args.folderId }, 'style pack compile: propagation failed'),
      )

      return {
        ...tokenResult.counts,
        components: componentCounts,
        missingFonts: tokenResult.plan.missingFonts,
      }
    },
  }
}
