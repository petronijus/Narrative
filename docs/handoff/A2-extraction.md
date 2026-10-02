# Handoff A2 — extraction: the editor writes only through commands

**Status:** done. A2 closed with A2.13 on 2026-09-30. A2.1–A2.12a are
released (0.10.2–0.10.14). A2.12b is committed (`beaf182`), and A2.13 is
uncommitted on top of it; both are to ship together as **0.10.15**.
**Date:** 2026-09-30
**Last commit:** `beaf182` (A2.12b). A2.13 is in the working tree, not
committed.

Plan: [`docs/plans/agentic-layer.md`](../plans/agentic-layer.md) §10, row
**A2 Extraction**. The step log with every decision is
[`docs/plans/a2-extraction.md`](../plans/a2-extraction.md) "Progress", and
this note summarises it. Decision records:
[ADR 0010](../adr/0010-command-layer-is-the-only-writer.md) (status updated
at A2 close) and [ADR 0012](../adr/0012-component-owned-media.md)
(A2.12b). Previous handoff:
[`A1-mcp-and-server-host.md`](./A1-mcp-and-server-host.md).

After A2, "state = Yjs, written only through commands" holds in the editor
too. Every document write in `apps/web/src` goes through `useCommand()` or,
for the dev-only e2e hook, the command registry directly. The logic that
decides what to write lives in `packages/commands`, where agents reach it
over MCP.

## What was completed

### The steps

