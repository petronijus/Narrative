/**
 * The tool list is loaded into the model's context at the start of every MCP
 * session and re-read on every turn, so its size is a cost paid by every
 * user on every request. It was ≈ 235 KB (≈ 60k tokens) before the
 * compaction in tools.ts / schemaCompact.ts brought it to ≈ 150 KB, and
 * ≈ 129 KB after the shared field vocabulary (vocabulary.ts), examples only
 * where they add something, and the confirmation procedure said once in the
 * instructions (2026-09-28); this test keeps it from creeping back
 * unnoticed. (Claude Code with its default tools defers MCP tools behind
 * ToolSearch, so there the size barely matters; clients that load the
 * whole list — the agent eval, possibly claude.ai — pay all of it. See
 * tests/agent-eval/probes/listChanged.ts.)
 *
 * When it fails: a new command legitimately adds 1–2 KB. Look at what grew
 * (the failure lists the largest tools) before raising the budget — a long
 * repeated sentence belongs in the server instructions or the `basics`
 * playbook, not on every tool.
 */

import { describe, expect, it } from 'vitest'
import { createDefaultRegistry } from '@narrative/commands'
import { ToolCatalog, type ConfirmationMode } from './tools.js'

/**
 * Bytes of `JSON.stringify({ tools })`, for every confirmation variant (url
 * mode is the largest). Raised from 132,000 in A2.2 (2026-09-28) for four new
 * capabilities — slide.copyTo, slide.notes.get / .set, deck.duplicate — at
 * 1.0–1.3 KB each; A2 adds ~25 more commands that move editor-only logic
 * onto the agent surface, so expect it to grow step by step with them.
 * A2.5 (2026-09-28): 136,000 → 142,000 for the five transforms —
 * object.resize 1.7 KB, .rotate 1.0, .flip 1.1, .alignToSlide 1.3 and
 * .crop.set 2.4 (its five crop operations are a discriminated union), less
 * ~0.4 KB object.update lost by pointing at them instead of explaining the
 * workarounds.
 * A2.6 (2026-09-28): 142,000 → 150,000 for object.path.create 4.1 KB (its
 * `object` field carries the path's create schema: fill styles, shadow,
 * hyperlink), .path.setAnchors 1.9, .line.setEndpoints 1.2 and
 * .path.fromShape 1.1, then 152,000 once setAnchors took `moves` (edit
 * anchors by index) and the anchor schema said when a segment curves. Per
 * Petr's call the budget only rises during A2; the sizes get one
 * comprehensive review once A2 is done.
 * A2.7 (2026-09-28): 152,000 → 157,000 for object.copyTo 1.7 KB,
 * object.insert 2.3 and object.insertFromDeck 2.2 (the clipboard's three
 * paste paths; their example objects are what makes them this size).
 * A2.7a (2026-09-28): 157,000 → 159,000 for media.uploadSession.
 * A2.8 (2026-09-29): 159,000 → 164,000 for object.fill.gradient,
 * object.effects.shadow and object.slideNumber.set (≈ 4.7 KB together).
 * A2.9 (2026-09-29): 164,000 → 167,000 for animation.retime 1.8 KB and
 * animation.retarget 1.2 KB.
 * A2.10 (2026-09-29): 167,000 → 169,000 for table.setSize, table.style.table
 * `overrideCells` and object.fill.gradient `cells` (≈ 1.9 KB together).
 * A2.11 (2026-09-30): 169,000 → 177,000 for text.setBoxTypography 2.6 KB,
 * text.edit 2.4, text.style.apply 1.3 and text.replace 1.3 (object.update
 * lost its now-obsolete workaround notes).
 * A2.12a (2026-09-30): 177,000 → 187,000 for token.update 2.8 KB, token.create
 * 2.3, text.style.createFromObject 1.1, text.style.updateFromObject 1.1,
 * token.delete 1.0, token.seedDefaults 0.9 and token.list 0.6 (186,157
 * bytes measured in url mode, 128 tools).
 * A2.12b (2026-09-30): 187,000 → 189,000 for component.promote 1.4 KB,
 * object.insertFromDeck's `fromComponent` and the media commands on a
 * component master (188,407 bytes measured in url mode, 129 tools).
 * After A2 (2026-09-30), the holistic review: 189,000 → 175,000. The shapes
 * that recur on many tools (the slide reference on 72, colours, the table
 * cell, object id lists) are written compactly and explained once in the
 * instructions (sharedShapes.ts), the way vocabulary.ts already did for
 * field descriptions: 188,697 → 173,650 bytes in url mode, 129 tools, the
 * descriptions and example calls untouched (the full eval stayed 44/44).
 * Folder sharing step 3 (2026-10-04): 175,000 → 181,000 for the six
 * folder.members.* / folder.invites.* tools — invite 1.4 KB, setRole 1.0,
 * remove 0.7, cancel 0.7, list 0.6, invites.list 0.5 (descriptions trimmed
 * once before measuring): 179,645 bytes in url mode, 135 tools.
 * A3.3 (2026-10-10): 181,000 → 182,500 for deck.exportPng ≈ 1.0 KB, the first
 * render-worker tool (description trimmed once before measuring): 181,807
 * bytes in url mode, 136 tools.
 * A3.4 (2026-10-11): 182,500 → 184,500 for query.render ≈ 1.6 KB (the agent
 * looks at slides) and `failedFonts` on deck.exportPng: 183,680 bytes in url
 * mode, 137 tools.
 */
export const TOOL_LIST_BUDGET_BYTES = 184_500
/** No single tool may carry more than this (object_create, the largest, is ≈ 14 KB). */
export const TOOL_BUDGET_BYTES = 16_000

const catalog = new ToolCatalog(createDefaultRegistry())
const MODES: ConfirmationMode[] = ['form', 'url', 'link']

describe('tools/list size budget', () => {
  it.each(MODES)('stays within %s-mode budget', (mode) => {
    const tools = catalog.list(mode)
    const bytes = Buffer.byteLength(JSON.stringify({ tools }))
    const largest = tools
      .map((t) => `${t.name} ${JSON.stringify(t).length}`)
      .sort((a, b) => Number(b.split(' ')[1]) - Number(a.split(' ')[1]))
      .slice(0, 5)
    expect(
      bytes,
      `tools/list is ${bytes} bytes; largest: ${largest.join(', ')}`,
    ).toBeLessThanOrEqual(TOOL_LIST_BUDGET_BYTES)
  })

  it('keeps every single tool within its budget', () => {
    for (const tool of catalog.list('link'))
      expect(JSON.stringify(tool).length, tool.name).toBeLessThanOrEqual(TOOL_BUDGET_BYTES)
  })

  it('keeps every schema self-contained ($refs only to its own $defs)', () => {
    for (const tool of catalog.list('link')) {
      const json = JSON.stringify(tool.inputSchema)
      const defs = Object.keys(
        ((tool.inputSchema as Record<string, unknown>)['$defs'] ?? {}) as object,
      )
      for (const [, name] of json.matchAll(/"\$ref":"#\/\$defs\/([^"]+)"/g))
        expect(defs, `${tool.name} → ${name}`).toContain(decodeURIComponent(name!))
    }
  })
})
