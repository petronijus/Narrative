# Narrative — instructions for coding agents

Narrative is a collaborative presentation editor (web, Pixi renderer, Yjs
documents over Hocuspocus) with an agentic layer: every user capability is a
command in `packages/commands`, which agents reach over MCP. This file is for
every coding agent (Claude Code, Cursor, Codex, …); humans start at
`README.md`.

Read before changing code: `docs/testing-strategy.md` (what the suites
cover), `docs/agents.md` (areas and their owners), `SETUP.md` (setup,
toolchain, troubleshooting). The agentic layer is planned in
`docs/plans/agentic-layer.md` (A0–A2 done); the status and next steps are
the "Where we stand" section of `docs/plans/a2-extraction.md`. Folder
sharing (folder roles, linked component media) is planned in
`docs/plans/folder-sharing.md` (ADR 0013); faster test loops in
`docs/plans/dev-speed.md`.

## Hard rules

- **State = Yjs only.** No parallel React state for object data. New
  mutations go in `packages/slide-model/src/mutations.ts`.
- **Every user capability is a command** (ADR 0010). A new mutation, route,
  control or object property also needs a command in `packages/commands`
  (zod input, model-quality description, runnable examples); agents reach
  Narrative only through that registry (MCP, ADR 0011). The parity guards
  fail the build otherwise; a capability deliberately not for agents goes in
  `packages/commands/src/parity/allowlist.ts` with a reason. The editor
  writes documents only through `useCommand()` (the one-door lint rule,
  `apps/web/eslint.one-door.js`; nothing pending since A2.13, 2026-09-30).
  Every shortcut, menu item and toolbar button names an action in
  `apps/web/src/actions/catalog.ts`: the commands that carry its effect,
  or why it is editor-only (`actions/catalog.test.ts`).
- **Object locks are editor-only.** `locked` stops canvas
  drag/resize/nudge/delete for a person; commands and agents ignore it.
- **Render = SceneGraph diff only.** No direct Pixi mutations outside
  `apps/web/src/renderer/`.
- **Animation = DSL only.** Compile through `packages/animation/`, never call
  GSAP from a component.
- **Custom upload metadata goes in the tus JSON body**, not headers (browser
  CORS strips custom `X-Narrative-*` headers).
- **Hocuspocus settings**: `unloadImmediately: false` + `debounce: 2000`
  (the lifecycle test enforces it).
- Documents are written on the server only through the sync server
  (`apps/server/src/services/liveDocs.ts`), never as rows under a loaded
  document; one-time document migrations go in
  `apps/server/src/services/dataMigrations.ts`.
- All code, comments, docs, logs, commit messages and UI strings are in
  English.
- Secrets: `.env` and `infra/.env.prod` are SOPS-encrypted in the private
  overlay (`scripts/secrets-decrypt.sh`, key in 1Password); never commit,
  print or log them.

## Commands