| Step   | Subject                                                          | New commands                                                                                                       | Released                         |
| ------ | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | -------------------------------- |
| A2.1   | One-door lint rule over all of `apps/web/src`, 26 files exempted | —                                                                                                                  | 0.10.2 (`5d490ae`)               |
| A2.2   | Slides panel, notes, slide copy, deck copy                       | `slide.copyTo`, `slide.notes.get`, `slide.notes.set`, `deck.duplicate`                                             | 0.10.2 (`5d490ae`)               |
| A2.3   | Guides                                                           | —                                                                                                                  | 0.10.5 (`3f757c0`)               |
| A2.4   | Object creation and arrangement                                  | — (creation defaults moved into `object.create`)                                                                   | 0.10.6 (`bafe31e`)               |
| A2.5   | Transforms                                                       | `object.resize`, `.rotate`, `.flip`, `.alignToSlide`, `.crop.set`                                                  | 0.10.7 (`4db7618`)               |
| A2.6   | Paths and lines                                                  | `object.path.create`, `.path.fromShape`, `.path.setAnchors`, `object.line.setEndpoints`                            | 0.10.8 (`a2381f8`)               |
| A2.7   | Clipboard                                                        | `object.copyTo`, `object.insert`, `object.insertFromDeck`                                                          | 0.10.9 (`3816515`)               |
| A2.7a  | Agent file upload (added at Petr's request)                      | `media.uploadSession`                                                                                              | 0.10.10 (`a0d6d2c`)              |
| A2.8   | Fill, effects, page number                                       | `object.fill.gradient`, `object.effects.shadow`, `object.slideNumber.set`                                          | 0.10.11 (`669d151`)              |
| A2.9   | Animation                                                        | `animation.retime`, `animation.retarget`                                                                           | 0.10.12 (`c305738`)              |
| A2.10  | Tables                                                           | `table.setSize`                                                                                                    | 0.10.12 (`925c08c`)              |
| A2.11  | Text                                                             | `text.edit`, `text.replace`, `text.setBoxTypography`, `text.style.apply`                                           | 0.10.13 (`b982d95`)              |
| A2.12a | Folder tokens and propagation on the server                      | `token.create`, `.update`, `.delete`, `.seedDefaults`, `.list`, `text.style.createFromObject`, `.updateFromObject` | 0.10.14 (`61260f2`)              |
| A2.12b | Components, component-owned media                                | `component.promote`                                                                                                | to ship as 0.10.15 (`beaf182`)   |
| A2.13  | Close: action catalog, empty exemption list, `FINISHED_PHASES`   | — (`object.create` gained an optional `id`)                                                                        | to ship as 0.10.15 (uncommitted) |

35 new commands in all (94 → 129).

### A2.13 (the close)

- **The action catalog**, `apps/web/src/actions/catalog.ts`. This is plan
  §9.1 guard 2's shortcut and menu part, the last guard that was missing.
  It lists every action a person reaches through a keyboard shortcut, a
  context or dropdown menu item, or a toolbar button. Each action is one
  of:
  - `commands`: the commands that carry its effect, which an agent uses to
    do the same;
  - `editorOnly`: with a reason (viewport, selection, the local clipboard,
    the editor's own undo, navigation);
  - `planned`: shown but not built. The only one is object Hide, which is
    disabled in the menu.

  In all, 82 actions: 53 `commands`, 28 `editorOnly`, 1 `planned`.

- **Enforcement:**
  - `ShortcutBinding.action` is required (`state/useShortcuts.ts`);
  - the menu item wrappers in `components/ui/{context-menu,dropdown-menu}.tsx`
    require an `action` prop and render `data-action`;
  - `actions/catalog.test.ts` checks that every named command exists, that
    every reason is at least 20 characters, that no action is unused, and
    that every `<Button>` / `<button>` in `ui/Toolbar.tsx` carries a catalog
    `data-action` (TypeScript AST scan).
- **The guard found an untracked action right away**: renaming the deck by
  clicking its title in the toolbar, now `deck.rename`.
- **`ONE_DOOR_PENDING` is empty.** `state/testApi.ts` writes through
  `runCommandSync` / `runGroup` on a browser-host context (`LOCAL_ORIGIN`,
  owner actor `e2e-test-api`).
  - `object.create` takes an optional `id` (`^[A-Za-z0-9_-]{1,64}$`,
    `conflict` if the slide has it). Slide-model `createObjectOfType` and
    `buildTable` / `addTable` take one too.
  - The retired `onEnter` animation trigger, which no command creates, is
    seeded by `state/testApiLegacyFixtures.ts`. That is the one non-test
    file in `ONE_DOOR_IGNORES`.
  - `addImage` takes a real `assetId`. Specs upload one with
    `e2e/fixtures/media.ts` (`uploadTestPicture`).
- **`FINISHED_PHASES = ['A0', 'A1', 'A2']`.**
- **E2E self-seeding:**
  - `htmltext-texture-isolation` creates its own deck. It used to open the
    hard-coded `nO5v10urLTBI`.
  - The `agent-activity` master test adapts to the master slide the server
    writes (its setup run adds a label, not a slide).

### The guards at A2 close

| Guard                       | Where                                                                                        | Checks                                                                                                           |
| --------------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| One door (lint)             | `apps/web/eslint.one-door.js`, `eslint.config.js`; `apps/web/src/oneDoor.test.ts`            | No slide-model writer import or `.transact()` in `apps/web/src`; `ONE_DOOR_PENDING` empty, and only ever shrinks |
| Slide-model writers         | `packages/commands/src/parity/parity.test.ts`, `slideModelExports.ts`                        | Every export classified; every `writer` used by a command handler                                                |
| Routes                      | `apps/server/src/routes/agentParity.test.ts`                                                 | Every Fastify route claimed by a command, a known-missing entry or the allowlist                                 |
| User actions (new in A2.13) | `apps/web/src/actions/catalog.ts` + `catalog.test.ts`                                        | Every shortcut, Radix menu item and toolbar button names a catalog action; every named command exists            |
| Known-missing hygiene       | `packages/commands/src/parity/knownMissing.ts`                                               | No entry for a phase in `FINISHED_PHASES`                                                                        |
| Contract, schema, manifest  | `packages/commands/src/contract.test.ts`, `packages/shared/src/schema/`, `capabilities.json` | Every example runs; schema coverage typechecks; the manifest is current                                          |
| tools/list size             | `apps/server/src/mcp/toolListBudget.test.ts`                                                 | ≤ 189,000 bytes in every confirmation mode; ≤ 16,000 per tool                                                    |

### Numbers

| Measure                             | A2 start (0.10.1, 2026-09-28) | A2 close (2026-09-30)                                       |
| ----------------------------------- | ----------------------------- | ----------------------------------------------------------- |
| Commands                            | 94                            | 129 (74 browser + server, 55 server-only, manifest `hosts`) |
| Known-missing                       | 39 (A2 32, A3 5, A4 2)        | 7 (A3 5, A4 2)                                              |
| Allowlist                           | 18                            | 20                                                          |
| Files exempt from the one-door rule | 26 (at A2.1)                  | 0                                                           |
| Catalogued user actions             | —                             | 82                                                          |
| tools/list budget / measured (url)  | 132,000 / ≈ 129,309 bytes     | 189,000 / 188,697 bytes (measured 2026-09-30)               |
| Eval scenarios                      | 14                            | 44 (per the A2.12b entry; not recounted at A2.13)           |

## Key decisions

Cross-cutting decisions made during A2. Each step's own decisions are in
`a2-extraction.md` "Progress".

- **One lint rule over all of `apps/web/src` from the first step**, with a
  shrinking exemption list, instead of the plan's per-directory switch-on.
  Otherwise `ui/`, which is most of the editor, would have gone
  unguarded until the last step (plan "Mechanisms").
- **Continuous gestures send absolute, idempotent frames**, with one
  command per pointer move. The undo manager's capture window still merges
  them into one step (A2.5, A2.6, A2.9, A2.10) — since 2026-10-02 the
  gesture's pointer boundaries do (`state/undoGestures.ts`).
- **Cross-document writes run on the server**: slide paste across decks
  (A2.2), object paste across decks (A2.7), stamp and every master ↔ deck
  paste (A2.12b). Media is deck- or component-scoped, so the server
  copies it. The consequence is that these arrive as remote changes and
  Mod+Z does not undo them.
- **Speaker notes keep their y-prosemirror binding** (allowlisted). Agents
  use `slide.notes.get` / `.set` (A2.2).
- **No `table.cell.setText`.** The text commands take `target.cell` (A2.10).
- **Typing is `text.edit` in display offsets**, one command per input event
  (A2.11).
- **Token commands take the category as input** rather than nine
  per-category commands. This keeps the tools/list cost about a third of
  the alternative (A2.12a).
- **Token propagation and seeding are the server's.** Document changes the
  server makes on its own go through data migrations
  (`services/dataMigrations.ts`), never SQL (A2.12a).
- **A component owns its media** (ADR 0012, A2.12b).
- **The tools/list budget only rose during A2** (Petr's call). It went up
  12 times, each raise itemised in `toolListBudget.test.ts`, and is
  reviewed as a whole after A2.
- **The action catalog lives in the web app, typed at the binding sites.**
  It is not in `parity.test.ts`, because `packages/commands` does not
  depend on the editor. The types force an action on every shortcut and
  menu item, and a test covers the toolbar's buttons (A2.13).

## How to verify

- `just check`: green is the baseline. It includes `actions/catalog.test.ts`,
  `oneDoor.test.ts`, the parity and contract suites and the tools/list
  budget.
- `just test web`: `actions/catalog.test.ts` has 4 tests
  (3 catalog, 1 toolbar). With `oneDoor.test.ts`, 7 passed in the docs
  sweep on 2026-09-30.
- `just test commands`: `objectEdit.test.ts` includes "takes a caller-chosen
  id, for every kind of object, and refuses one the slide has".
- `just e2e`: the full suite. A2.13 changed `agent-activity`,
  `htmltext-texture-isolation`, `inspector-flows` and `keyboard-shortcuts`.
  A full run was in progress during the docs sweep, and its result is not
  recorded here.
- `grep -c "file:" apps/web/eslint.one-door.js` should print 0 (no pending
  entry).
- `curl -s https://narrative.bastla.com/version.json`: `v0.10.14+61260f2`
  on 2026-09-30. After the release it should report `v0.10.15+<hash>`.

## Next step

> Release 0.10.15 (A2.12b + A2.13): run `just check`, the rows of
> AGENTS.md "When to run what" that match, and the A2.12b pre-deploy check
> in `docs/deploy.md` ("Releasing A2.12b"). Then `just bump 0.10.15`, turn
> the CHANGELOG "Unreleased" heading into the 0.10.15 section, commit,
> verify the subject, tag, push, and `just deploy v0.10.15`, all only
> when Petr says so. Then start the holistic tools/list size review. Read
> `apps/server/src/mcp/toolListBudget.test.ts` (12 itemised raises,
> 132,000 → 189,000), measure per tool (`object_create` is the largest,
> at 12,003 bytes), and propose what moves into `mcp/vocabulary.ts`, the
> server instructions or the `basics` playbook. Also say which examples
> are dropped, and what the new budget is. After the review comes the MCP
> work (`docs/plans/a2-extraction.md` "Where we stand").

## Known TODO / deferred

- **The action catalog does not see everything** (not triaged; hand-rolled
  `role="menuitem"` menus ARE covered since the sweep found them):
  - key handlers outside `useShortcuts` (48 `onKeyDown` /
    `addEventListener('keydown')` sites in `apps/web/src`);
  - Inspector controls and canvas gestures.

  Their document writes are still held by the one-door rule and their
  routes by the route guard. What is missing is the editor-only reasoning
  and a catalog entry for them.

- **Object Hide** is `planned`: the menu item is disabled, and no command or
  model field exists (P12).
- **Folder sharing and linked component media**: decided 2026-09-30, to be
  done after the MCP work. It supersedes A2.12b's open questions, a
  per-owner storage quota and a confirmation for stamping into a shared
  deck (`a2-extraction.md` "Where we stand").
- Folder token writes by an agent are not reverted with its run (security
  review A2.12a, LOW-5). There is no run-level undo for folder documents
  yet.
- Present mode ignores `videoTrigger` / `videoDelay` (A2.9). The timeline
  draws an `onClick` step after an overlapping `withPrevious` earlier than
  it plays (pre-existing).
- `text.style.apply` got its eval scenarios with A2.12a. The inline font
  picker stores only a stack's primary family, while `text.format` /
  `text.set` store it as given (A2.11, pre-existing).
- Carried over from before A2, still red: the Tiptap chunk is 12.6 kB over
  budget (`just size`), there are 5 real-deck PPTX round-trip differences,
  `just mutate` is broken (Stryker vs vitest 4), and "three clients
  converge" in `multi-client-collab` is flaky (AGENTS.md "When to run
  what").
- `state/testApi.ts` has a misplaced doc comment. "Run one document command
  on the live deck: one transaction, one undo step." sits directly above
  `hexColour`'s comment instead of above `run()`. Found by the docs sweep
  and left for the next code change, since the sweep does not edit source.

## Links

- Plan and step log: [`docs/plans/a2-extraction.md`](../plans/a2-extraction.md);
  phase plan [`docs/plans/agentic-layer.md`](../plans/agentic-layer.md) §9, §10,
  Appendix B.
- ADRs: [0010](../adr/0010-command-layer-is-the-only-writer.md),
  [0011](../adr/0011-agent-execution-over-mcp.md),
  [0012](../adr/0012-component-owned-media.md).
- Key files: `apps/web/src/actions/catalog.ts`,
  `apps/web/src/actions/catalog.test.ts`, `apps/web/eslint.one-door.js`,
  `apps/web/src/state/useCommand.ts`, `apps/web/src/state/testApi.ts`,
  `apps/web/src/state/testApiLegacyFixtures.ts`,
  `packages/commands/src/parity/{parity.test.ts,knownMissing.ts,allowlist.ts,slideModelExports.ts}`,
  `apps/server/src/mcp/toolListBudget.test.ts`.
- Commits: `5d490ae` (A2.1–A2.2), `3f757c0`, `bafe31e`, `4db7618`,
  `a2381f8`, `3816515`, `a0d6d2c`, `669d151`, `c305738`, `925c08c`,
  `b982d95`, `61260f2`, `beaf182`; A2.13 not yet committed.
- Reference: [`docs/mcp.md`](../mcp.md), [`docs/capabilities.md`](../capabilities.md)
  (generated), [`tests/agent-eval/README.md`](../../tests/agent-eval/README.md).
