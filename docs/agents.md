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

| Agent            | Scope                                                                    | Key paths                                                                  |
| ---------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| `renderer`       | PixiJS scene graph, resource manager, reconciler, DOM overlay compositor | `apps/web/src/renderer/`                                                   |
| `state-sync`     | Yjs data model, object type registry, Hocuspocus server, persistence     | `packages/slide-model/`, `packages/shared/`, `apps/server/src/hocuspocus/` |
| `animation`      | JSON DSL, GSAP compiler, timeline runtime, mixed-target dispatch         | `packages/animation/`                                                      |
| `editor-ui`      | React editor shell, Tailwind UI, toolbar/inspector/panels, keyboard      | `apps/web/src/ui/`, `packages/ui/`                                         |
| `media`          | tus uploads, MinIO, imgproxy, ffmpeg workers, preloading                 | `apps/server/src/media/`, `apps/video-worker/`                             |
| `infra`          | Docker, Caddy, deploy + release pipeline, backups, observability         | `infra/`                                                                   |
| `ai-integration` | Anthropic SDK, tool use, streaming, server-side Yjs client for AI        | `apps/server/src/ai/`                                                      |

> `infra` no longer owns `.github/workflows/` — GitHub Actions was removed on
> 2026-09-07 (commit `573ba64`). It owns the GHCR build/push + pull-deploy
> pipeline instead (`infra/scripts/build-push.sh`, `infra/scripts/deploy.sh`).

## Quality agents (check; do not build features)

| Agent               | Scope                                                                                            |
| ------------------- | ------------------------------------------------------------------------------------------------ |
| `qa-tester`         | Unit/integration tests across packages, synthetic load, visual regression, performance baselines |
| `e2e-tester`        | Playwright specialist — reproduces visual/rendering bugs in a real browser, owns `apps/web/e2e/` |
| `code-reviewer`     | Reviews diffs against the architectural principles + code quality                                |
| `security-reviewer` | Security audit (XSS, auth, IDOR, SSRF, DoS, secret leakage, CSP)                                 |

## Docs agents

| Agent            | Scope                                                                                                                                                                   |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `narrative-docs` | Comprehensive doc sweep — reconciles the **whole** doc surface with the code after any significant success or notable failure. Writes the dated handoff notes and ADRs. |
| `docs-scribe`    | Narrower predecessor: a single ADR / CHANGELOG entry / README edit on request.                                                                                          |

Prefer `narrative-docs` when the question is "does the documentation still tell
the truth"; `docs-scribe` when a single, well-scoped document is wanted.

## Tech-lead (main thread)

- Decomposes a milestone into work packages.
- Dispatches build agents in parallel where packages are independent.
- Resolves conflicts between agents (e.g. renderer vs. state-sync boundaries).
- Approves an ADR draft before it is applied.
- Before a milestone closes: dispatches the quality agents
  (`qa-tester` → `code-reviewer` → `security-reviewer`, as relevant).
- After a milestone closes: dispatches `narrative-docs` for the handoff note.
- Writes results into the conversation history the user can see.

---

## Parallelisation patterns

### Fully parallel (independent packages in the same milestone)

Example from M6 (animation engine):

- `animation`: DSL + GSAP compiler + runtime
- `editor-ui`: timeline preview button + preset dropdown (UI only, calls the animation API)
- `infra`: Sentry integration + metrics baseline
- `qa-tester`: load-harness scaffold (after the animation milestone lands)

All start in the same session/worktree; integration at the end.

### Sequential (dependent)

Example from M4 (MVP):

1. `state-sync` finishes Hocuspocus + Postgres persistence.
2. `infra` adds it to docker-compose (depends on the env/volumes state-sync needs).
3. `infra` writes the deploy script.
4. `editor-ui` integrates `HocuspocusProvider` (needs the API from state-sync).
5. `qa-tester` verifies multi-tab sync and persistence across a restart.
6. `security-reviewer` reviews the WebSocket auth flow.
7. `narrative-docs` writes the M4 handoff.

### Quality gate before a milestone closes

Always in this order:

1. `qa-tester` — do the critical paths have tests? Did they pass? Load test OK?
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

| Zone                | Owner                         | What the others must not do                                                                                                                 |
| ------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Pixi scene graph    | `renderer`                    | Nobody calls Pixi directly. Everything through the renderer API.                                                                            |
| Y.Doc schema        | `state-sync`                  | Animation stores its DSL in the Y.Map per the state-sync schema; it does not invent its own storage.                                        |
| GSAP calls          | `animation`                   | No `import { gsap } from 'gsap'` outside `packages/animation`.                                                                              |
| docker-compose.yml  | `infra`                       | Others describe requirements (ports, volumes, env); infra integrates them.                                                                  |
| Env var schema      | `infra`                       | A feature owner announces the need for an env var; infra adds it to the schema and `.env.example`.                                          |
| The production CSP  | `infra` + `security-reviewer` | Nobody loosens a directive to make a library work without the ADR-0007 test: is there an eval-free / same-origin path in the library first? |
| Anthropic API calls | `ai-integration`              | No direct API client outside `apps/server/src/ai/`.                                                                                         |

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

- `docs/handoff/` — the primary resume point. Newest first; the 0.9.x note is
  the current one.
- `docs/adr/` — architectural memory (why, not what).
- `BUILD_PLAN.md` — where the project stands + the milestone roadmap.
- Claude user memory (`~/.claude/projects/-home-petronijus-Documents-Dev-Narrative/memory/`)
  — user preferences and persistent context across sessions. Maintained
  separately; documentation agents do not edit it.
- Git history + tags — what happened when, and what shipped.

A new session starts by reading:

1. The latest `docs/handoff/*.md`
2. `BUILD_PLAN.md` ("Where the project stands" + the next milestone)
3. The memory index (`MEMORY.md`)
4. The ADRs relevant to the upcoming work

Then it starts dispatching.
