# Narrative — Testing Strategy

> Last updated 2026-09-30, after A2.13 (A2 closed; the counts table below is still the A2.11 measurement; see "Added in A2.13" and "Added in A2.12b"). Was 2026-09-30 after A2.12b, 2026-09-30 after A2.11, 2026-09-29 after A2.10 and after A2.9; before that 2026-09-28, 2026-09-27, 2026-09-26, 2026-09-09 and 2026-05-09.
> Current state, **measured** with `pnpm -r test` on 2026-09-30 (the A2.11
> tree, uncommitted at the time, on top of `925c08c` / v0.10.12), all green
> in the docs sweep's run. `pnpm typecheck` re-run by the sweep: exit 0.
> `pnpm lint` re-run by the sweep: 0 errors, 221 warnings (animation 2,
> server 7, web 212) — **only with `NODE_OPTIONS="--import=tsx"`** on
> `petronijus-PC`, whose Ubuntu 26.04 Node cannot strip types (SETUP.md,
> "Common first-run failures"):
>
> | Package                | Files   | Passed    | Skipped |
> | ---------------------- | ------- | --------- | ------- |
> | `apps/server`          | 87      | 1,193     | 1       |
> | `apps/web`             | 74      | 676       | 28      |
> | `packages/commands`    | 31      | 1,006     | 0       |
> | `packages/slide-model` | 28      | 402       | 0       |
> | `packages/shared`      | 10      | 199       | 0       |
> | `packages/animation`   | 14      | 149       | 0       |
> | `apps/video-worker`    | 1       | 12        | 1       |
> | **Total**              | **245** | **3,637** | **30**  |
>
> (3,666 with the 30 skipped; AGENTS.md no longer quotes a count (this table is the one place). A2.11's
> net +48: commands +4 files / +64 (`commands/textEdit.test.ts`,
> `commands/typography.test.ts`, `text/body.test.ts`, and
> `text/fontWeights.test.ts` moved from `apps/web/src/ui/`; three more
> replayed eval scenarios), web −2 files / −20 (`textFormatUndo.test.ts`
> deleted — its undo assertions moved to `commands/typography.test.ts` —
> and `fontWeights.test.ts` moved out), slide-model +2
> (`splitParagraphAt` in `richTextLists.test.ts`), server +2
> (`serverHost.test.ts`). After A2.10, 2026-09-29: 243 files, 3,588 passed —
> server 87 / 1,191, web 76 / 696, commands 27 / 941, slide-model 28 / 400.
> After A2.9, same day: 3,569 passed — web 699, commands 919. A2.10's net +19: commands +22
> (`table.setSize`, `overrideCells`, table gradients, two more replayed
> eval scenarios), web −3 (`oneDoor.test.ts` checks each `ONE_DOOR_PENDING`
> file, and three left the list); no test file added or removed.)
>
> Added in A2.12b (2026-09-30, uncommitted at the time; not re-measured by
> this sweep: a live agent eval was running against the dev stack):
>
> - e2e `component-promote-stamp.spec.ts`: promote a picture, then stamp
>   it, and each owner gets its copy; a picture pasted from a deck into a
>   master editor becomes the component's.
> - e2e `component-master-upload.spec.ts`: a tus upload into a master
>   carries `componentId`, is owned by the component and renders.
> - `component-picker-search-settings.spec.ts` and `m16-component-flows.spec.ts`
>   now seed their own folder and components through the API, which closes
>   the "hardcoded Drafts folder id" known failure.
> - 67 e2e spec files (65 at 0.10.14).
> - Server unit tests for `media/mediaOwner.ts`,
>   `services/componentStaging.ts`, `routes/componentStaging`
>   (promote/stamp routes), `services/mediaCopyBudget.ts`, plus changes to
>   the tus, finalize, bucket-cleanup, media-route, media-sharing,
>   deck-insert and insert-objects tests.
> - Web: `state/providerSaved.test.ts` and
>   `state/promoteSelectionToComponent.test.ts` are new.
>   `writeComponentMasterTree.test.ts` and
>   `EditorContextMenu.promote.test.tsx` were deleted with the code they
>   tested. Web skips are 27 (was 28).
> - Commands: `serverCommands.test.ts` covers media commands and upload
>   sessions targeting a component master, and `object.insertFromDeck`
>   between a master and a deck. `run.test.ts` covers
>   `release` / `abandon`. `component.promote` is covered by the contract
>   suite through its examples, like every command.
> - Upload sessions for a component (migration 0029):
>   `media/uploadSessions.test.ts` and
>   `uploadSessions.integration.test.ts` changed. The integration file was
>   not run by this sweep.
> - Eval scenarios `component-promote-headline` and
>   `component-master-picture` are live only (the memory world does not
>   model component documents), for 44 scenarios, 36 of them replayed.
>
> Added in A2.13 (2026-09-30, A2 close; uncommitted at the time; not
> re-measured as a whole by this sweep: a full e2e run was going on
> against the dev stack):
>
> - **The action catalog guard**, `apps/web/src/actions/catalog.test.ts`
>   (new file, 4 tests). It checks that every command named in
>   `actions/catalog.ts` exists in the registry and that every
>   `editorOnly` / `planned` reason is at least 20 characters. It fails
>   on a catalog action that nothing in `src/` uses. It also requires
>   every `<Button>` / `<button>` in `ui/Toolbar.tsx` to carry a catalog
>   `data-action`, found by a TypeScript AST scan. Shortcuts and Radix
>   menu items are covered by the types (`ShortcutBinding.action`, the
>   `action` prop of the `components/ui` menu items), so `just typecheck`
>   is part of the guard. Hand-rolled menus are covered too: every element
>   with a `menuitem` role in `apps/web/src` needs a catalog `data-action`.
>   Raw key handlers, Inspector controls and canvas gestures are not.
> - `oneDoor.test.ts` now runs against an empty `ONE_DOOR_PENDING`.
>   `catalog.test.ts` + `oneDoor.test.ts` passed 7/7 in the sweep.
> - Commands: `objectEdit.test.ts` adds "takes a caller-chosen id, for
>   every kind of object, and refuses one the slide has" (`object.create`
>   `id`; `conflict` on a taken id, `invalid_input` on `a/b`).
>   `objectEdit.test.ts` + `parity/` passed 42/42 in the sweep.
> - The parity test now also rejects any A2 known-missing entry
>   (`FINISHED_PHASES = ['A0', 'A1', 'A2']`).
> - e2e: the dev-only test hook (`window.__narrative_test_api`,
>   `state/testApi.ts`) writes through the command registry.
>   - `addImage` needs a real `assetId`, which specs upload with
>     `e2e/fixtures/media.ts` (`uploadTestPicture`, `media.upload`
>     through `POST /commands`). `inspector-flows` and
>     `keyboard-shortcuts` do so.
>   - `htmltext-texture-isolation.spec.ts` creates its own deck. It used
>     to open a hard-coded deck id that existed in one database, and
>     `E2E_DECK_ID` still overrides it.
>   - `agent-activity.spec.ts` (component master) builds on the master
>     slide the server writes.
>   - Legacy `onEnter` animation steps are seeded by
>     `state/testApiLegacyFixtures.ts`.
>
> Added in A2.11 (2026-09-30): contract tests for `text.edit`,
> `text.replace` (`commands/textEdit.test.ts`), `text.setBoxTypography` and
> `text.style.apply` (`commands/typography.test.ts`, incl. the undo cases
> from the deleted web test) and the body helpers (`text/body.test.ts`);
> `splitParagraphAt` cases in slide-model; the integration test
> `agent/folderFonts.integration.test.ts` (the server reads a folder's font
> faces from its font assets; `test:integration` 29 passed with the change);
> the e2e `typography-commands.spec.ts` (5 tests, 15/15 over 3 repeats) and
> `text-edit-commands.spec.ts` (3 tests, 9/9 over 3 repeats), both as
> reported with the change; eval scenarios `product-rename-everywhere`,
> `subtitle-plain-restyle`, `year-fix-second-occurrence` (recorded,
> replayed). Full e2e run on the A2.11 tree (2026-09-30, system Chrome,
> `PLAYWRIGHT_NO_VIDEO=1`): 167 passed, 15 skipped, 0 failed, 12.3 min.
>
> Added in A2.10 (2026-09-29): `table.setSize` / `table.style.table`
> `overrideCells` contract tests in `packages/commands`
> `commands/tables.test.ts`, table cases for `object.fill.gradient` in
> `commands/appearance.test.ts`; the e2e `table-commands.spec.ts` (10 tests:
> boundary drag as one undo step, add-column handle, move handle, Rows
> stepper, whole-table and column gradients, Typography on a column, Image
> fill written only with a picture, Tab into the next cell, Tab past the
> last cell with typing at once — 30/30 over 3 repeats on 2026-09-29; one
> earlier repeat run lost a page load to a Vite HMR reload while files were
> being edited, not a test failure); eval scenarios `table-resize-recolour` and
> `table-header-gradient` (recorded, replayed).
>
> (2026-09-28, MCP tool-list compaction on top of `ee705da` / v0.10.0: 225
> files, 3,205 passed, 32 skipped — server 80 / 1,133, web 75 / 686 + 30
> skipped, commands 21 / 645, slide-model 27 / 392, shared 8 / 193,
> animation 13 / 144. The web skips fell from 30 to 28 in 0.10.2 (A2.2):
> the two `SlidesPanel.test.tsx` skips "ArrowDown moves to next slide" /
> "ArrowUp moves to previous slide" were removed; A2.9 and A2.10 changed no skip.)
>
> Added in A2.9 + the triangle fix (2026-09-29): `packages/shared`
> `animationTiming.test.ts` (`layoutAnimationSteps`) and
> `shapeGeometry.test.ts`; `packages/animation`
> `__tests__/timelineLayout.test.ts` (the layout pinned against the GSAP
> compiler — moved from apps/web's `AnimationTimeline.layout.test.ts`,
> deleted; onClick is left out of that contract on purpose, see the test's
> header); `apps/web/src/ui/animationTriggers.test.ts`; `animation.retime` /
> `animation.retarget` contract tests in `packages/commands`; the e2e
> `animation-commands.spec.ts`; a triangle case in `renderer-visual.spec.ts`
> that pins the bottom corners; eval scenarios `agenda-step-timing` and
> `photo-animations-hand-over`.
>
> (2026-09-27, A1 working tree on top of `9e0e853`: 223 files, 3,192 passed —
> server 79 / 1,126, commands 20 / 639; `pnpm typecheck` + `pnpm lint` exit 0,
> lint 0 errors, 218 warnings in `apps/web`.)
>
> (At A0 close, 2026-09-26: 167 files, 2,188 passed — server 36 / 497,
> web 69 / 639, commands 13 / 328, slide-model 381, shared 187.)
> Plus **64 e2e spec files** in `apps/web/e2e/` (counted 2026-09-30 after
> A2.11; 62 after A2.10, was 53 at A1 and 50 at A0 — A1 added `access-tokens`, `agent-activity`,
> `agent-confirm`; A2 added `agent-upload-session`, `guides`,
> `inspector-appearance-commands`, `mcp-oauth-consent`, `object-clipboard`,
> `path-editing`, `slide-clipboard`, in A2.9 `animation-commands` and in
> A2.10 `table-commands`, in A2.11 `typography-commands` and
> `text-edit-commands`),
> **6 server integration test files** against a real Postgres
> (`pnpm --filter @narrative/server test:integration`, not part of
> `pnpm test`; 3 at A1, then `uploadSessions` (A2.7a), `folderTokens` (A2.8) and in A2.11
> `folderFonts`), and the **agent eval suite** (`pnpm agent:eval`, 39
> scenarios, 33 of them replayed for free; the last full live run recorded
> here is 39/39 on 2026-09-30 for $4.77 (10 min, recordings refreshed) — earlier
> 14/14 on 2026-09-28, when the suite had 14 scenarios; A2.9's three animation
> scenarios passed 3/3 live on 2026-09-29, and A2.10's four table / gradient
> scenarios (`table-resize-recolour`, `table-header-gradient`,
> `table-merge-add-column`, `badge-gradient`) 4/4 live on 2026-09-29 for
> $0.55; A2.11's three text scenarios plus `heading-one-font`,
> `bullets-second-bold`, `table-resize-recolour` and `footer-page-number`
> 7/7 live on 2026-09-30 for $0.91 — see below).
>
> (`packages/commands` was 364 before the lock policy was removed later on
> 2026-09-26 — its locked re-run of every example went with it; was 1,542
> passing / 127 files on 2026-09-09, and 1,219 across 5 packages
> on 2026-05-09.) Plus **50 e2e spec files** in `apps/web/e2e/` (was 40 on
> 2026-09-09). Note the skip count: **32 total, 30 of them in `apps/web`**
> (2026-09-26; 30 and 28 since 0.10.2) — the long-standing "23 web skips"
> figure is stale, and 7 skips accumulated without being triaged into the
> tables below.
> Bundle budgets enforced via `size-limit` (`pnpm size`). Property-based CRDT convergence,
> server lifecycle/leak coverage, multi-client e2e collab, destructive-
> flow coverage, sampled-thumbnail visual regression all active.
> Lighthouse + Stryker mutation testing wired in (opt-in). Stryker was
> broken 2026-09-26 → 2026-10-14 (runner 8.x vs vitest 4); fixed with
> Stryker 10, a fresh `node_modules` (a stale nested `@babel/parser` 7 under
> `@babel/core` 8 broke its instrumenter) and a run from the repo root (the
> sandbox has to keep the repo's layout — see `stryker.config.json`).
> Baseline 2026-10-14: 49% (`mutations.ts` 65%, `slides.ts` 26%).
>
> Added in agentic-layer A1 (2026-09-27):
>
> - **Server** (+43 files): the ServerHost (`agent/serverHost.test.ts`:
>   access check before opening a document, one transaction per command or
>   batch, confirmation gate, runs, redaction), per-run revert incl.
>   component masters (`services/runs.test.ts`), the MCP server over real
>   HTTP with the SDK client (`mcp/mcp.test.ts`), URL downloads and their
>   confirmation (`mcp/urlFetch.test.ts`), the session sweep, the OAuth flow
>   and its failure paths (`mcp/oauth/*.test.ts`), the SSRF guard
>   (`net/ssrfGuard.test.ts`), personal access tokens, the sign-in policy and
>   the kill switch (`auth/*.test.ts`), rate limits and the bearer cache
>   (`http/*.test.ts`), awareness ownership and redaction
>   (`hocuspocus/awareness*.test.ts`), the Hocuspocus auth-context regression
>   over a real WebSocket (`hocuspocus/authenticate.context.test.ts`), Sentry
>   scrubbing, and **`mcp/toolListBudget.test.ts`** — `tools/list` must stay
>   ≤ 177,000 bytes (≤ 16,000 per tool); it measured ≈ 175,569 (form mode) to
>   176,529 bytes (url mode) for 121 tools on 2026-09-30 during A2.11 (before
>   the step's last example tweak, not re-measured) — ≈ 470 bytes of headroom
>   (was ≤ 169,000 and 167,916–168,876 bytes for 117 tools after A2.10, 124
>   bytes of headroom; ≤ 167,000 and 166,020–166,980 bytes for 116
>   tools after A2.9, same day; the budget is raised step by step during A2 and reviewed as a
>   whole at A2.13; was ≤ 132,000 and 128,349–129,309 bytes on 2026-09-28,
>   ≤ 160,000 and 148,207–151,119 on 2026-09-27, before the shared field
>   vocabulary). Its
>   companion **`mcp/vocabulary.test.ts`** (2026-09-28) keeps
>   `mcp/vocabulary.ts` honest both ways: an entry that no longer matches any
>   command's description fails, and so does a description repeated on ≥ 3
>   tools (≥ 100 bytes to repeat) that is not in it.
> - **Integration** (`*.integration.test.ts`, `vitest.integration.config.ts`,
>   needs the local Postgres from `.env`): the run store
>   (`agent/runStore.integration.test.ts`), paged deck/folder lists
>   (`services/listPage.integration.test.ts`), the OAuth store
>   (`mcp/oauth/store.integration.test.ts`). Not run by the 2026-09-27 docs
>   sweep (they write to the dev database).
> - **`packages/commands`** (+7 files): server commands against fakes
>   (`commands/serverCommands.test.ts`, `testing/fake*.ts`), registry rules
>   (`registry.test.ts`: target metadata, `undoneBy`, `confirmWhen` on every
>   URL-taking command), the agent surface (`agentSurface.test.ts`), paging,
>   playbooks (`playbooks/playbooks.test.ts`), and the **agent eval replay**
>   (`agentEvalReplay.test.ts`: 11 recorded scenarios replayed in memory at A1,
>   28 after A2.9 and 30 after A2.10 on 2026-09-29, 33 after A2.11 on
>   2026-09-30; no model, no server).
> - **Web**: token and agent-presence state, the Agent activity model,
>   `editor.show`, and e2e for Access tokens, Agent activity and the
>   confirmation page.
>
> Added in agentic-layer A0 (2026-09-26): **`packages/commands`** — the
> parity guards (`src/parity/parity.test.ts`), a contract suite that runs
> every command's examples and a missing-id check over every command
> (`src/contract.test.ts`), atomic-batch tests (`src/run.test.ts`) and the
> manifest staleness test (`packages/commands/scripts/capabilities.test.ts`); a **locks are
> UI-only** test (`src/commands/locks.test.ts`: commands edit and delete a
> locked object normally and take no `force` flag — decided 2026-09-26; was:
> a lock policy under which commands refused locked objects unless forced,
> with the contract suite re-running every example locked, removed the same
> day); the **route guard**
> `apps/server/src/routes/agentParity.test.ts`, which builds the production
> Fastify route table (45 routes at A0, 69 at A1 per the plan) and fails on any route no command,
> known-missing entry or allowlist entry claims; **zod schema
> tests** in `packages/shared/src/schema/` plus a compile-time coverage check
> (`coverage.typecheck.ts`, fails `pnpm typecheck`, not a test run); a
> **table-structure property test** (`tableMutations.property.test.ts`);
> and e2e for crop-carrying moves, "viewing never writes", duplicate/undo
> and the context-menu layer labels.
>
> ⚠️ Red as of 2026-09-26, all pre-existing at `4e3c503`: `pnpm size`
> (Tiptap chunk 132.64 kB gz vs a 120 kB budget — still exactly that on
> 2026-09-27 at A1; 120.89 kB on 2026-10-14 once the vendor groups got
> priorities: Rolldown's manualChunks let `@tiptap/y-tiptap` pull yjs and
> lib0 into vendor-tiptap; the remaining 0.89 kB is Tiptap's own code (the
> notes' Link mark stays: PowerPoint import writes links), so the limit went
> to 122 kB the same day, Petr's call, and to 131 kB that evening with
> Tiptap 3.23 → 3.32 (129.63 kB; first paint 737 → 615 kB with Vite 8.3); total first paint 633.9 of 800 kB, was 605.45 at A0); the real-deck PPTX round
> trip (5 differences, AGENTS.md requires 0); `m16-component-flows.spec.ts`
> (hardcoded Drafts folder id, fails on any other database — fixed in
> A2.12b, 2026-09-30: the spec seeds its own folder and component).
>
> Added in the 0.9.x arc: **5 .pptx parser regression tests** (theme fonts +
> placeholder geometry inheritance, 0.9.1) and the **first 3 tests for
> `RenderScheduler`** (0.9.2). Nothing in this suite could have caught the
> other eight defects of that arc — see _Environment traps_.
>
> ⚠️ **There is no CI.** GitHub Actions was removed on 2026-09-07 (commit
> `573ba64`); nothing runs these suites but a human or an agent following
> `AGENTS.md`'s auto-run policy.
>
> ⚠️ **The e2e suite does not run on Ubuntu 26.04 as configured** — see
> _Environment traps_ below.

## TL;DR

- **Pure logic = unit tests.** `packages/slide-model`, `packages/animation`,
  `apps/server` core — these are the gravity well, stay strong.
- **User-visible behaviour = Playwright e2e.** Anything that depends on
  focus, keyboard scope, drag-and-drop, multi-step interactions, or visual
  rendering belongs here, not in jsdom.
- **Don't write component tests for "does this label render".** They break
  on every UI iteration without catching real bugs. We deleted ~80 of those
  this session.
- **Visual regression** for the Pixi renderer. Pixel sampling is the only
  honest renderer test.
- **Property-based** for CRDT convergence. Single most valuable test we
  _don't_ have.

## Test layers

| Layer                      | Where                                                                                                                                                                 | Purpose                                                                                                                                                                                                                                                                           | Status                                                                                                       |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Unit (pure logic)          | `packages/{slide-model,animation,shared}`                                                                                                                             | Yjs mutations, CRDT, GSAP DSL compiler, schema validators                                                                                                                                                                                                                         | Strong (402 + 149 + 199)                                                                                     |
| Command contract + parity  | `packages/commands/src/{contract,parity/parity,run,registry}.test.ts`, `apps/server/src/routes/agentParity.test.ts`, `apps/web/src/{actions/catalog,oneDoor}.test.ts` | Every command example runs (server commands against fakes); missing ids leave the doc untouched; every slide-model writer and every server route claimed; every shortcut / menu item / toolbar button named in the action catalog (since A2.13); atomic batches; manifest current | Strong (1,005 + route guard)                                                                                 |
| Server (unit + in-process) | `apps/server/src/{routes,hocuspocus,media,auth,agent,mcp,services,http,net}`                                                                                          | Fastify routes, Hocuspocus auth/persistence, the ServerHost, the MCP server and OAuth over real HTTP, SSRF guard, rate limits                                                                                                                                                     | Strong (1,193)                                                                                               |
| Integration (Postgres)     | `apps/server/src/**/*.integration.test.ts` (`pnpm --filter @narrative/server test:integration`)                                                                       | Drizzle stores against the real local Postgres: run store, list paging, OAuth store, folder tokens / fonts, upload sessions                                                                                                                                                       | Since A1 (6 files, opt-in)                                                                                   |
| Agent eval                 | `tests/agent-eval/` (`pnpm agent:eval`); replay in `packages/commands/src/agentEvalReplay.test.ts`                                                                    | Headless Claude Code drives the real MCP server; deterministic graders read the resulting document. Replay subset: recorded transcripts in memory, no model                                                                                                                       | Since A1 (44 scenarios, 36 replayed)                                                                         |
| Hook / state (React)       | `apps/web/src/state/*.test.tsx`                                                                                                                                       | Pure data hooks (`useMediaUpload`, `useSlideThumbnails`, `useVideoInfo`)                                                                                                                                                                                                          | OK                                                                                                           |
| Component contract (React) | `apps/web/src/{ui,components}/*.test.tsx`                                                                                                                             | ONLY for components with non-trivial logic (state machines, conditional branches) — not "does it render this label"                                                                                                                                                               | Was bloated; cleaned up                                                                                      |
| Round trip (PowerPoint)    | `apps/server/src/pptx/{roundtrip.test.ts,ooxml/validate.test.ts}`                                                                                                     | model → .pptx → model is exact for every object type and field (feature matrix); every exported part is ECMA-376-valid (`xmllint`); real decks via `just pptx-roundtrip <deck>`                                                                                                   | Strong (ADR 0009)                                                                                            |
| e2e (Playwright)           | `apps/web/e2e/*.spec.ts`                                                                                                                                              | User-visible behaviour — keyboard shortcuts, drag/drop, multi-window sync, full Inspector flows, present mode navigation                                                                                                                                                          | Strong (67 spec files)                                                                                       |
| Visual regression          | `apps/web/e2e/renderer-visual.spec.ts` (`visual-check.spec.ts` writes PNGs, compares nothing)                                                                         | Renderer output for canonical scenes (rect, text, image, magic-move keyframes)                                                                                                                                                                                                    | Sampled-thumbnail tests (Tier B.2); pixel-perfect baselines opt-in (`RUN_VISUAL_BASELINES=1`), not committed |
| Load / soak                | `tests/load/{hotEdit,awarenessFlood,docGrowth}.ts` (`just load`)                                                                                                      | Throughput, awareness rate, doc growth                                                                                                                                                                                                                                            | Thresholds fail the run; drift warnings against a local baseline                                             |
| Property-based             | `packages/slide-model/src/*.property.test.ts`                                                                                                                         | CRDT convergence: random op sequences from N clients converge; table-structure invariants under random insert/delete/merge                                                                                                                                                        | Active (Tier B.1; tables in A0)                                                                              |

## What was just cleaned up

| Before                                                                                    | After                                                                            |
| ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Web: 102 failures across 21 files                                                         | Web: 0 failures, 23 skipped (Tier A+B unblocked + cleaned the rest)              |
| 6 `objectRenderers/*.test.ts` files asserting Pixi mock-call shapes                       | Deleted; replaced by sampled-thumbnail e2e in `inspector-flows.spec.ts`          |
| `Inspector.test.tsx`, `Toolbar.test.tsx`, etc. asserting against `getByLabelText('Fill')` | Stale-text assertions marked `it.skip` with `// see e2e/inspector-flows.spec.ts` |
| Each test file with its own inline `vi.mock('pixi.js', () => ...)`                        | Single `apps/web/src/test/pixiMock.ts` — fixed once, all tests get the fix       |
| Each test file with its own `<MemoryRouter>...<AuthProvider>` boilerplate                 | Single `apps/web/src/test/renderWithProviders.tsx`                               |

## Pending skipped-test triage (61 tests)

For each currently-skipped test the action is one of: **fix** (real
behaviour assertion, just rebind to current `data-testid`), **delete**
(pure DOM-presence, no signal), **replace with e2e** (interaction needs
real focus / drag / keyboard scope).

### High value — fix now

| File                                                            | Tests | Action                                                                                                                                               |
| --------------------------------------------------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/src/renderer/ResourceManager.test.ts:27,58,79`        | 3     | Patch `pixiMock.ts` to give `Texture.from` a `destroy: vi.fn()` and `source: { destroy: vi.fn() }` — the texture leak guard is too important to lose |
| `apps/web/src/renderer/playTransition.test.ts:220`              | 1     | Magic-Move pairing test — THE regression guard for the snap-final-state bug we just fixed in Tier 2-C                                                |
| `apps/web/src/state/useMediaUpload.test.tsx:476,552`            | 2     | Transcode poll lifecycle + cancel-during-finalizing timer cleanup — leak prevention                                                                  |
| ~~`Inspector.componentInstance.test.tsx`~~                      | ~~5~~ | Replaced in Tier A.4; the file went with component instances on 2026-05-15 (`c99f88b`)                                                               |
| `apps/web/src/ui/FillTokenTab.test.tsx:212,223,232,250,369,389` | 6     | Token resolution + style detach — real mutation-payload assertions, not labels                                                                       |
| `apps/web/src/state/useSlideThumbnails.test.tsx:195,229,302`    | 3     | Debounce semantics + multi-id fan-out — pure timer/state logic                                                                                       |
| `apps/web/src/pages/FoldersHome.test.tsx:224`                   | 1     | 409 error-modal handling — real branch logic                                                                                                         |

### Replace with e2e

| File                                                     | Tests | Where the e2e lives / belongs                           |
| -------------------------------------------------------- | ----- | ------------------------------------------------------- |
| `apps/web/src/ui/Toolbar.test.tsx:177,185,193,246,262`   | 5     | `apps/web/e2e/keyboard-shortcuts.spec.ts` (TODO)        |
| ~~`apps/web/src/ui/SlidesPanel.test.tsx:286,301`~~       | ~~2~~ | Removed in 0.10.2 — `keyboard-shortcuts.spec.ts`        |
| `apps/web/src/components/PresentLayout.test.tsx:317-423` | 7     | `apps/web/e2e/present-layout.spec.ts` (extend existing) |
| `apps/web/src/ui/UploadDropZone.test.tsx:124,160,193`    | 3     | `apps/web/e2e/image-upload.spec.ts` (extend existing)   |
| `apps/web/src/pages/FoldersHome.test.tsx:197`            | 1     | New `e2e/folder-mgmt.spec.ts` for delete-via-kebab flow |
| `apps/web/src/ui/Inspector.test.tsx:559`                 | 1     | Multi-select placeholder — `inspector-flows.spec.ts`    |

### Delete

| File                                                         | Tests | Reason                                               |
| ------------------------------------------------------------ | ----- | ---------------------------------------------------- |
| `apps/web/src/ui/Inspector.test.tsx` (label-presence subset) | ~7    | Pure DOM presence — covered by sampled-thumbnail e2e |
| `apps/web/src/ui/Toolbar.test.tsx:129,148,161`               | 3     | "Has button with name foo"                           |
| `apps/web/src/ui/SlidesPanel.test.tsx:169`                   | 1     | CSS class assertion                                  |

## Critical-path coverage gaps

State after Tier A–C below (updated 2026-09-30; the table was written
before them and listed the tests they added as next steps).

| Gap                                  | Status                                                                                                                                | Next test                                                                  |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Real-time collab convergence         | Covered: `packages/slide-model/src/convergence.property.test.ts` (Tier B.1) and `apps/web/e2e/multi-client-collab.spec.ts` (Tier C.4) | — (planned as a load-test script, landed as the property test)             |
| Server resource leaks (Tier 2 fixes) | Covered: `apps/server/src/hocuspocus/lifecycle.test.ts` (Tier B.3)                                                                    | —                                                                          |
| Magic Move snap-final-state          | Covered: the `playTransition.test.ts:220` guard runs again (Tier A.2)                                                                 | —                                                                          |
| Bundle size budget                   | Covered: `size-limit` in `apps/web/package.json`, `just size` (Tier A.6)                                                              | —                                                                          |
| Visual regression for renderer       | Sampled-thumbnail e2e in `apps/web/e2e/renderer-visual.spec.ts` (Tier B.2); pixel-perfect baselines opt-in and not committed          | Generate and commit the baselines on a controlled machine                  |
| Performance budgets                  | Every `tests/load/*.ts` scenario fails on its thresholds; `runAll.mjs` warns on drift from a local baseline (Tier B.5)                | Commit a baseline; `just load` is not part of `just ci`                    |
| Awareness throughput                 | `awarenessFlood.ts` fails above 100 ms average latency; no committed baseline                                                         | As above                                                                   |
| Procedural texture leak              | Known issue (memory note); no test (Tier C.1, deferred)                                                                               | Once shared procedural lifecycle lands: redraw 100× → texture count stable |

## Roadmap

### Tier A — completed ✅

All six items landed in commits on `main`:

1. ✅ **3 `ResourceManager.test.ts` skips fixed** — assertions updated to current `Assets.load({src,parser})` + `Assets.unload(url)` API. Texture leak guard restored.
2. ✅ **`playTransition.test.ts:220` fixed** — added `getMountedIds()` + `getNode()` to the fake SceneGraph. Magic-Move regression guard active.
3. ✅ **3 `useMediaUpload.test.tsx` skips fixed** — switched mock from `getHeader` to `getBody` (server now returns assetId in JSON body, browser CORS strips custom headers). All transcode-poll lifecycle assertions green.
4. ✅ **5 `Inspector.componentInstance.test.tsx` skips replaced** — original tests asserted obsolete UX (one row per master leaf). Replaced with 4 tests against current contract (rows only for _modified_ leaves; clear-entry button dispatches mutation).
5. ✅ **12 dead DOM-presence skips deleted** — Inspector × 8 (label-presence section assertions), Toolbar × 3 (button presence + click), SlidesPanel × 1 (CSS class).
6. ✅ **`size-limit` wired in** at `apps/web/package.json`. Per-chunk + total-first-paint budgets. Run via `pnpm size`. Current floor:
   - Main app chunk: ≤ 210 KB gz (currently 188)
   - Pixi: ≤ 180 KB (currently 162)
   - React: ≤ 130 KB (currently 118)
   - Tiptap: ≤ 120 KB (currently 109)
   - Yjs: ≤ 45 KB (currently 37)
   - GSAP: ≤ 32 KB (currently 28)
   - hls.js: ≤ 170 KB (currently 161)
   - **Total first-paint: ≤ 800 KB** (currently 747)

### Tier B — completed ✅

All six items landed:

1. ✅ **Property-based CRDT convergence** — `packages/slide-model/src/convergence.property.test.ts`. fast-check generates arbitrary `Op[]` from {addSlide, removeSlide, addObject, updateObject, removeObject, moveObjectsLayer}; three properties asserted: disjoint+sync convergence (200 random sequences), three-client star topology (100), offline-then-reconnect (100). 400 random sequences total. The test caught a real subtlety on first run — `Y.encodeStateAsUpdate` is NOT canonical (clock entries serialise in insertion order, so byte-equal is not the right convergence test). The assertion is now structural deep-equality of `listSlides()` output.
2. ✅ **Visual regression** — `apps/web/e2e/renderer-visual.spec.ts`. Pragmatic two-tier:
   - **Sampled-thumbnail tests** (always-on): assert "rectangle paints inside its declared bbox not outside", "object added later renders on top of earlier object", "updating fill colour repaints". These read pixels out of the live thumbnail PNG — robust cross-platform.
   - **Pixel-perfect baselines** (opt-in via `RUN_VISUAL_BASELINES=1`): `expect(canvas).toHaveScreenshot()` for empty deck / rect / text. First-run baselines aren't committed — generate on a controlled machine when you adopt the workflow.
3. ✅ **Server lifecycle/leak test** — `apps/server/src/hocuspocus/lifecycle.test.ts`. Three properties: cache returns to zero after all connections close, opening+closing 50 docs sequentially keeps cache bounded (max observed ≤ 2 simultaneous), reopening the same doc reuses the cached entry while another connection is live. Validates the Tier 2-B `unloadImmediately:false` + `debounce:2000` settings.
4. ✅ **Keyboard-shortcut e2e** — `apps/web/e2e/keyboard-shortcuts.spec.ts`. Covers Toolbar (R/O/T/V/Shift+R/Shift+O/Shift+T), input-focus suppression (R while typing in inspector doesn't switch tool), Ctrl+Enter → present-mode URL, SlidesPanel (ArrowUp/Down through 3-slide deck), PresentLayout (ArrowRight/Space/PageDown advance, Esc exits).
5. ✅ **Performance budget regression tracking** — `tests/load/runAll.mjs` now compares against an optional `baselines.json` next to it; emits warnings when latency / size / sync time drifts > 20% even if absolute thresholds still pass. Template at `tests/load/baselines.example.json`. Threshold-breach exit-1 behaviour unchanged.
6. ✅ **FillTokenTab triage** — the 6 skipped tests asserted retired UX (the dedicated "Token" tab in the fill picker, replaced by token swatches inline in the colour-picker popover during M16-P8). Deleted with explicit comments pointing readers to the tokens unit tests in `slide-model` and the e2e replacement candidate in `inspector-flows.spec.ts`. 2 placeholder skips remain for the Detach-button rebind, clearly marked TODO.

### Tier C — completed (5 of 6) ✅

1. **Procedural-texture leak test** — ⏸ deferred. Blocked on the shared procedural-texture lifecycle landing (see memory note `procedural-texture-leak.md`). Add the test in the same PR that fixes the leak so they ship together.
2. ✅ **Destructive-flow e2e** — `apps/web/e2e/destructive-flows.spec.ts`. Five tests covering deck delete + share-link cascade, share-link revoke happy-path + IDOR-guard regression (Tier 1 fix), folder delete cascade, Drafts-folder protection.
3. ✅ **Mutation-testing pilot** — Stryker config at `packages/slide-model/stryker.config.json`. Run via `just mutate` (from the repo root, see the config's `root_comment`). Targets `mutations.ts` + `slides.ts` (highest-stakes files). HTML report → `reports/mutation/`. Threshold guidance: high=80%, low=60%, no break-build (informational; surface dead tests rather than gate).
4. ✅ **Multi-client e2e harness** — `apps/web/e2e/multi-client-collab.spec.ts`. Two scenarios: three browser contexts each adding slides + objects in parallel converge through real Hocuspocus sync; one context goes offline via `setOffline(true)`, peer makes changes, reconnect triggers Hocuspocus initial-sync handshake. Asserts deep-equal `listSlides()` snapshots across all contexts. The e2e analog to the unit-level CRDT property test from Tier B.1.
5. ✅ **Lighthouse CI** — `.lighthouserc.json` + `pnpm lighthouse` script. Audits the editor route on a built preview server. Budgets: performance ≥ 0.7, FCP < 2.5s, LCP < 4s, TBT < 600ms, CLS < 0.1, TTI < 5s. Currently `warn`-level (not `error`) so it's informational; promote after one or two PR cycles confirm CI stability.

## Environment traps

### Playwright has no browsers for Ubuntu 26.04

```
$ npx playwright install chromium
Failed to install browsers
Error: ERROR: Playwright does not support chromium on ubuntu26.04-x64
```

The ffmpeg download (needed for video capture) fails the same way. Verified on
`petronijus-PC` (Ubuntu 26.04.1 LTS) on 2026-09-09; `~/.cache/ms-playwright`
does not exist there. **A plain `pnpm --filter web test:e2e` therefore fails on
that machine.**

`apps/web/playwright.config.ts` carries the escape hatch, and `just e2e`
uses it by itself since 2026-09-30 (`tools/dev/playwright-env.sh`: system
Chrome and no video where Playwright's own Chromium is missing). By hand:

```bash
PLAYWRIGHT_USE_SYSTEM_CHROME=1 PLAYWRIGHT_NO_VIDEO=1 pnpm --filter web test:e2e
# or pin the binary:
PLAYWRIGHT_CHROME_EXECUTABLE=/usr/bin/google-chrome PLAYWRIGHT_NO_VIDEO=1 …
```

`PLAYWRIGHT_USE_SYSTEM_CHROME=1` → `channel: 'chrome'`;
`PLAYWRIGHT_NO_VIDEO=1` → `video: 'off'`. The 0.9.x diagnostic probes pinned
the same two settings per spec instead (`test.use({ channel: 'chrome', video:
'off' })`).

Whether the suite _passes_ with those vars set was not measured during the
0.9.x arc — do not claim it either way without running it. The durable fixes:
default to system Chrome when the bundled browser is absent, or run the suite
in a container with a supported base image.

### Known flaky unit tests

- `apps/server/src/services/editor.test.ts` — "ignores a state another
  user's connection forged under the caller's client id" failed once with
  "condition not met in time" during a full `pnpm -r test` on 2026-09-28,
  while the web and server suites ran in parallel. It passed 5/5 alone and
  in a full server-suite rerun (1,133 passed / 1 skipped). A wait-for timeout
  under load, not a regression; not fixed. Rerun the server suite before
  blaming your change.
- `multi-client-collab` e2e — flaky 2026-09-26 → 2026-10-14. Both tests
  drove their clients as soon as the test API existed, which arrives with
  the document (DeckShell) while the editor route (DeckEditor) is a
  separate lazy module still loading: three cold loads at once outran the
  15 s wait, and a client set offline mid-load failed the route import, so
  the error boundary unmounted its document. The spec now waits for the
  artboard and opens its clients one after another; 40/40 under 6
  workers.

### Diagnostic probes are not tests

A spec written to _measure_ production behaviour — not to assert a contract —
stays out of the committed suite until it becomes an assertion.
`apps/web/e2e/zoom-text-probe.spec.ts` is the
current example: it reads font faces, model-vs-measured text geometry and
artboard screenshots across a renderer-resolution change, driven by
`PROBE_DECK_ID` / `PROBE_SLIDE`. It is the starting point for the text-jump fix
described in
[`docs/handoff/0.9.x-production-hardening.md`](./handoff/0.9.x-production-hardening.md);
when that lands, the measurement becomes a real assertion or the probe is
deleted.

### Some defects are only reachable in production

Nine of the ten defects fixed in the 0.9.x arc were invisible to every local
suite, because the tunnel, the reverse proxy, the CSP and the minified build
exist only in production. No amount of unit or e2e coverage on `localhost`
would have caught them; the checks that did are `curl -sI` against the public
URL and a browser console on the deployed site. Both are listed under _How to
verify the current state_ in the 0.9.x handoff note.

## Maintaining this strategy

- New components SHOULD have a hook-level unit test if they have logic, an
  e2e if they have a multi-step interaction, and nothing in between.
- New Pixi renderers SHOULD NOT have unit tests asserting mock-call shapes.
  Add a sampled-thumbnail e2e instead — pattern in `inspector-flows.spec.ts`.
- New Yjs mutations MUST have unit tests in `packages/slide-model/src`.
- New slide-model writers MUST be reached by a command in `packages/commands`
  (or listed in `src/parity/knownMissing.ts` for an unfinished phase) — the
  parity test fails otherwise. A new command needs a ≥ 40-character model
  description, at least one example (the contract suite runs it), and the
  regenerated manifest (`pnpm capabilities`). The `agent-parity` agent
  reviews the rest (ADR 0010).
- New keyboard shortcuts, menu items and toolbar buttons MUST name an
  action of `apps/web/src/actions/catalog.ts` (`action` on the binding or
  the menu item, `data-action` on a toolbar button). The action lists the
  commands that carry its effect, or says why it is editor-only;
  `actions/catalog.test.ts` and the typecheck fail otherwise (since A2.13,
  2026-09-30).
- Commands must check every precondition before their first write: the
  contract suite runs each one against missing ids and asserts the document
  is byte-for-byte unchanged. (Byte equality is right here because nothing
  was written; everywhere else compare `listSlides()` structurally.)
- New Hocuspocus extensions MUST have a lifecycle test (open/close/leak).
- When you find yourself writing `getByText('Fill')`, stop. Use a
  `data-testid` AND/OR an e2e instead.

## How Claude uses this suite

Coding agents read [`/AGENTS.md`](../AGENTS.md) on every conversation
(Claude Code through `CLAUDE.md`, which imports it; until 2026-09-30 the
table lived in CLAUDE.md itself). Its "When to run what" table maps "files
you touched" → "what else to run" on top of `just check`, which the Claude
Code Stop hook (narrowed to the packages a change reaches, `just
check-affected`, since 2026-10-12) and the pre-push hook run by themselves. It is the operating
contract for autonomous changes; update it when you add a new test target
or retire an existing one. Examples of the policy:

- Edit anything → `just check` (always; the pre-push hook runs it, the Stop
  hook its affected lane).
- Touch the renderer → also run `renderer-visual` + `inspector-flows` e2e.
- Touch Yjs mutations → also run the property-based CRDT test +
  `multi-client-collab` e2e.
- Touch `packages/commands`, slide-model exports, or a UI write path → run
  `pnpm --filter @narrative/commands test` (parity + contract + manifest).
  Add or change a server route → `pnpm --filter server test` (route guard).
  (the policy has carried this row since A0 — in CLAUDE.md until 2026-09-30, AGENTS.md since; was noted here as missing.)
- Touch playbooks, MCP prompts/instructions or a command's description,
  schema or examples → `pnpm agent:eval` (real headless Claude Code, costs
  subscription usage: $1.62 list-price equivalent for a full run on
  2026-09-28 with ToolSearch on, was ≈ 2 USD without it); refresh recordings with
  `pnpm agent:eval --record` when a scenario or command behaviour changes on
  purpose. The policy has this row as of A1 (AGENTS.md since 2026-09-30).
- Touch bundle entry points / dynamic imports → also run `pnpm size`.
- Touch perf-sensitive paths → also run `pnpm load:all` (compares
  against a local `tests/load/` `baselines.json` when there is one).

The slow gates (`pnpm lighthouse`, Stryker `mutate`, the full
`pnpm agent:eval`) are NOT auto-run per change — they belong before a
release (and `agent:eval` after the guidance changes above).

Nothing runs any of this automatically: **there is no CI** (was GitHub Actions
on every push and PR, removed 2026-09-07 — commit `573ba64` — after both
workflows had been red since 2026-06-17 on a pnpm version conflict). The
baseline (`just check`) is enforced by the pre-push hook and Claude Code's
Stop hook since 2026-09-30; the rest of the policy in `AGENTS.md` is honoured
by convention, not by a machine. If a command cannot run (port collision, missing
service, the Playwright trap above), say so explicitly in the update — do not
silently skip it.
