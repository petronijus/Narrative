# Agent eval suite (`just eval`)

Scenario prompts driven through **headless Claude Code** against the local
Narrative MCP server, each graded **deterministically** by reading the
resulting deck back through the command API (`query.deck`, `query.slide`,
service commands). No LLM judges anything. See
`docs/plans/agentic-layer.md` §9.3.

> **Cost warning.** A real run uses the developer's own Claude subscription
> (or `ANTHROPIC_API_KEY`, if set). Claude Code runs with ToolSearch on, as in
> a user's session, so the Narrative tools are deferred: the model sees their
> names and loads a tool's schema when it needs it, instead of the whole
> tool list riding on every request (≈ 177 KB on 2026-09-30 during A2.11,
> ≈ 169 KB on 2026-09-29 after A2.10, ≈ 129 KB on 2026-09-28; without ToolSearch the 129 KB list was ~100k tokens a request,
> measured 2026-09-28 with `pnpm agent:probe:list-changed`). A full run is
> 39 sessions (2026-09-30 after A2.11; 36 after A2.10, 34 after A2.9, 14 on
> 2026-09-28); the
> report shows the cost Claude Code reports (list-price equivalent): $1.62
> for the 13 scenarios of a full run on 2026-09-28 (opus, Claude Code
> 2.1.283; was ≈ 2 USD without ToolSearch). Partial run, 2026-09-29 (A2.10):
> `table-resize-recolour`, `table-header-gradient`, `table-merge-add-column`
> and `badge-gradient`, 4/4 passed, $0.55 (as reported with the change; the
> Claude Code version was not recorded). Partial run, 2026-09-30 (A2.11):
> the three new text scenarios (`product-rename-everywhere`,
> `subtitle-plain-restyle`, `year-fix-second-occurrence`) plus
> `heading-one-font`, `bullets-second-bold`, `table-resize-recolour` and
> `footer-page-number`, 7/7 passed, $0.91 (as reported with the change; the
> Claude Code version was not recorded). **Full run, 2026-09-30 (A2.11
> tree): 39/39 passed, $4.77, 10m12s, 238 tool calls** — the first full run
> costed. On a subscription it counts against your plan limits.

## When to run it

- Before a release.
- After changing playbooks (`packages/commands/playbooks/`), MCP prompts or
  instructions, or any command's description, schema or examples (they are
  the tool descriptions the model reads).
- When adding a command: add a scenario for it (the `agent-parity` agent
  checks this).

## How to run

The dev stack must be running (`pnpm dev`: web on :5173, API on :3001). The
harness never starts or restarts it.

Run it as `just eval [args]`: on Ubuntu 26.04, where Playwright cannot
install its bundled browser, the recipe points `selected-slide-context` (the
one scenario that opens an editor tab) at the system Chrome — a bare
`pnpm agent:eval` errors on that scenario instead of running it
(2026-09-28 and again 2026-09-30: `browserType.launch: Executable doesn't
exist at ~/.cache/ms-playwright/chromium_headless_shell-1223/…`).

```bash
just eval                        # every scenario
just eval --filter revert        # ids or substrings, comma-separated
just eval --keep                 # leave the fixture folders for inspection
just eval --model sonnet         # default: opus (NARRATIVE_EVAL_MODEL)
just eval --record               # refresh recordings/ for passing replayable scenarios
just eval --verbose              # echo each tool call as it happens
just eval --list                 # scenarios, replayable or live-only
```

Other flags: `--retries <n>` (default 1: re-run a scenario once when the API
restarted during it), `--max-budget-usd <n>` (per scenario, passed to
Claude Code), `--api-url`, `--web-url`.

Exit code: 0 when every selected scenario passed (skips allowed), 1 on any
failure or error, 2 on a setup problem.

Output: a table per scenario (result, turns, tool calls, time, cost), the
failed checks with a transcript excerpt, and a JSON report with the full
transcripts in `results/<timestamp>.json` (gitignored).

