# ADR 0010 — The command layer is the only writer of document state

**Status**: Accepted (2026-09-26). Skeleton landed in phase A0 (2026-09-26);
**implemented in the editor with A2, closed 2026-09-30 (A2.13)**: the editor
writes documents only through commands (`ONE_DOOR_PENDING` in
`apps/web/eslint.one-door.js` is empty), A2 has no known-missing entry
(`FINISHED_PHASES = ['A0', 'A1', 'A2']`), and every shortcut, menu item
and toolbar button names an action of the action catalog
(`apps/web/src/actions/catalog.ts`). A2.12b and A2.13 were uncommitted on
2026-09-30, to ship as 0.10.15. (Was: "the editor is migrated in A2".)
**Scope**: `packages/commands` (new) and every code path that writes a deck,
folder or component document: `apps/web/src/{ui,components,editor,pages}`,
the server routes that mutate documents, and the agent hosts of ADR 0011.
`packages/slide-model` keeps its mutations; what changes is who may call them.
**Extends**: ADR 0003 ("Yjs is the single source of truth"). The invariant
becomes **state = Yjs, written only through commands**.
**Related**: [`docs/plans/agentic-layer.md`](../plans/agentic-layer.md) §4.1,
§4.2, §5, §9, Appendix A/B; ADR 0011 (how agents execute commands).

## Context

The goal of the agentic layer is full parity: an agent can do everything a
user can do in the editor, from building a whole deck to "nudge that" or
"change the font". The capability survey of 2026-09-26 (at `304b316`, v0.9.29)
found that there is no single place where "what a user can do" is defined:

- **Writes are scattered.** React components call slide-model mutations,
  `richText` writers, `tableMutations`, `animationMutations` and
  `doc.transact` directly.
- **Much behaviour exists only in React.** The clipboard, duplicate with group
  remapping, move/nudge (including the `imageRect` rule for cropped images),
  align to slide, flip, creation defaults, pen and path geometry, text-style
  apply/detach/reset, token CRUD and seeding, the list rules, table routing,
  animation defaults and the component master write. Appendix B of the plan
  lists 15 groups.
- **There is no runtime schema.** No zod anywhere; `updateObject` writes any
  keys it is given.
- **The UI already drifts from itself.** The survey's bugs are the same rule
  kept in one path and missing in another: `imageRect` moves with a drag but
  not with nudge, Inspector X/Y, align or distribute; `duplicateObject` keeps
  the source `groupId`; `stamp`/`promote` flatten rich text.

An agent that calls slide-model directly would therefore get a weaker editor
than a person: no defaults, no group remap, no validation. And any agent
surface built beside the UI would have to re-implement every rule the UI
holds, and then keep up with it by hand.

## Decision

1. **`packages/commands` is the capability registry and the only writer.**
   Every user-visible mutation of a document, and every server-side effect a
   user can trigger (import, export, share, media), is a `CommandDef`: id,
   domain, title, a description written for a model, zod `input` and
   `output`, required role, effects, undo policy (`undoable` /
   `irreversible` / `n/a`), confirmation policy, the hosts it can run on,
   examples, and the handler. The package depends on slide-model, shared,
   animation and zod, and never on React, Pixi or the DOM, so every command
   runs and is tested in Node.

2. **Hosts execute commands; they do not define them.** The editor runs
   commands through the BrowserHost (`useCommand()`) against its local Y.Doc
   with `LOCAL_ORIGIN`, so editor undo behaves exactly as today. Agents run
   the same commands through the ServerHost (ADR 0011). Neither host has
   behaviour the other lacks, because neither host contains behaviour.

3. **Validation happens at the boundary.** Every host validates input against
   the command's zod schema before the handler runs. The schemas live in
   `packages/shared/src/schema/` next to the TypeScript types and cover every
   property of every object type, so an unknown or malformed key is rejected
   instead of being written into the document.

4. **Addressing is explicit.** Commands take ids or selectors, never "the
   current selection". A selection is resolved to ids before a command runs
   (the UI knows it; an agent asks `editor.context`). That keeps a command's
   effect a pure function of document plus input, which is what makes
   changesets replayable and contract tests deterministic.

5. **The registry is the source of truth for the capability surface.** MCP
   tools, the batch HTTP API, the committed capability manifest and, where it
   fits, menu labels are generated from it. A capability is left out of the
   agent surface only by an entry in the allowlist, with a written reason.

6. **Reads stay free.** The rule governs writes. Read-side slide-model imports
   (observers, `listSlides()`, selectors) remain allowed in the UI; queries
   are commands so that agents get them, not so that the UI must use them.

## Alternatives considered

- **Let the agent call slide-model directly.** slide-model is already
  headless, and `pptx/appendDeck.ts` already writes live decks this way.
  Rejected: slide-model is the storage layer, not the behaviour layer. Half of
  what the editor does is not in it (Appendix B), `updateObject` validates
  nothing, and there would be nothing to enumerate, so parity could not be
  tested, only hoped for.
