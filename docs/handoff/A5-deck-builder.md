# Handoff A5 — deck builder: a whole deck from a brief, any deck into the brand

**Status:** built and verified on 2026-10-14, released in 0.12.0 the same
day (Petr's call: the whole of A5 first, one release).
**Date:** 2026-10-14

Plan: [`docs/plans/a5-deck-builder.md`](../plans/a5-deck-builder.md)
(decisions D1–D7, the deck spec, the step log and the final state in
"Where we stand") and [`agentic-layer.md`](../plans/agentic-layer.md) §8 /
§10 row **A5**, the plan's last phase. Previous handoff:
[`A4-style-packs.md`](./A4-style-packs.md).

After A5 an agent builds a whole deck in one step from a deck spec it
agreed with the user, restyles slides from another brand's deck into this
one, and exports a deck as a PDF; a person exports PDFs from the editor.

## What was completed

| Step | Subject                                                                                                                      | Commands / surface                                          |
| ---- | ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| A5.0 | tools/list 199.9 → 193.2 kB without changing a command id (nullable fields, string unions, shared shapes through `$ref`s, …) | —                                                           |
| A5.1 | deck meta in undo and revert; archetypes on slides; content moves by role, in reading order, kept when it has no place       | `slide.applyLayout` `archetype`, `unplaced`; image `focus`  |
| A5.1 | the rhythm rule; a picture's focus (renderer, PPTX)                                                                          | `query.check` `rhythm`                                      |
| A5.2 | the deck spec, `planBuild`, the rich example pack (eight layouts)                                                            | —                                                           |
| A5.3 | the build: one transaction, slides reused / added / removed, notes, briefs, the spec kept on the deck                        | `style.deck.apply { spec, replace }`, `query.deck { spec }` |
| A5.4 | restyle into this pack by archetype; tokens by purpose (`origin.key`); insert across folders records archetypes              | `style.deck.apply { relayout, slides }`                     |
| A5.5 | PowerPoint placeholder hints in import results; the `insert-restyle` playbook                                                | `deck.importPptx` / `deck.insertFrom` `placeholders`        |
| A5.6 | the PDF: shared writer, render service, route, the editor's Export menu (PDF built in the browser)                           | `deck.exportPdf`, GET `/decks/:id/export.pdf`               |
| A5.7 | the `build-deck` playbook (scope, voice, three directions, the table, approval, spec, build, check, look, report)            | —                                                           |
| A5.8 | nine eval scenarios; `FINISHED_PHASES` with A5                                                                               | —                                                           |

## Pitfalls found on the way

- **An `imageRect` cannot hold a focus.** object.crop.set works in frame
  px and never knows a picture's own size; a crop kept to one side needs
  it. `focus` became an image property the renderer's fit and the PPTX
  export (srcRect, extension) both read.
- **Deleting what a new layout has no place for loses text.** Like
  PowerPoint, the earlier layout's objects with content stay and are
  listed (`unplaced`); only empty boxes, placeholders and a component part
  still showing its master's text go. But content given for a slot does
  replace the earlier object of its role (else two bodies).
- **Compiled tokens share names across packs** ("Text", "Accent"): moving
  between folders paired them by accident. tokenRebind matches by
  `origin.key` first; a literal is resolved on the deck's variant and the
  slide's surface, as drawn. The walk is slide-model `rewriteTokenRefs`,
  shared with the restyle.
- **A `load` phase makes a command non-batchable and asynchronous.**
  `style.deck.apply` lost `ops.apply` and `runCommandSync` (no editor
  caller); the harness has `runAsync` / `failAsync`.
- **Cheap refusals before expensive work.** The security review found the
  spec's pictures looked up before its size or validity was checked, a
  build holding the event loop for about a second, and a 40-slide PDF
  outliving the caller's 100 s; each is bounded now (see the plan's log).
- **Eval scenarios where the agent looks are live-only.** The memory world
  has no renderer: a transcript with `query.render` or a measured
  `query.check` does not replay. Only `deck-build-voice-unknown` of the new
  ones is recorded.
- **An agent restyling inserted slides needs the path in the tool
  descriptions,** not only in a playbook it may never read:
  `deck.insertFrom` now names relayout, then `slide.applyLayout` for what
  stays unmatched.

- **A rebuild must know which slide is which.** Matching a deck slide to
  a spec slide by position put an inserted slide on top of the displaced
  one's notes and text. Each built slide records the digest of its spec
  slide (`Slide.specKey`, with the pack and language): an unchanged spec
  slide keeps its slide (edits included), a changed one is built fresh,
  and an earlier build's leftovers go; slides made by hand still need
  `replace`.

## Open

- **Release** (0.12.0 suggested: a phase with new commands) on Petr's word,
  then `just deploy`.
- tools/list is at 199.9 of its 200 kB budget again: the table and path
  tool merges D4 deferred are the next room.
- `style.deck.apply` is not batchable since its `load`; if an agent needs
  a variant switch inside `ops.apply`, split the build into its own
  command.
- The agent path of renders has no per-command budget beyond the queue's
  in-flight caps (pre-existing for PNG, noted by the A5.6 review).
- Brand pack imports to production folders and the MacBook font and logo
  uploads, from A4 (`HANDOVER.md`), still wait for Petr's go.