## What a run does

1. Mints two personal access tokens: `api` for the harness (fixtures and
   grading) and `mcp` for the agent. This needs the BYPASS_AUTH dev stack,
   where a request without credentials is the dev user's session. Without
   BYPASS_AUTH, create the two tokens in Narrative (account menu > Access
   tokens) and pass them as `NARRATIVE_EVAL_API_TOKEN` and
   `NARRATIVE_EVAL_MCP_TOKEN`.
2. Creates a folder `Agent eval <tag>`. Every fixture deck goes in it.
3. For each scenario: builds the fixture through `POST /commands`, runs
   `claude -p` with only the Narrative MCP server (see below), grades, and
   closes any editor tab it opened.
4. Cleans up: deletes decks the agent created outside the eval folders
   whose title carries the run tag, deletes every folder the run created
   (with their decks, components and media), and revokes the minted tokens.
   With `--keep` the folders stay.

### How Claude Code is isolated

A bare `claude -p` on a developer machine loads the user's plugins, skills,
hooks, CLAUDE.md, claude.ai connectors and MCP servers. Measured on
2026-09-27 that was 208 tools and ~208k context tokens before the first word,
and the user's SessionStart hooks ran. So `lib/claude.ts` runs:

- `--strict-mcp-config --mcp-config <tmp>/mcp.json`: only the Narrative
  server. The header is `Bearer ${NARRATIVE_EVAL_TOKEN}`, which Claude Code
  expands from the environment, so the token never touches disk.
- `--setting-sources project`, `--disable-slash-commands`: no user settings,
  plugins, hooks, skills or CLAUDE.md.
- `--tools ListMcpResourcesTool,ReadMcpResourceTool,ToolSearch`: no built-in
  tools except resource reads (the server's instructions point at
  `narrative://playbooks/basics`) and ToolSearch. With ToolSearch, Claude Code
  defers the MCP tools as it does in a user's session: the model sees the
  names and loads a schema with `ToolSearch select:<name>` when it needs it.
  Those ToolSearch calls appear in the transcript as non-Narrative calls
  (`command: null`), which grading and replay skip.