`just` is the only entry point; `just` alone lists every recipe. The recipes
wrap the pnpm scripts and add what the machine needs (the tsx loader for
ESLint on Ubuntu's Node, the system Chrome for Playwright on Ubuntu 26.04).

| Command                                  | What it does                                                                                                                      |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `just setup`                             | install dependencies and git hooks, check the toolchain                                                                           |
| `just check`                             | fast lane (~40 s): formatting, types, lint, docs check, every unit test (contract, parity, eval replays), the capability manifest |
| `just ci`                                | full gate: `check` + `integration` + `e2e` (needs `just dev`)                                                                     |
| `just fmt`                               | format everything (`tools/dev/format.sh`: ESLint --fix + Prettier)                                                                |
| `just test [pkg…]`                       | unit tests, all or some workspace packages (`just test server web`)                                                               |
| `just services` / `just dev`             | docker services / web :5173 + server :3001 (WebSocket :3002) + video worker                                                       |
| `just e2e [args]`                        | Playwright against the dev stack (`just e2e -g "folder-tokens"`)                                                                  |
| `just e2e-affected [--list]`             | the e2e specs the current change needs (the table below, as `tools/dev/e2e-affected.py`)                                          |
| `just eval [args]`                       | agent eval, headless Claude Code — costs subscription usage                                                                       |
| `just capabilities`                      | regenerate the capability manifest and the Claude Code plugin                                                                     |
| `just bump X.Y.Z` / `just deploy vX.Y.Z` | release versions / images, the tagged tree to the VM, deploy, verify (`docs/deploy.md`)                                           |

There is no hosted CI. `just ci` is the CI, run on the Linux desktop, the
MacBook or the Omarchy desktop; nothing gates a push but the pre-push hook
(`just check`). A change is done when `just check` is green plus the rows
below that match it.

## When to run what

| Files touched                                                                                                                         | Also run                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/commands/**`, or any new/changed user capability (control, shortcut, menu item, route, object property, slide-model export) | `just capabilities` (commit its output) and the `agent-parity` agent (plan §9, ADR 0010)                                                                                                           |
| `packages/commands/playbooks/**`, MCP prompts, command descriptions/schemas/examples                                                  | `just eval` (before a release too); `just eval --filter <id> --record` when a scenario or command behaviour changes on purpose (`tests/agent-eval/README.md`)                                      |
| Drizzle stores (`apps/server/src/**/*Store.ts`, `mcp/oauth/store.ts`, `agent/runStore.ts`), migrations                                | `just integration` (writes rows into the dev Postgres)                                                                                                                                             |
| `apps/web/src/renderer/**` or Pixi code                                                                                               | `just e2e -g "renderer-visual\|inspector-flows"`                                                                                                                                                   |
| `apps/web/src/ui/**`, `apps/web/src/components/**`                                                                                    | `just e2e -g "<feature>"`                                                                                                                                                                          |
| Keyboard shortcuts, focus scope, drag/drop                                                                                            | `just e2e -g "keyboard-shortcuts"`                                                                                                                                                                 |
| `apps/server/src/pptx/**`                                                                                                             | `just pptx-roundtrip <real deck>` — target 0 differences; **5 pre-existing on 2026-09-26** (0.9.26–0.9.29, not bisected): add none (`apps/server/src/pptx/README.md`)                              |
| Auth, sharing, folders, cascade-delete                                                                                                | `just e2e -g "destructive-flows"`                                                                                                                                                                  |
| Yjs mutations, Hocuspocus, sync                                                                                                       | `just e2e -g "multi-client-collab"` (**flaky since 2026-09-26**: "three clients … converge" failed 6/6 on clean 0.9.29 and 2/6 with A0 — compare with a clean baseline before blaming your change) |
| Bundle entry points, dynamic imports, vendor chunks                                                                                   | `just size` (**Tiptap chunk 12.6 kB over budget, pre-existing** — grow no chunk)                                                                                                                   |
| Hot edit / awareness / doc-growth paths                                                                                               | `just load` (warns on > 20% drift from a local `baselines.json`, copied from `tests/load/baselines.example.json` after a clean run)                                                                |
| Editor render path (FCP / LCP / TTI)                                                                                                  | `just lighthouse`                                                                                                                                                                                  |
| `packages/slide-model/src/{mutations,slides}.ts` deep changes                                                                         | `just mutate` — **broken since 2026-09-26** (`@stryker-mutator/vitest-runner` 8.x vs vitest 4): say so instead of skipping silently                                                                |

`just e2e-affected` runs the e2e part of this table for the working tree
(`--base REF` for a branch): the specs of every area a changed file belongs
to. A shared package, the schema or a source file no area claims runs the
whole suite, and names the file — add a new file's area to `AREAS` in
`tools/dev/e2e-affected.py` rather than living with full runs.

If a command does not exist or fails to start (port collision, missing
service), say so explicitly — never skip it silently. Specs seed their own
folders, decks and components through the API and delete them afterwards;
none may depend on data in a developer's database.

## What not to test

Deleted from the suite; do not re-introduce:

- DOM-presence component tests (`getByText('Fill')`,
  `toBeInTheDocument()`) — they break on every UI iteration and catch nothing.
- Pixi renderer unit tests asserting mock-call shapes — sampled-thumbnail
  e2e (`renderer-visual.spec.ts`, `inspector-flows.spec.ts`) replaced them.
- jsdom keyboard-shortcut tests — real keys belong in
  `keyboard-shortcuts.spec.ts`.
- CRDT byte-equality — `Y.encodeStateAsUpdate` is not canonical; compare
  `listSlides()` structurally.

27 web tests are `it.skip` with a rationale in the file (plus one each in
server and video-worker); ~6 have never been triaged. Do not un-skip without
reading the comment; a new skip says why in the file and updates this count.

## Layout

```
apps/web            React editor, Pixi renderer (src/renderer), e2e (e2e/)
apps/server         Fastify API, Hocuspocus, MCP server, services, drizzle/ migrations
apps/video-worker   ffmpeg transcoding (BullMQ)
packages/shared     object types and zod schemas
packages/slide-model  Yjs document model and writers
packages/commands   command registry, parity guards, playbooks, capability manifest
packages/animation  animation DSL and GSAP compiler
claude-plugin/      the generated `narrative` Claude Code plugin
tests/              agent eval (agent-eval/), load tests, fixtures
infra/              docker compose, deploy and build scripts
tools/dev/          formatter, docs check, git hook scripts, toolchain doctor
```

## Conventions

- Conventional Commits (`type(scope): summary`), enforced by the commit-msg
  hook; scopes name the area (`agentic`, `pptx`, `editor`, `renderer`,
  `server`, `infra`, `release`). `autosync(<branch>):` commits come from the
  ai-config project autosync and are left alone.
- **No pull requests — commit straight to `main`**; Petr is the only reviewer
  and reads the diff in the terminal. Never `--no-verify`, never force-push.
- **Commit only when Petr says so** ("commit", "push", "ship", "merge",
  "hotovo", "nasaď"); approval to build something is not approval to commit.
- Toolchain: Node ≥ 22.18, pnpm 9.15.4 (`packageManager`), Docker with
  compose, xmllint (PPTX schema tests), python3 ≥ 3.9 (hooks, docs check).
  `just doctor` checks them.
- Formatting is automatic (pre-commit hook): Prettier (`.prettierrc`) and
  `eslint --fix` for TypeScript.
- **Versions**: git tag = every package version = GHCR image tag =
  `/version.json` = the plugin's version. A release: `just bump X.Y.Z`, the
  CHANGELOG section, commit → verify the subject → tag → push in one chain,
  then `just deploy vX.Y.Z`. Production is VM 103 (`docs/deploy.md`: layout,
  access, rollback, the agentic layer's prod config); connecting to a prod
  host needs Petr's consent per host.

Details, per-OS setup and troubleshooting: `SETUP.md`.
