# Handoff A4 — style packs: a folder's brand, laid out and checked

**Status:** done. A4.2b–A4.8, the blocker and the review fixes shipped as
**0.11.0** on 2026-10-13 (the verification is in the plan's "Where we
stand"); A4.1 in 0.10.31, A4.2a in 0.10.32.
**Date:** 2026-10-13

Plan: [`docs/plans/a4-style-packs.md`](../plans/a4-style-packs.md)
(decisions, the pack schema, the step log and final state in "Where we
stand") and [`agentic-layer.md`](../plans/agentic-layer.md) §7 / §10 row
**A4**. Previous handoff: [`A3-render-worker.md`](./A3-render-worker.md).

After A4 a folder can hold its client's brand as a style pack. Agents and
people build slides from its layouts, switch a deck between its variants,
and check slides against its rules.

## What was completed

| Step  | Subject                                                                                    | Commands                                            | Released |
| ----- | ------------------------------------------------------------------------------------------ | --------------------------------------------------- | -------- |
| A4.0  | tool-count measurement; Petr chose fewer tools (seven for the phase)                       | —                                                   | —        |
| A4.1  | `slot`, `role`, `component` on objects; stamp provenance; restamp                          | `component.create`, `component.restamp`             | 0.10.31  |
| A4.2a | text autofit: grow with the text, shrink to fit, shrink floor                              | `object.update` `autofit`, `minFontSize`, `minSize` | 0.10.32  |
| A4.2b | list levels on boxes and styles                                                            | `text.list`, `listLevels`, style `levels`           | 0.11.0   |
| A4.2c | variable font axes, `fontStretch`                                                          | `text.setBoxTypography` `fontStretch`               | 0.11.0   |
| A4.2d | deck meta (variant, fields, lang), slide layout, colour tokens per variant and surface     | `token.*` `byVariant` / `bySurface`                 | 0.11.0   |
| A4.2e | `lineSpacing` and `align` on text styles                                                   | `token.*`                                           | 0.11.0   |
| A4.3  | the pack: schema, validation, folder storage, MCP resource                                 | `style.pack.get`, `style.pack.edit`                 | 0.11.0   |
| A4.4  | compile to tokens and masters; layouts                                                     | `slide.applyLayout`, `style.deck.apply`             | 0.11.0   |
| A4.5  | the brand check, measured on the render page                                               | `query.check`                                       | 0.11.0   |
| A4.6  | Folder Settings → Style pack                                                               | (through `style.pack.edit`)                         | 0.11.0   |
| A4.7  | master reader, five brand bootstraps (Contoso, Fabrikam, Tailspin, Woodgrove, Adatum)                        | `just style-pack`, `just style-pack-import`         | 0.11.0   |
| A4.8  | `build-with-pack` playbook, `restyle-lite` for packs, eval scenarios, `FINISHED_PHASES A4` | —                                                   | 0.11.0   |

## Pitfalls found closing it

- **HTMLText reloads its faces on every measurement.** Measuring or
  rasterising text in an embedded face puts that family's `@font-face`
  rules into the document again, and the new `FontFace` objects fire
  `document.fonts` `loadingdone`. Anything that reacts to that event by
  measuring text again loops. `createFontLoadFilter`
  (`renderer/fontChanges.ts`) lets only faces with new descriptors through.
  The loop made every slide with an autofit box in Inter or a folder font
  unrenderable on the render page.
- **A compile owns its tokens whole.** `updateFolderToken(…, { replace:
true })`: a field the pack stopped setting must leave the token, and
  text linked to the style drops it too (`textStyleFields`).
- **The stored pack is a Yjs document.** Every write validates the pack,
  but any folder editor's client can write it directly. It is validated
  where it is used (`storedStylePack`), while `style.pack.get` and Folder
  Settings still read an invalid one so it can be fixed.
- **Eval replay.** Listed records (a folder's colours) come back in
  document order, which differs between the live server and the memory
  world. Replay pairs them by name, type and value. Recording needs
  `replay: true` before `--record`.

## Open

- Production imports of the brand packs, brand by brand at Petr's go, and
  the MacBook font and logo uploads (`HANDOVER.md`).
- `pack-build-slide` and `pack-fix-check` are live-only: the agent
  measures text with `query.check`, and the memory world has no renderer.
- The MCP `tools/list` is at about 199.9 of its 200 kB budget. A holistic
  size review is due before A5 adds tools.
- A5: deck builder and restyle (`agentic-layer.md` §10), including
  `deck.exportPdf`.
