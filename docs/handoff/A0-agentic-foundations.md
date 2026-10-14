# A0 — Agentic layer foundations — handoff (2026-09-26)

**Status:** complete in the working tree, **uncommitted, unreleased, not
deployed.** Base: `4e3c503` (docs commit on top of the `v0.9.29` tag at
`00890b0`). Production serves `{"version":"v0.9.29+00890b0"}` (checked
2026-09-26). CHANGELOG: the `Unreleased` section. No version number has been
chosen; releasing means the usual bump of all 8 workspace `package.json`
files (now including `packages/commands`), tag, build-push, deploy.

Plan: [`docs/plans/agentic-layer.md`](../plans/agentic-layer.md) §10, row
**A0 Foundations**. Decisions: [ADR 0010](../adr/0010-command-layer-is-the-only-writer.md)
(commands are the only writer), [ADR 0011](../adr/0011-agent-execution-over-mcp.md)
(agents over MCP, server-side execution, fork-based atomic batches).

No agent can reach Narrative after A0. The editor still writes through
slide-model directly; the registry exists, is tested, and is ready for the
ServerHost (A1) and the UI migration (A2).

_Updated later on 2026-09-26 after a parity-fix pass in the same working
tree: server route guard, one lock policy, known-missing accuracy additions,
`textStyleId` in the PPTX round trip. Numbers below are the post-pass ones._

_Updated again on 2026-09-26: **locks are UI-only; agents ignore them.** Petr
decided that an object lock is an editor concept (it stops canvas
drag/resize/nudge/delete for a person) and does not restrict commands. The
lock policy that pass added was removed the same day — see "Object locks"
below._

## What was completed

### `packages/commands` (new) — the capability registry

- `src/types.ts`, `src/registry.ts`: `CommandDef` (id, domain, title, model
  description, zod `input`/`output`, role, effects, undo policy, confirm
  policy, hosts, examples, `implementedWith`, handler), `defineCommand`,
  `CommandRegistry` (id pattern `<domain>.<verb>`, domain-prefix check, no
  duplicates, sorted `list()`).
- `src/run.ts`: `runCommandSync` / `runCommand` / `runBatch`. Validates
  role (`ROLE_RANK`), host, input and output. Each command runs in ONE
  transaction with the context's origin.
  - **Atomic batches run on a fork** (`atomic: true`, the default): all inputs
    validated first; the ops run on a `Y.Doc` seeded with
    `encodeStateAsUpdate(live)` **reusing the live doc's `clientID`**; only if
    every op succeeds is `encodeStateAsUpdate(fork, stateVectorAtFork)`
    applied to the live doc in one transaction. Failure discards the fork;
    live is untouched. Synchronous end to end, so nothing interleaves.
  - `atomic: false` runs ops in order in one live transaction.
- 50 commands (`src/commands/*.ts`, assembled in `src/catalog.ts`):
  table 14, object 12, slide 10, animation 4, guide 3, query 3, text 3,
  plus `ops.apply`. Full list: [`docs/capabilities.md`](../capabilities.md).
- **Object locks** (decided 2026-09-26): **locks are UI-only; agents ignore
  them.** `locked` is an ordinary optional property an agent may set or
  clear with `object.update`; no command checks it, and no command takes a
  `force` flag. `object.update` and `object.delete` say once in their
  descriptions that `locked` is an editor-only flag that does not restrict
  commands. Test: `src/commands/locks.test.ts` (edits, text in a locked
  table, delete, and no `force` input, on the fixture's locked logo `lock1`
  on `s2`).
  _History:_ the parity-fix pass earlier the same day added one lock policy
  (`requireUnlocked`, `ForceSchema`, `LOCKED_NOTE` in `src/refs.ts`): commands
  that changed a locked object refused with `conflict` unless the input had
  `force: true`, a `locked`-only patch always worked, and the contract suite
  re-ran every example with its objects locked (`LOCK_EXEMPT` for creating,
  read-only and animation commands). It was removed the same day, before any
  release, together with its `locked.test.ts`.
