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
 * A3.5a (2026-10-11): no raise for deck.refreshThumbnail ≈ 0.7 KB (the deck's
 * card): 184,396 bytes in url mode, 138 tools — 104 bytes left, so
 * component.refreshThumbnail (A3.5b) needs a raise.
 * A3.5b–A3.7 (2026-10-11): 184,500 → 185,500. A master's card went onto
 * deck.refreshThumbnail (`componentId`, no tool of its own: +0.1 KB, where a
 * component.refreshThumbnail tool would have taken ≈ 0.7 KB), query.render
 * gained `compare` and `overflow` (≈ +0.2 KB): 184,714 bytes in url mode,
 * 138 tools.
 * A4.1 (2026-10-12): 185,500 → 188,000 for component.restamp ≈ 1.3 KB (it
 * says it resets stamps and overwrites local edits, and to ask before a
 * whole deck), component.create ≈ 0.6 and the object properties `slot`,
 * `role` and `component`, which reach object.create and object.path.create
 * through their create schemas (≈ 0.45 KB each) and object.update's
 * description and example (≈ 0.2): 187,928 bytes in url mode, 140 tools
 * (descriptions trimmed once before measuring) — 72 bytes left.
 * A4.2a (2026-10-12): 188,000 → 189,000 for text autofit: `autofit` and
 * `minFontSize` in the text create schema (object.create, object.path.create
 * ≈ 0.1 KB each), a sentence and an example in object.update, minFontSize in
 * text.setBoxTypography and `minSize` in the token tools: 188,673 bytes in
 * url mode, 188,805 in link mode, 140 tools (descriptions trimmed once
 * before measuring).
 * A4.2b (2026-10-12): 189,000 → 192,500 for list levels: `listLevels` in the
 * text create schema (object.create ≈ 0.8 KB) and a text style's `levels`
 * in token.create and token.update (≈ 1.1 KB each; level descriptions
 * trimmed, listLevels kept out of text.setBoxTypography — object.update
 * sets it): 191,971 bytes in url mode, 140 tools.
 * A4.2c–A4.4 (2026-10-12): 192,500 → 198,500 for the style pack tools —
 * style.pack.get ≈ 0.9 KB, style.pack.edit ≈ 1.6 KB, slide.applyLayout ≈ 1.5 KB
 * (its slot content takes the text body, now a shared shape: −1.2 KB on
 * each of three tools), style.deck.apply ≈ 1.3 KB — and colour tokens' alpha,
 * byVariant and bySurface plus fontStretch, lineSpacing and align on text
 * styles in token.create / token.update (≈ 0.9 KB): 198,073 bytes in url mode,
 * 144 tools.
 * A4.5 (2026-10-12): 198,500 → 200,000 for query.check ≈ 1.4 KB (the
 * brand checker; its rules are listed once, in its description):
 * 199,492 bytes in url mode, 145 tools.
 * A5.0 (2026-10-14), the review before A5 adds tools, no command id
 * changed: 200,000 → 194,200. Measured in link mode, now the largest:
 * 199,977 → 193,154 bytes, 145 tools. Nullable fields as one schema with a
 * null type (−1.0 KB, schemaCompact.ts pass 5) and string-constant unions
 * as one enum (−0.2, pass 6); the shared descriptions stripped before
 * compacting too, so definitions they made large inline (−0.3); the file
 * input and a text `range` as shared shapes, and shapes matched through
 * `$ref`s (object_create's text body; −2.8); the animation presets, triggers
 * and rotation units said by the schema rather than both descriptions
 * (−1.1); the confirmation line shorter per mode (−0.4 in url mode); example
 * calls that show nothing the schema does not left out (−0.5); token_create's
 * prose no longer repeating its fields (−0.2). From here it rises per A5
 * tool change, itemised as before.
 * A5.1 (2026-10-14): no raise. slide.applyLayout's `archetype`, `unplaced`,
 * a picture's `focus` and an example by archetype, query.check's rhythm
 * rule and its cap only when measuring, the image `focus` in the create
 * schema and `archetype` in the query outputs: 193,802 bytes in link mode,
 * 145 tools (398 left).
 * A5.3 (2026-10-14): 194,200 → 199,000 for the build. style.deck.apply's
 * `spec` and `replace` ≈ 4.0 KB (the deck spec's schema: slides by layout or
 * archetype, slot content, what is drawn on the grid, notes, message,
 * claims; its output per built slide) and an example; query.deck's `spec`
 * and `specSlides` ≈ 0.3; query.slide's `brief` ≈ 0.2: 198,265 bytes in
 * link mode, 145 tools.
 * A5.3 review, A5.4, A5.5 (2026-10-14): no raise. style.deck.apply's
 * `relayout`, `slides`, `restyled`, `spec: null` and removed slides' titles,
 * query.deck's `specInvalid`, the import results' `placeholders`
 * (deck.importPptx, deck.insertFrom), with descriptions trimmed: 198,948
 * bytes in link mode, 145 tools (52 left).
 * A5.6 (2026-10-14): 199,000 → 200,000 for deck.exportPdf ≈ 1.0 KB
 * (description trimmed once before measuring): 199,927 bytes in link mode,
 * 146 tools. Back at the budget A5.0 started from: A5 spent the room it
 * made. The next room is the table and path tool merges D4 put after A5.
 * R1 async PDF (2026-10-19): no raise. deck.exportPdf became a job (its
 * `jobId` input waits for one already running, instead of a second tool);
 * its description trimmed to fit: link mode back under 200,000.
 * R1 review (2026-10-19): no raise. deck.exportPdf refuses `jobId` with
 * anything beside it (its defaults said in the descriptions instead of
 * schema defaults, so a given value can be told from an omitted one) and
 * names `queued`; delivery's default left to the description: under
 * 200,000 in link mode.
 */
export const TOOL_LIST_BUDGET_BYTES = 200_000
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