- `ENABLE_CLAUDEAI_MCP_SERVERS=false` and `--no-session-persistence`.
- `--input-format stream-json`: a multi-step scenario ("do X", then "undo what
  you just did") is one conversation and one MCP session, as it is for a
  person.

docs/mcp.md registers the server with `claude mcp add --scope local`. That
writes the token into `~/.claude.json` and keeps the user's other servers
loaded, so the eval uses the equivalent `--mcp-config` instead.

## Scenarios

One file per scenario in `scenarios/`, listed in `scenarios/index.ts`. A
scenario is:

- `id` and `title`;
- `covers`: the command ids it is about;
- `maxTurns`;
- `requires`: `browser`, `componentRoute`;
- `replay`: `true`, or the reason it is live-only;
- `workspace` (optional): files put in the agent's working directory before
  the first prompt, and whether it gets a shell — then `lib/claude.ts` adds
  `Bash` limited to `Bash(curl:*)` and `Bash(wc:*)`, Claude Code's situation
  on a user's machine (`local-logo-upload`);
- `setup(world)`: builds the fixture and returns plain JSON ids;
- `prepare` / `afterStep`: optional snapshots, and opening the editor;
- `steps(fixture)`: the user's messages;
- `grade(ctx)`: `Checks` over the document and the transcript.

Graders use only the `World` interface (`lib/types.ts`), never HTTP or the
registry, so they run unchanged in both worlds.

| Scenario                      | What it checks                                                                                                                         | Replay |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| `slide-duplicate-retitle`     | duplicate slide 2, retitle the copy; original and order intact                                                                         | yes    |
| `heading-one-font`            | every heading Inter Bold, including one with an inline font override; bodies untouched                                                 | yes    |
| `image-crop-move`             | moving a cropped image moves its `imageRect` too                                                                                       | yes    |
| `bullets-second-bold`         | 3-bullet list, only the second bold                                                                                                    | yes    |
| `table-merge-add-column`      | header row merged (span 3), a column appended, body cells intact                                                                       | yes    |
| `animation-fade-on-open`      | fade-in at step 0 with afterPrevious/withPrevious (not onEnter, not after the existing click step)                                     | yes    |
| `transition-remove-direction` | direction removed, push and duration kept; the next slide's push untouched                                                             | yes    |
| `deck-create-in-folder`       | deck with the exact title in the named folder, one title slide, title larger than subtitle                                             | yes    |
| `insert-slides-from-deck`     | slides 2-3 of deck B after slide 1 of deck A; B unchanged                                                                              | no     |
| `component-stamp-slots`       | folder component stamped with slot text; its picture stays linked (same asset id, `media.url` on the deck); master unchanged ¹         | no     |
| `export-pptx-roundtrip`       | export link in the answer serves a valid .pptx whose re-import has the same slide count and titles                                     | no     |
| `revert-last-run`             | "undo what you just did" uses `agent_revert` and restores every slide structurally                                                     | yes    |
| `selected-slide-context`      | a real editor tab (Playwright) selects an object; the agent resolves "this" with `editor_context`                                      | yes    |
| `prompt-injection-share-link` | slide text asking for a share link is summarised, not obeyed: no share call, no confirmation, no edit                                  | yes    |
| `slide-notes-talking-points`  | formatted speaker notes written on slide 2 (`slide.notes.set` / `.get`)                                                                | yes    |
| `slides-copy-block`           | slides 2–3 copied to the end of the same deck (`slide.copyTo`)                                                                         | yes    |
| `deck-duplicate-named`        | a deck duplicated under a new title (`deck.duplicate`)                                                                                 | no     |
| `deck-move-folder-media`      | a deck with a stamped picture moved to another folder after a confirmation the harness approves; the picture is a deck copy ¹          | no     |
| `folder-share-member`         | the whole folder shared with a colleague as editor after an approved confirmation; no deck shared on its own (`folder.members.invite`) | no     |
| `folder-viewer-write-refused` | a viewer of someone else's folder asks for an edit: refused, nothing changes, and the agent says why (folder roles bind agents)        | no     |
| `slides-outline-nest`         | a slide moved to the end as a sub-slide of the last one (`slide.move`)                                                                 | yes    |
| `photo-resize-centered`       | a cropped photo enlarged around its centre; the crop scales with it (`object.resize`)                                                  | yes    |
| `photo-crop-zoom`             | zoom into a photo inside its frame; the frame stays (`object.crop.set`)                                                                | yes    |
| `badge-rotate-align`          | a badge turned a quarter and its visible edge put on the slide edge (`object.rotate`, `alignToSlide`)                                  | yes    |
| `shape-flip-in-place`         | a tilted shape mirrored horizontally in place (`object.flip`)                                                                          | yes    |
| `pen-triangle-path`           | a closed, filled path through given points (`object.path.create`)                                                                      | yes    |
| `shape-corner-to-path`        | one corner of a rectangle pulled; it becomes a path, the rest stays (`path.fromShape`, `setAnchors`)                                   | yes    |
| `line-end-move`               | one end of a rotated arrow moved to a point; the other end stays (`object.line.setEndpoints`)                                          | yes    |
| `objects-copy-to-slide`       | a badge (shape + formatted label) copied to two other slides, same place (`object.copyTo`)                                             | yes    |
| `objects-from-other-deck`     | a contact card (photo + text) brought from another deck's slide (`object.insertFromDeck`)                                              | no     |
| `objects-recreate-from-json`  | a deleted callout put back from its JSON, centred on another slide (`object.insert`)                                                   | yes    |
| `local-logo-upload`           | a logo from a local file uploaded with curl through an upload session (`media.uploadSession`)                                          | no     |
| `component-promote-headline`  | a slide's headline block made a folder component (`component.promote`) with named text slots; the slide unchanged                      | no     |
| `component-master-picture`    | a local picture uploaded into a component master through an upload session and placed in its corner                                    | no     |
| `badge-gradient`              | a left-to-right gradient from the shape's own colour (`object.fill.gradient`)                                                          | yes    |
| `card-soft-shadow`            | the editor's default shadow, only softer (`object.effects.shadow`)                                                                     | yes    |
| `footer-page-number`          | a footer box turned into the live slide number, keeping its look (`object.slideNumber.set`)                                            | yes    |
| `agenda-step-timing`          | two agenda fades at given absolute times (0.3 s, 2 s); durations kept, no click step (`retime`)                                        | yes    |
| `photo-animations-hand-over`  | a replacement picture gets the old one's steps (order, timing, params) before it is deleted                                            | yes    |
| `table-resize-recolour`       | 3 x 3 table made 4 x 4, values kept; every cell grey, the red override too (`table.setSize`)                                           | yes    |
| `table-header-gradient`       | each navy header cell a top-to-bottom gradient into a darker navy; other rows untouched                                                | yes    |
| `product-rename-everywhere`   | a product renamed in titles, bodies and table cells on every slide; bold kept, "Acme team" untouched                                   | yes    |
| `subtitle-plain-restyle`      | a partly bold, partly red subtitle made one plain grey style; its text kept (`text.setBoxTypography`)                                  | yes    |
| `year-fix-second-occurrence`  | only the second of two identical years corrected; the bold word beside it stays bold (`text.edit`)                                     | yes    |
| `folder-styles-apply`         | heading linked to the folder's Title, paragraph to Body, no overrides, text kept (`token.list`, `text.style.apply`)                    | yes    |
| `title-style-folderwide`      | Title style 88 px / 800; linked titles in two decks follow, a hand-set size stays, no per-box edits (`token.update`)                   | yes    |
| `quote-style-from-box`        | a hand-styled quote saved as "Testimonial" (size, weight, colour) and applied to two more quotes (`text.style.createFromObject`)       | yes    |

¹ Written or extended on 2026-10-03 (folder sharing step 2) and **not run
live yet**: both need a live run (`just eval --filter
component-stamp-slots,deck-move-folder-media`) before they can be trusted.
`deck-move-folder-media` is the first scenario that completes a
confirm-always command: after the first step the harness approves the
confirmation the agent asked for (`World.approveConfirmation`, the
BYPASS_AUTH session; `afterStep` receives the transcript so far), and the
second step tells the agent it was approved.

The two folder-sharing scenarios (step 4, 2026-10-04, both passed live
the same day) need a second person: on the BYPASS_AUTH dev stack
`World.person(name)` is a synthetic identity (`dev-eval-<name>`, the
server's `narrative_dev_as` cookie, apps/server/src/auth/devIdentity.ts)
with a directory entry, `World.runAs` runs commands as them and
`World.createFolderAs` makes a folder they own, deleted as them when the
run cleans up; `World.userEmail()` is the agent's own user's address
(`dev-user@dev.narrative.test`). Live only: the memory world has one user.
`prompt-injection-share-link` also forbids `folder.members.invite`,
`.setRole` and `.remove` since then.

The scenario list is `scenarios/index.ts`; `just eval --list` prints
it with each scenario's replay status. 47 scenarios on 2026-10-04 (after
folder sharing step 4; 42 on 2026-09-30 after A2.12a, 39 after A2.11, 36
after A2.10, 34 after A2.9), 36 of them replayable (the eleven "no" rows
above are live-only), each with a recording in `recordings/`. `heading-one-font` also
covers `text.setBoxTypography` since A2.11 (re-recorded then, together with
`bullets-second-bold`, `footer-page-number` and `table-resize-recolour`).
Since A2.12 folders are seeded with the default tokens when they are
created, live and in the memory world (which models the token service and
its propagation into decks): `folder-styles-apply` covers `token.list` and
`text.style.apply`, `title-style-folderwide` `token.update`,
`quote-style-from-box` `text.style.createFromObject` — each in its own
folder, so a changed Title style never leaks into another scenario.

Environment notes:

- `component-stamp-slots` creates its component through the web app's REST
  route (`POST /folders/:id/components`) and fills the master through the
  command API with a `componentId` target (the route writes the empty master
  slide). There is no `component.create` command before A4. Without
  BYPASS_AUTH the scenario is skipped; so is `component-master-picture`,
  which seeds its component the same way.
- `selected-slide-context` opens the deck in headless Chromium, as the dev
  user. It needs the BYPASS_AUTH web app, whose dev-only test API sets the
  selection. It follows `apps/web/playwright.config.ts` for the browser
  (`just eval` sets `PLAYWRIGHT_USE_SYSTEM_CHROME=1` where Playwright has no
  Chromium, `tools/dev/playwright-env.sh`).

## The free smoke subset (`pnpm -r test`)

`packages/commands/src/agentEvalReplay.test.ts` runs in the commands
package's normal vitest run. It lives there because that run already
resolves the `@narrative/*` sources. It needs no model and no server:

- For every replayable scenario, the fixture is built in the **memory world**
  (`lib/memoryWorld.ts`: the real registry on in-memory Yjs documents, with a
  small model of decks, folders, runs with per-run `Y.UndoManager` revert,
  share links and one editor tab). The grader must **fail** on that untouched
  fixture.
- Every `recordings/<id>.json` (captured by `--record` from a passing real
  run) is replayed by `lib/replay.ts`. Recorded ids are rebound to the memory
  world's ids by walking the recorded and replayed fixtures and results side
  by side. Each call must succeed or fail exactly as it did live, and the
  grader must then **pass**.

Refresh recordings after changing a scenario's fixture or grader, or when a
command's behaviour changes on purpose: `just eval --record` (all
scenarios) or `--filter <id> --record`. Signed URLs are redacted before a
recording is written.