- **Model-facing input tightened:** `animation.add` / `animation.update`
  reject the legacy `onEnter` trigger (it still reads back from old decks);
  `object.update`'s description states rotation is in radians and spells out
  where raw fields do less than the editor (crop not scaled by
  width/height, flip does not negate rotation, inline runs override
  box typography, `fontFamily` does not snap `fontWeight`, `textStyleId`
  links but does not apply). A parity test checks that descriptions name
  only registered commands or mark them "planned, not available yet".
- `src/parity/`:
  - `slideModelExports.ts` classifies **every** runtime export of
    `@narrative/slide-model` (writer / reader / …);
  - `knownMissing.ts`: 81 entries (A1 42, A2 32, A3 5, A4 2) and
    `FINISHED_PHASES = ['A0']` — the test fails if an entry of a finished
    phase is left. (Was 67 at the first sweep; the parity-fix pass added
    token create/delete and effect-style commands, `component.master.edit`,
    `component.refreshThumbnail`, `deck.fonts.list`, `media.fontUrl`,
    `text.setBoxTypography` (the weight snap on a family switch), and removed
    `table.setSize`.) Route-backed entries carry their `routes`;
  - `allowlist.ts`: 12 deliberate exclusions (view state, present runtime,
    and — with their routes — browser sign-in/session, `/health`,
    `/metrics`), each with a reason of ≥ 20 characters;
  - `routes.ts`: `RouteRef`, `normaliseRoute`, `routeKey`, `routeCoverage` —
    shared by the parity test and the server route guard;
  - `parity.test.ts`: every export classified, no stale entries, every
    writer used by a command or known-missing, `implementedWith` names real
    exports, nothing both a command and known-missing, each route claimed
    once and in normalised form, descriptions name only real or "planned"
    commands, irreversible ⇒ `confirm: 'always'`, queries are viewer-role
    and effect-free.
- `src/contract.test.ts`: runs over every registered command — every example
  runs against `testing/fixtureDeck.ts` and its output matches the declared
  schema; every description ≥ 40 chars with ≥ 1 example; every document
  command pointed at missing ids fails `not_found` and leaves the document
  **byte-for-byte unchanged** (the validate-before-first-write rule; this is
  the one place byte equality is correct, because nothing was written).
- Manifest: `scripts/capabilities.ts` writes `packages/commands/capabilities.json`
  and `docs/capabilities.md`; `--check` verifies without writing;
  `scripts/capabilities.test.ts` fails when either is stale. Root alias:
  `pnpm capabilities`.

### `packages/shared` — runtime schemas

- `src/schema/` (zod 4): primitives, objects, animation, deck, agent `input`,
  `plain` projections, fixtures. `coverage.typecheck.ts` is a compile-time
  `z.infer` equality check per type (optional keys via `.exactOptional()` so
  `exactOptionalPropertyTypes` matches), so a property added to `slide.ts`
  without its schema fails `pnpm typecheck`.
- `TextObject.textStyleId` is now declared in `slide.ts` (the M16
  propagation in `DeckShell.tsx` read it through an ad-hoc
  `TextObject & { textStyleId?: string }` cast; `TableDefaults` already had
  it) and in the schema.
- `package.json`: `"sideEffects": false` and a runtime dependency on `zod`.
  Measured: main app chunk **38.67 kB gz** (budget 210 kB), so zod does not
  leak into the entry chunk.

### `packages/slide-model`

- `origins.ts`: `agentOrigin(runId)` (identity-stable per run until
  `releaseAgentOrigin`, because `UndoManager.trackedOrigins` compares by
  identity), `isAgentOrigin`.
- `duplicateObjects` (one transaction; fresh ids; sources' relative z-order;
  groups remapped — a source group with ≥ 2 members in the set becomes one
  fresh group, a single member becomes ungrouped; crop carried by the offset).
  `duplicateObject` is now a thin wrapper.
