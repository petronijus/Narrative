# Agent Orchestration — Narrative

How the specialised agents collaborate on the Narrative project. Each agent's
full brief lives in `.claude/agents/<name>.md`; this file is the map.

_(Rewritten in English 2026-09-09 — was Czech. Roster, ownership and the
memory path below were reconciled with `.claude/agents/` at the same time.)_

## Structure

```
                   ┌─────────────┐
                   │  tech-lead  │  (main thread — decides, integrates, resolves conflicts)
                   └──────┬──────┘
                          │ dispatches
        ┌─────────────────┼─────────────────┬──────────────┐
        │                 │                 │              │
   ┌────▼────┐      ┌─────▼──────┐    ┌─────▼─────┐   ┌────▼─────┐
   │  BUILD  │      │  QUALITY   │    │   DOCS    │   │   OPS    │
   │ agents  │      │  agents    │    │  agents   │   │  agent   │
   └─────────┘      └────────────┘    └───────────┘   └──────────┘
```

## Build agents (write production code)

| Agent            | Scope                                                                                                                                                                                                            | Key paths                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `renderer`       | PixiJS scene graph, resource manager, reconciler, DOM overlay compositor                                                                                                                                         | `apps/web/src/renderer/`                                                                                                                                                                                                                                                                                                                                                                                                         |
| `state-sync`     | Yjs data model, object type registry, Hocuspocus server, persistence, command registry core, the ServerHost, agent runs / origins / revert                                                                       | `packages/slide-model/`, `packages/shared/`, `packages/commands/`, `apps/server/src/hocuspocus/`, `apps/server/src/agent/`                                                                                                                                                                                                                                                                                                       |
| `animation`      | JSON DSL, GSAP compiler, timeline runtime, mixed-target dispatch                                                                                                                                                 | `packages/animation/`                                                                                                                                                                                                                                                                                                                                                                                                            |
| `editor-ui`      | React editor shell, Tailwind UI, toolbar/inspector/panels, keyboard                                                                                                                                              | `apps/web/src/ui/`, `apps/web/src/components/ui/`                                                                                                                                                                                                                                                                                                                                                                                |
| `media`          | tus uploads, MinIO, imgproxy, ffmpeg workers, preloading, agent file sources (URL / base64)                                                                                                                      | `apps/server/src/media/`, `apps/video-worker/`, `apps/server/src/services/{media,binarySource,downloadSlots}.ts`, `apps/server/src/net/`, the render worker: `apps/render-worker/`, `apps/server/src/render/`, `apps/server/src/services/render.ts`, `apps/server/src/routes/pngExport.ts` (the render page and its readiness, `apps/web/src/pages/DeckRender.tsx` and `renderer/{renderWork,settleScene}.ts`, are `renderer`'s) |
| `infra`          | Docker, Caddy, deploy + release pipeline, backups, observability                                                                                                                                                 | `infra/`                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `desktop`        | The Electron desktop app (ADR 0014): main process, preloads, sign-in deep links, native menu, opened files, packaging, signed self-updates; the bridge contract and the editor's side                            | `apps/desktop/`, `packages/shared/src/desktop.ts`, `apps/web/src/desktop/`, `apps/web/src/present/`, `infra/scripts/desktop-publish.sh`                                                                                                                                                                                                                                                                                          |
| `ai-integration` | Agent surface: MCP server, its OAuth authorization server, tool generation and schema compaction, confirmation over MCP, playbooks, MCP prompts/resources, the `narrative` skill generator, the agent eval suite | `apps/server/src/mcp/` (incl. `mcp/oauth/`), `packages/commands/playbooks/`, `packages/commands/src/playbooks/`, `packages/commands/scripts/skill.ts`, `tests/agent-eval/`                                                                                                                                                                                                                                                       |

> `infra` no longer owns `.github/workflows/` — GitHub Actions was removed on
> 2026-09-07 (commit `573ba64`). It owns the GHCR build/push + pull-deploy
> pipeline instead (`infra/scripts/build-push.sh`, `infra/scripts/deploy.sh`).

> `ai-integration` was repurposed on 2026-09-26 (was: in-app Anthropic SDK
> integration, planned under apps/server/src/ai/ and never built). Narrative runs no
> model; agents drive it over MCP from the user's own Claude client. See
> [`plans/agentic-layer.md`](./plans/agentic-layer.md).

### `packages/commands` — the command registry (agentic layer, from A0)

The single writer of document state and the capability source of truth
(ADR 0010). Every user-visible mutation is a `CommandDef` (zod input, role,
effects, undo policy, model-facing description, examples, handler); the
editor dispatches them through `useCommand()` (BrowserHost), agents through
the ServerHost over MCP (ADR 0011). Headless: no React, Pixi or DOM.

_State as of A2.13, A2 closed (2026-09-30; A2.12b and A2.13 uncommitted at the time, to ship as 0.10.15; A2.1–A2.12a released in 0.10.2–0.10.14): 129 commands (74 that
run in the browser or on the server, 55 server-only ones backed by
`apps/server/src/services/`, counted from the manifest's `hosts`; was 121 —
74 / 47 — at A2.11). Components go through the server since A2.12b
(`component.promote`, `component.stamp`, cross-document paste), and a
component owns its pictures and videos
([ADR 0012](./adr/0012-component-owned-media.md)). The editor dispatches commands through
`useCommand()` surface by surface — slides panel, guides, object creation,
transforms, paths, clipboard, fills and effects, animation, tables (chrome,
table Inspector, cell editor), and since A2.11 the whole Inspector
(Typography, lists, transition, background), the font pickers and the canvas
text editor (typing is one `text.edit` per input) — and the "one door" lint
rule (`apps/web/eslint.one-door.js`) bans slide-model writers and
`.transact()` in `apps/web/src` with no file pending: `ONE_DOOR_PENDING` has been
empty since A2.13 (1 after A2.12b, `state/testApi.ts`; 4 after A2.12a, 6
after A2.11, 10 after A2.10, 13 after A2.9). The dev-only e2e hook writes
through the registry too; only `state/testApiLegacyFixtures.ts` (legacy
`onEnter` animation steps) is exempt, in `ONE_DOOR_IGNORES`. Every
shortcut, menu item and toolbar button names an action of the action
catalog (`apps/web/src/actions/catalog.ts`, 82 actions): the commands that
carry its effect, or why it is editor-only. `knownMissing` holds 7 entries
(A3 5, A4 2), and `FINISHED_PHASES = ['A0', 'A1', 'A2']`. Commands that need the folder's font faces declare
`readsFolderFonts` and get `ctx.folderFonts` (server:
`apps/server/src/agent/folderFonts.ts`, from the folder's font assets). Progress
and next steps: [`plans/a2-extraction.md`](./plans/a2-extraction.md).
(Was, at A1, 2026-09-27: 94 commands — 50 document, 44 server-only — the
ServerHost, the MCP server and `POST /api/commands`, and no component
calling `useCommand()` —
[`handoff/A1-mcp-and-server-host.md`](./handoff/A1-mcp-and-server-host.md);
at A0: 50 commands, no ServerHost, no MCP server —
[`handoff/A0-agentic-foundations.md`](./handoff/A0-agentic-foundations.md).)_

- **Owner:** `state-sync` — the registry core, the hosts (BrowserHost, and
  the ServerHost in `apps/server/src/agent/` with runs, `agentOrigin`,
  per-run revert and the audit log), `ops.apply`, and the parity machinery in
  `src/parity/` (`parity.test.ts`, `allowlist.ts`, `knownMissing.ts`). A
  feature's commands are written by the agent building the feature, in the
  same change; a server command's domain logic lives in
  `apps/server/src/services/`, shared with the REST route for the same
  action (one implementation, two callers).
- **Around it (A1):** personal access tokens and the account kill switch
  (`apps/server/src/auth/{personalAccessTokens,agentCredentials,signInPolicy}.ts`)
  and rate limits (`apps/server/src/http/`) — reviewed by `security-reviewer`,
  env vars and Caddy routes integrated by `infra`; the Access tokens page,
  the Agent activity popover and the confirmation page — `editor-ui`.
- **Guarded by:** the parity test, the server route guard
  (`apps/server/src/routes/agentParity.test.ts`; every Fastify route claimed),
  the one-door lint rule, the action catalog test
  (`apps/web/src/actions/catalog.test.ts`, since A2.13),
  the schema coverage typecheck, per-command contract tests, the committed
  manifest (`capabilities.json`,
  `docs/capabilities.md`, regenerated with `just capabilities`), and the
  `agent-parity`
  agent.
- **Plan and phases (A0–A5):** [`plans/agentic-layer.md`](./plans/agentic-layer.md).

## Quality agents (check; do not build features)

| Agent               | Scope                                                                                                                                                                                                                |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test-runner`       | Every test lane (`just check`, `just test`, `just e2e`, `just integration`, load, eval): runs, diagnoses, writes tests; reproduces UI bugs in a real browser. Merged from `qa-tester` and `e2e-tester` on 2026-09-30 |
| `code-reviewer`     | Reviews diffs against the architectural principles + code quality                                                                                                                                                    |
| `security-reviewer` | Security audit (XSS, auth, IDOR, SSRF, DoS, secret leakage, CSP)                                                                                                                                                     |
| `agent-parity`      | Agentic coverage — every new capability, property, route or shortcut reaches the command registry (command, schema, examples, contract test, eval scenario, manifest); returns a ledger, never commits               |

Invoke `agent-parity` after any feature work, in the same breath as the
`narrative-docs` sweep.

## Docs agents

| Agent            | Scope                                                                                                                                                                   |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `narrative-docs` | Comprehensive doc sweep — reconciles the **whole** doc surface with the code after any significant success or notable failure. Writes the dated handoff notes and ADRs. |

`docs-scribe` (a single ADR / CHANGELOG entry on request) was folded into
`narrative-docs` on 2026-09-30, ADR and handoff formats included.

## Tech-lead (main thread)

- Decomposes a milestone into work packages.
- Dispatches build agents in parallel where packages are independent.
- Resolves conflicts between agents (e.g. renderer vs. state-sync boundaries).
- Approves an ADR draft before it is applied.
- Before a milestone closes: dispatches the quality agents
  (`test-runner` → `code-reviewer` → `security-reviewer`, as relevant).
- After feature work: dispatches `agent-parity` (agentic coverage) alongside
  `narrative-docs`.
- After a milestone closes: dispatches `narrative-docs` for the handoff note.
- Writes results into the conversation history the user can see.

---

## Parallelisation patterns

### Fully parallel (independent packages in the same milestone)

Example from M6 (animation engine):

- `animation`: DSL + GSAP compiler + runtime
- `editor-ui`: timeline preview button + preset dropdown (UI only, calls the animation API)
- `infra`: Sentry integration + metrics baseline
- `test-runner`: load-harness scaffold (after the animation milestone lands)

All start in the same session/worktree; integration at the end.

### Sequential (dependent)

Example from M4 (MVP):

1. `state-sync` finishes Hocuspocus + Postgres persistence.
2. `infra` adds it to docker-compose (depends on the env/volumes state-sync needs).
3. `infra` writes the deploy script.
4. `editor-ui` integrates `HocuspocusProvider` (needs the API from state-sync).
5. `test-runner` verifies multi-tab sync and persistence across a restart.
6. `security-reviewer` reviews the WebSocket auth flow.
7. `narrative-docs` writes the M4 handoff.

### Quality gate before a milestone closes

Always in this order:

1. `test-runner` — do the critical paths have tests? Did they pass? Load test OK?
2. `code-reviewer` — are the architectural principles respected?
3. `security-reviewer` — only if the milestone touches user-facing surface, auth, perms, media, AI or deploy.

If a quality agent flags a blocker → the tech-lead dispatches the relevant
build agent for a fix, not the docs agent for a handoff.

### Production verification (added 2026-09-07)

A change that touches uploads, the renderer's asset/font/worker paths, or
anything served by Caddy is **not verified by a green local suite**. Four
things exist only in production — the Cloudflare tunnel, the Caddy proxy, the
CSP, and the minified build + browser caching — and nine of the ten defects
fixed in the 0.9.x arc lived in exactly those gaps. Add a deployed-instance
check to the gate for such work:
`curl -s <domain>/version.json`, `curl -sI <domain>` for the CSP and
`Cache-Control`, and a browser console on the live site. See
[`handoff/0.9.x-production-hardening.md`](./handoff/0.9.x-production-hardening.md).

### Handoff routing

Once the quality gate is green:

1. Build agents send the tech-lead a short status (what they did, what they decided, what's next).
2. The tech-lead aggregates and dispatches `narrative-docs` with those inputs.
3. `narrative-docs` sweeps the doc surface and writes
   `docs/handoff/<version>-<topic>.md` (release-shaped work) or
   `docs/handoff/MXX-<topic>.md` (milestone work).
4. The tech-lead reviews; the **user** decides when to commit. Agents never
   commit or push.

---

## Conflict zones (settled in advance)

| Zone                | Owner                         | What the others must not do                                                                                                                                                                                                                                                                                                 |
| ------------------- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pixi scene graph    | `renderer`                    | Nobody calls Pixi directly. Everything through the renderer API.                                                                                                                                                                                                                                                            |
| Y.Doc schema        | `state-sync`                  | Animation stores its DSL in the Y.Map per the state-sync schema; it does not invent its own storage.                                                                                                                                                                                                                        |
| GSAP calls          | `animation`                   | No `import { gsap } from 'gsap'` outside `packages/animation`.                                                                                                                                                                                                                                                              |
| docker-compose.yml  | `infra`                       | Others describe requirements (ports, volumes, env); infra integrates them.                                                                                                                                                                                                                                                  |
| Env var schema      | `infra`                       | A feature owner announces the need for an env var; infra adds it to the schema and `.env.example`.                                                                                                                                                                                                                          |
| The production CSP  | `infra` + `security-reviewer` | Nobody loosens a directive to make a library work without the ADR-0007 test: is there an eval-free / same-origin path in the library first?                                                                                                                                                                                 |
| Document writes     | `packages/commands` owner     | Nobody writes a deck/folder/component doc outside a command: no slide-model writer or `doc.transact` in the UI (ADR 0010; lint-enforced over all of `apps/web/src` since A2.1, 2026-09-28; no exemption pending since A2.13, 2026-09-30, `apps/web/eslint.one-door.js` — was "per directory from A2 — no rule exists yet"). |
| Agent surface (MCP) | `ai-integration`              | No agent-facing tool or endpoint that bypasses the registry. No Anthropic API client in the repo (in-app agent deferred, plan §13).                                                                                                                                                                                         |
| Agent writes        | `state-sync` (ServerHost)     | Nobody opens `openDirectConnection` for an agent outside the ServerHost, and nothing accepts a token on the Hocuspocus WebSocket (ADR 0011): the host's access check, confirmation gate, run attribution and audit log are the only way in.                                                                                 |

---

## How the tech-lead calls an agent

Via the Claude Code `Agent` tool:

```
Agent(
  description: "Implement M6 DSL compiler",
  subagent_type: "animation",
  model: "opus",
  prompt: "...self-contained brief with full context..."
)
```

In parallel: several `Agent` invocations in one message block.

Every agent has its own context window and does not know the preceding
conversation — the tech-lead must supply all needed context in the prompt:
milestone goal, relevant ADRs, what other agents are doing concurrently, and
where the boundaries are. Per `CLAUDE.md`, sub-agents in this repo run on
**Opus**.

---

## Memory & handoff across sessions

- `docs/handoff/` — the primary resume point. The current one is
  `A1-mcp-and-server-host.md` (2026-09-27; was the 0.9.x note until the
  agentic layer began).
- `docs/adr/` — architectural memory (why, not what).
- `BUILD_PLAN.md` — where the project stands + the milestone roadmap.
- Claude user memory (`~/.claude/projects/-home-petronijus-Documents-Dev-Narrative/memory/`
  on Linux, `-Users-petronijus-Documents-Dev-Narrative` on the MacBook)
  — user preferences and persistent context across sessions. Maintained
  separately; documentation agents do not edit it.
- Git history + tags — what happened when, and what shipped.

A new session starts by reading:

1. The latest `docs/handoff/*.md`
2. `BUILD_PLAN.md` ("Where the project stands" + the next milestone)
3. The memory index (`MEMORY.md`)
4. The ADRs relevant to the upcoming work

Then it starts dispatching.