- **A parallel "agent API" beside the UI**: agent-specific tools or endpoints
  calling shared helpers, while the UI keeps its own paths. Rejected because
  two doors drift. Every feature would be built twice, and nothing mechanical
  would notice when the second copy is missing or different. ADR 0009 records
  what this costs in this repo: PowerPoint import and export were two
  translations of one model and differed in 6 173 values on one real deck.
- **Extract the web-only logic into shared helpers, without a registry.**
  This fixes the headless-behaviour gap but carries no metadata (role,
  effects, undo policy, schema, description), so there is still no surface to
  generate agent tools from and no list to test parity against. The registry
  is that list.

## Consequences

- **One door, enforced by lint.** An ESLint `no-restricted-imports` rule
  forbids `apps/web/src/{ui,components,editor,pages}` from importing
  slide-model mutations, `richText` writers, `tableMutations`,
  `animationMutations`, `deckGuides` writers, or calling `Y.Doc.transact`. It
  is switched on per directory as A2 migrates that directory.
  _As built:_ the rule covers all of `apps/web/src` from A2.1 (2026-09-28).
  Its writer list is generated from the `writer` entries of
  `packages/commands/src/parity/slideModelExports.ts`. Files not yet
  migrated were exempted one by one in `ONE_DOOR_PENDING`, and
  `oneDoor.test.ts` failed when a listed file no longer needed it. The
  list has been empty since A2.13 (2026-09-30). The dev-only e2e hook
  (`state/testApi.ts`) writes through the registry too. The only non-test
  file exempted (`ONE_DOOR_IGNORES`) is `state/testApiLegacyFixtures.ts`,
  which seeds legacy states that no command creates any more (the retired
  `onEnter` animation trigger).
- **Parity is a test, not a convention.**
  `packages/commands/src/parity/parity.test.ts` requires that every exported
  slide-model writer is used by a command handler, every Fastify route is
  backed by a command, every shortcut in `apps/web/src/state/useShortcuts.ts`
  and every menu/toolbar action dispatches an existing command id, and every
  command has a description of at least 40 characters, an example and a
  contract test. _As built:_ the route part is the server's route guard
  (`apps/server/src/routes/agentParity.test.ts`). The shortcut / menu /
  toolbar part is the action catalog (A2.13,
  `apps/web/src/actions/catalog.ts` + `catalog.test.ts`). There, each
  action names the commands that carry its effect, or says why it is
  editor-only (viewport, selection, local clipboard, the editor's own undo,
  navigation) or `planned`. The binding sites must name a catalog action:
  the types require it on `ShortcutBinding` and the menu item wrappers,
  and the test requires it on every toolbar button. Two lists sit beside it, with different meanings:
  - `packages/commands/src/parity/allowlist.ts`: **permanent, deliberate**
    exclusions (view state such as zoom and pan, present-mode navigation),
    each with a reason. Adding an entry is a reviewed change.
  - `packages/commands/src/parity/knownMissing.ts`: **temporary debt** from
    A0: capabilities the UI has that no command covers yet. It only shrinks;
    A2 is done when it is empty. New work never goes onto it. (A2's part
    has been empty since A2.12b; 7 entries remain for A3 and A4 on
    2026-09-30.)
- **Schema coverage is checked at compile time.** A `z.infer` equality check
  fails the typecheck when a property is added to a type in
  `packages/shared/src/slide.ts` but not to its schema.
- **Every command is contract-tested** by running its examples against a
  fixture document and comparing `listSlides()` structurally, never by CRDT
  byte equality (`Y.encodeStateAsUpdate` is not canonical).
- **The capability surface shows up in review.**
  `pnpm --filter @narrative/commands capabilities` writes
  `packages/commands/capabilities.json` and `docs/capabilities.md`; both are
  committed, and a test fails when they are stale. Every added, removed or
  re-described capability is therefore visible in the diff Petr reads.
- **The `agent-parity` agent** (`.claude/agents/agent-parity.md`) reviews what
  the guards cannot judge: description quality, eval scenarios, style-pack
  representability, PPTX round-trip.
- **Invariants move out of React into one place.** Next active slide after
  delete, the outline depth cap, per-slide name uniqueness, the 24-colour cap
  and the rules above become handler code, tested in Node, the same for the
  UI and for agents.
- **Migration cost is concentrated in A2**, the largest phase of the plan:
  every Appendix B item is moved into a command and the UI is switched to
  `useCommand()`. Editor regressions during extraction are the main risk; the
  e2e suites for keyboard shortcuts, inspector flows and destructive flows
  are the net. Hot paths (drag, typing) gain a dispatch and a validation
  step; the cost has to be measured with `pnpm load:all`, not assumed.
- **Features cost more to add, on purpose.** A new capability is not done
  until it has a command, schema, examples, a contract test, an eval
  scenario and a regenerated manifest. That price is what buys parity that
  cannot silently rot.
- **Editor undo is unchanged.** The BrowserHost writes with `LOCAL_ORIGIN`,
  which is what the editor's UndoManager tracks.