- `translateObjects` — THE way to move objects: delta on the live value,
  carries `imageRect`; it moves locked objects too (the editor filters them out
  of a drag or nudge itself; commands do not). `alignObjects`
  and `distributeObjects` carry the crop too (`setPositionCarryingCrop`).
- `tableMutations.ts`: row/column insert and delete now keep three documented
  invariants (size sums, merge geometry, border keys) with PowerPoint
  semantics; checked by `tableMutations.property.test.ts` (random sequences)
  and `tableMutations.structure.test.ts`, shared helpers in
  `tableInvariants.testUtil.ts`.
- `components.ts` / `stampComponent.ts`: `richTextOpsOf`, `RICH_TEXT_OPS_KEY`
  (`_richTextOps`, same key as the clipboard) and `insertObjectsWithRichText`
  — promote and stamp are lossless for text objects and table cells.
- `slideMeta.ts`: `clearSlideTransitionDirection`, `getSlideNotesText`
  (primitives the slide commands needed).
- `duplicateObject` (singular) is no longer exported from the package index;
  `duplicateObjects` is the one public duplicate.

### `apps/web`

- `state/useCommand.ts`: the BrowserHost hook (`run`, `batch`) with
  `LOCAL_ORIGIN`, the user's deck role and `host: 'browser'`. **Not used by
  any component yet** — wiring the UI is A2.
- `state/origins.ts`: `TOKEN_PROPAGATION_ORIGIN`, a named origin for the
  deliberately untracked text-style propagation in `DeckShell.tsx`
  (previously an anonymous `doc.transact(fn)`); `yjsMetrics.ts` counts it as
  a local send.