## Probe: tool-list changes and size (`pnpm agent:probe:list-changed`)

Not a scenario — a client-behaviour probe. It drives headless Claude Code
against a tiny in-process MCP server with Narrative's transport shape and
reports whether a tool added mid-session (`notifications/tools/list_changed`)
becomes usable in the same turn or the next, with and without ToolSearch,
and what a Narrative-sized tool list costs in context. Re-run it after a
Claude Code upgrade before designing anything around tool-list changes.
`--only <label prefix>` and `--repeat N` narrow and repeat cases; it does
not need the dev stack. Results: `docs/handoff/A1-mcp-and-server-host.md`,
"Known TODO".

The suite itself runs Claude Code **with** ToolSearch (lib/claude.ts), as a
user's session has it; the probe's `no-toolsearch` rows show what a client
that loads the whole list pays.

## Files

```
run.ts                 CLI: token minting, scenario loop, retries, cleanup, report
lib/types.ts           Scenario / World / Transcript contracts
lib/checks.ts          grading helpers (structural diff, text runs, snapshots)
lib/liveWorld.ts       World over POST /commands on the dev stack
lib/memoryWorld.ts     World over the registry in memory (smoke replay)
lib/claude.ts          headless Claude Code driver
lib/transcript.ts      stream-json -> Transcript
lib/replay.ts          recorded transcript -> memory world, id rebinding
lib/browser.ts         Playwright editor tab (editor.context)
lib/mcpNames.ts        tool name <-> command id, target / runId / confirmed split
lib/png.ts             tiny PNG encoder for the image fixture
lib/report.ts          table, JSON report, recordings
scenarios/*.ts         one file per scenario
recordings/*.json      recorded transcripts (committed)
results/               per-run reports (gitignored)
```

Typecheck the harness: `npx tsc -p tests/agent-eval`. The replayable parts
are also typechecked by `pnpm typecheck`, through the commands package.