- Undo fixes (the plan's "5 origin-dropping nested transactions"): Alt-drag
  duplicate (`EditorLayout.tsx`), table-wide fill and Typography
  (`TableInspector.tsx`), list ops (`textListOps.ts`), inline-run strip +
  box patch (`textEditSelection.ts` `transactTextAction`), token propagation
  (named, see above). Row/column steppers are one step.
- No writes on view (the plan's "2 writes caused by viewing"):
  `FontWeightSelect.tsx` derives the displayed face (`fontWeights.ts`, CSS
  weight matching) and never writes; `AnimationTimeline.tsx` no longer
  migrates `onEnter` on open (`animationTriggers.ts`: new steps get
  `afterPrevious`; `onEnter` offered only for a step that still has it).
  `FontFamilySelect.tsx` snaps the weight in the same patch as a user's
  family switch.
- Crop carried by nudge (`nudgeSelection` → `translateObjects`), Inspector
  X/Y and align to slide (`translate` prop → `translateObjects`). The mouse
  drag deliberately keeps absolute per-frame `bulkUpdateObjects` writes from
  the pointer-down snapshot (idempotent under snapping).
- Context menu: layer labels fixed via `LAYER_MENU_ITEMS` with shortcut
  hints; Duplicate uses `duplicateObjects`.
- Duplicates stay selected: the selection pruner in `EditorLayout.tsx` now
  judges only against a NEW objects snapshot (`prunedAgainstObjectsRef`).
- `testApi.ts`: `addImage` (with crop) and `addAnimation` for e2e.
- `Dockerfile`, `package.json`, `tsconfig.json`, `vite.config.ts`: the
  `@narrative/commands` workspace dependency and alias.

### `apps/server`

- `pptx/importDeck.ts`: `registerDeckMedia` — the one path that commits
  `media_assets` rows (with the deck rows, for an import) and only then
  enqueues video transcodes; `discardDeckMedia` for provably unreferenced
  media.
- `pptx/appendDeck.ts`: uses `registerDeckMedia` **before** the live
  document write (it used to write the doc first and never enqueue
  transcodes — appended videos stayed `pending` forever). On failure it
  reports `documentTouched`; `routes/pptxImport.ts` and `media/tus.ts` turn
  that into "Append failed part-way — some slides may already be in the
  deck; check it before retrying" vs "Append failed — no slides were
  written". Test: `pptx/appendDeck.test.ts`.
- **Route guard.** Route registration moved out of `index.ts` into
  `http/registerRoutes.ts` (`registerHttpRoutes`), so a test can build the
  exact production route table. `routes/agentParity.test.ts` does that on a
  bare Fastify instance with a stub database (plugin routes such as tus
  included, `/metrics` forced on) and fails on any route not claimed by a
  command (`CommandDef.routes`), a known-missing entry or the allowlist, and
  on any claim naming a route that no longer exists. 45 routes today
  (counted by the docs sweep from `registerHttpRoutes`). The server reaches
  `@narrative/commands` only in this test, through a vitest alias and a
  `tsconfig.json` path; it is not in `apps/server/package.json`, and
  `tsconfig.build.json` excludes tests, so the image build is unaffected.
- **PPTX:** `TextObject.textStyleId` now round-trips through Narrative's
  extension (`ooxml/objectExt.ts`, `extSchema.ts` `idRef`), next to
  `textStyleOverrides`, which already did; `roundtripMatrix.ts` carries it
  in the text row.

### Docs and agent briefs

- ADR 0010, ADR 0011 (incl. decision 6, fork-based atomic batches).
- `.claude/agents/agent-parity.md` (new), `ai-integration.md` (rewritten:
  owns MCP, playbooks, the `narrative` skill; Opus), `state-sync.md`
  (origins, `packages/commands` ownership), `narrative-docs.md`
  (capabilities check). `docs/agents.md` ownership map.

## Key decisions (made during A0)

- **Atomic batches fork instead of rolling back.** A Yjs transaction cannot
  be aborted. A temporary UndoManager rollback was rejected: the editor's own
  UndoManager would already hold a stack item for the failed write, and
  undoing it later would resurrect content the rollback restored as new
  items. Single commands do not fork (a document copy per edit); they must
  check all preconditions before the first write, enforced by the contract
  suite. Recorded in ADR 0011 §6.
- **The fork reuses the live `clientID`** so the fork's clock continues the
  live one and the delta applies cleanly; a failed fork is destroyed before
  its clock is ever published.
- **Drag stays absolute, nudge becomes relative.** See the `EditorLayout.tsx`
  comments: per-frame absolute writes are idempotent under snapping;
  `translateObjects` adds to the live value so fast key-repeat cannot lose
  steps.
- **Token propagation is off the deck's undo stack on purpose** — Mod+Z must
  not desync linked text from its folder token. It moves server-side in A2.
- **A lone copy of a group member is ungrouped**, not added to the source
  group (a group of one means nothing).

## How to verify

```bash
pnpm install                                       # A0 adds a workspace package and zod
pnpm typecheck && pnpm lint
pnpm -r test                                       # 2,188 passed, 32 skipped (2026-09-26)
pnpm --filter @narrative/commands test             # parity + contract + locks + manifest: 328 passed
pnpm --filter server test                          # includes the route guard: 497 passed, 1 skipped
pnpm --filter @narrative/commands capabilities --check   # exit 0 = manifest current
pnpm size                                          # FAILS on Tiptap only (pre-existing, see below)
PLAYWRIGHT_USE_SYSTEM_CHROME=1 PLAYWRIGHT_NO_VIDEO=1 pnpm --filter web test:e2e \
  -g "carry a crop|Viewing never writes|Canvas object shortcuts|layer items|Duplicate from the menu"
```

Measured on 2026-09-26 (unit counts re-run by the docs sweep; e2e numbers
reported by the implementing session):

| Package                | Files   | Passed    | Skipped |
| ---------------------- | ------- | --------- | ------- |
| `apps/web`             | 69      | 639       | 30      |
| `apps/server`          | 36      | 497       | 1       |
| `packages/slide-model` | 27      | 381       | 0       |
| `packages/commands`    | 13      | 328       | 0       |
| `packages/shared`      | 8       | 187       | 0       |
| `packages/animation`   | 13      | 144       | 0       |
| `apps/video-worker`    | 1       | 12        | 1       |
| **Total**              | **167** | **2,188** | **32**  |

(Was 2,136 / 164 files at the first sweep, before the parity-fix pass, and
2,224 with the lock policy, before it was removed later the same day —
`packages/commands` went from 364 to 328.)

e2e run of the touched specs: **33 passed, 5 skipped, 2 failed** — both
failures in `m16-component-flows.spec.ts`, pre-existing (below).

## Findings (pre-existing, not caused by A0)

- **Real-deck PowerPoint round trip is not clean.**
  `npx tsx src/scripts/pptxRoundtrip.ts <real deck>` reports **5
  differences** (still exactly these 5 after the parity-fix pass), and the
  same 5 on a clean `4e3c503` checkout: `fillStyle.centerY`,
  `text.length`, and `fontSize` 27.99 → 28. CLAUDE.md requires 0, and the
  0.9.25 CHANGELOG entry recorded 0 on the reference deck, so something between
  0.9.25 and 0.9.29 regressed it. Not bisected; the deck used was not
  recorded in the report (unverified whether it is the reference deck).
- **`m16-component-flows.spec.ts` hardcodes a drafts folder id**
  (`const FOLDER_ID = 'drafts-958e2b33e6952467a1fbe3c71fc802e6'`, line 27)
  and fails on any database where Drafts has another id.
- **Tiptap vendor chunk is over budget:** 132.64 kB gz against 120 kB
  (+12.64 kB), so `pnpm size` exits 1. Every other budget is green (main
  38.67, Pixi 160.24, React 121.07, Yjs 8.95, GSAP 26.89, total first paint
  605.45 of 800 kB). A0 adds nothing to that chunk.
- **Stryker mutation testing is broken as tooling.**
  `pnpm --filter @narrative/slide-model mutate` fails in the dry run:
  `TypeError: Cannot destructure property 'moduleGraph' of 'project.server'
as it is undefined` ("Test runner crashed. Tried twice to restart it").
  Reproduced by the docs sweep on 2026-09-26 with
  `@stryker-mutator/vitest-runner` 8.7.1 and vitest 4.1.7 — the 8.x runner
  does not support vitest 4's API. Needs a runner version that supports
  vitest 4 (or a pinned vitest for the mutation run). It leaves
  `packages/slide-model/.stryker-tmp/` behind (gitignored).

## Found, not fixed

- **Drag undo grouping relies on the UndoManager's 500 ms capture window.**
  _Resolved 2026-10-02: every pointer gesture is one undo step by its
  boundaries (web `state/undoGestures.ts`, slide-model `beginUndoGesture` /
  `endUndoGesture`; `docs/plans/dev-speed.md`)._
  A drag (and the Alt-drag clone plus its drag) is one undo step only because
  its per-frame writes keep landing inside the window (Yjs' default
  `captureTimeout`; `createUndoManager` in `slide-model/src/undo.ts` does not
  set one). A pause longer than 500 ms mid-drag splits it, and two separate
  gestures less than 500 ms apart merge. A proper fix is an explicit gesture boundary
  (`stopCapturing()` at pointer-down and pointer-up); belongs with the A2
  move/resize extraction.

## Deviations from the plan's A0 row / §9.1 (as of this handoff)

The plan text describes the end state; A0 delivered less of the guard
machinery than §9.1 lists. None of this is hidden debt — it is the A1/A2
scope — but do not assume these exist:

- **No ESLint `no-restricted-imports` rule yet.** ADR 0010 switches it on per
  directory during A2.
- **Routes are guarded; shortcuts and menu actions are not.** The server
  route guard (above) enumerates the real Fastify route table. There is no
  enumeration of `useShortcuts.ts` bindings or menu/toolbar action ids yet
  (A2). ADR 0010's Consequences describe the full version.
- **`useCommand()` is not called by any component.**
- **No eval suite** (`pnpm agent:eval`, plan §9.3) and no
  `packages/commands/playbooks/`, no `apps/server/src/mcp/`.
- `component.stamp` is known-missing (A1: needs a host that loads the
  component document); `addObjects` / `insertObjectsWithRichText` are
  claimed by A2 entries (`object.copyTo`, `component.promote`).

## Traps worth knowing

- **The outermost `doc.transact` origin wins.** slide-model mutations pass
  `LOCAL_ORIGIN`, but wrapped in an origin-less `doc.transact(fn)` they are
  attributed to `null` and fall out of undo history. Alt-drag, table fill
  and list ops were exactly this; inline formatting was its twin — a bare
  `Y.Text.format` opens its own origin-less transaction. Any wrapper
  transaction, and any direct Y.Text write, must name its origin.
- **The objects snapshot is rAF-batched.** Code that selects fresh ids right
  after an insert runs before the snapshot contains them; a pruner that runs
  on selection change drops them. Judge staleness only against a snapshot
  taken after the selection.
- **A Y.Text cannot have two parents**, and a detached Y.Text cannot take a
  delta. Copying rich text means: clone the structure, integrate, then
  replay the captured delta (`insertObjectsWithRichText`). `richText.ts`
  `toDelta` is the renderer's projection and drops paragraph attributes —
  use `richTextOpsOf`.
- **`pnpm-lock.yaml` shows ~7,800 changed lines.** Almost all of it is
  format, not content: the committed lockfile had been Prettier-formatted,
  and `pnpm install` rewrote it in pnpm's own style (pnpm 9.15.4 matches
  `packageManager`). lint-staged runs Prettier on `*.yaml` at commit, so the
  committed diff should shrink back to the real additions
  (`packages/commands`, zod).
- **Adding a workspace package means touching each Dockerfile** that depends
  on it: the manifest `COPY` lines run before `pnpm install`. A0 added
  `packages/commands/package.json` to `apps/web/Dockerfile` only; server and
  video-worker do not depend on it. They now pull **zod at runtime** through
  `packages/shared` — no image has been built with A0 yet, so confirm with
  `infra/scripts/build-push.sh` before the release.

## Next step

**A1 — server host, identity, MCP** (plan §10): personal access tokens
(hashed, scoped, expiring; accepted by `authPreHandler`, `onAuthenticate`,
the tus handler), the ServerHost with an access check before
`openDirectConnection` and one `agentOrigin(runId)` transaction per
invocation/batch, `agent_runs` / `agent_ops`, `agent.revert`,
`activeSlideId` in awareness, `editor.context` / `editor.show`,
`POST /api/commands`, `@fastify/rate-limit`, `/api/mcp` with tools generated
from the registry, the first playbooks, `security-reviewer` at the end.
Remove the A1 entries from `knownMissing.ts` as they land and add `'A1'` to
`FINISHED_PHASES` when done.

Before that: decide whether to release A0 on its own (the plan says each
phase is separately releasable; it carries real user-facing fixes).

## Known TODO

- Add the parity auto-run row to `CLAUDE.md` (plan §9.2) and refresh its test
  counts — Petr's edit, not an agent's.
- Fix the Drafts id in `m16-component-flows.spec.ts` (look it up via the API).
- Bisect the 5 real-deck round-trip differences (0.9.25 → 0.9.29).
- Tiptap budget: shrink the chunk or re-baseline the budget deliberately.
- Stryker: upgrade `@stryker-mutator/*` to a vitest-4-compatible runner.
- ~~Explicit drag gesture boundary instead of the 500 ms capture window.~~
  Done 2026-10-02 (`state/undoGestures.ts`).

## Links

- Plan: [`docs/plans/agentic-layer.md`](../plans/agentic-layer.md)
- ADRs: [0010](../adr/0010-command-layer-is-the-only-writer.md),
  [0011](../adr/0011-agent-execution-over-mcp.md), and
  [0003](../adr/0003-yjs-slide-model.md) (which 0010 extends)
- Manifest: [`docs/capabilities.md`](../capabilities.md)
- Ownership: [`docs/agents.md`](../agents.md),
  [`.claude/agents/agent-parity.md`](../../.claude/agents/agent-parity.md)
- Previous handoff: [`2026-09-25-slide-duplicate.md`](./2026-09-25-slide-duplicate.md)
