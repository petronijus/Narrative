# Narrative — Build Plan

Handoff document for Claude Code. Read this fully before starting.

## Project overview

Self-hosted collaborative presentation tool with Keynote-level animations, heavy media support, and AI-native editing. Built incrementally, final stack from day one.

**Target users**: teams of up to 15 concurrent editors per deck.
**Deployment**: self-hosted on Proxmox via Docker Compose.
**Developer context**: solo developer, learning-as-building, AI-assisted workflow. Weekend/evening cadence. Long-running project, not a sprint. Clean code over speed; stable milestones over broad features.

## Tech stack (final, from M0)

- **Frontend**: React 18 + TypeScript (strict) + Vite + Tailwind CSS
- **Canvas renderer**: PixiJS v8 (WebGL/WebGPU)
- **Animation runtime**: **GSAP + GSAP Flip plugin** (free since 2024 after Webflow acquisition, including all plugins). Wrapped behind a custom JSON DSL compiler → swappable.
- **Animation editor UX inspiration**: Theatre.js Studio as reference pattern for M14 timeline panel (not a runtime dependency).
- **Realtime sync**: Yjs + Hocuspocus (WebSocket)
- **Backend**: Node.js + Fastify, TypeScript. API + Hocuspocus in one app (`apps/server`), split only when needed.
- **Database**: Postgres (metadata + Yjs persistence via Hocuspocus extension)
- **Object storage**: MinIO (S3-compatible)
- **Media pipeline**: tus.io uploads, ffmpeg workers via BullMQ + Redis, imgproxy
- **Auth**: Google OIDC (ID-token validation against Google's JWKS, email/domain allowlist) — added in M10. Agents: personal access tokens (`nrt_`, hashed, expiring) and Narrative as its own OAuth 2.1 authorization server for MCP clients (agentic A1, 2026-09-27, released in 0.10.0; [`docs/mcp.md`](./docs/mcp.md))
- **AI**: none in-process — agents drive Narrative over MCP from the user's own Claude client; no Anthropic SDK, key or bill ([ADR 0011](./docs/adr/0011-agent-execution-over-mcp.md), 2026-09-26; was: Anthropic API with Claude Sonnet for generation). Agent input is validated with zod (`packages/shared/src/schema`, added in A0).
- **Reverse proxy**: Caddy (automatic TLS)
- **Deploy**: Docker Compose on Proxmox LXC/VM, ZFS for storage
- **Observability**: Sentry + basic metrics from M6, full Prometheus in M30
  (the milestone was renumbered when M29 was repurposed for the TableObject)

## Working principles

1. **Final stack from M0.** No throwaway technologies. Each milestone builds on previous code without rewrites of foundations.
2. **State is single source of truth.** Yjs from M2. PixiJS renders diffs. Never mutate Pixi objects as primary state.
3. **TypeScript strict mode.** No `any` without justification comment.
4. **Git commits per logical unit.** Conventional Commits.
5. **Each milestone ends with:** working demo + tests for critical paths + CHANGELOG entry + **handoff document in `docs/handoff/`**.
6. **Deploy early (M4), not at the end.** Staging instance from M4 onward.
7. **ADRs in `docs/adr/`** for non-obvious architectural decisions.
8. **When in doubt, ask** before adding a dependency.
9. **Handoff after every milestone.** `docs/handoff/MXX-<name>.md` — to allow continuing on a different device.
10. **Language.** All project artifacts (code, comments, docs, commits, ADRs, handoffs) in English. Conversation with the developer stays in Czech.

## Repository structure (target)

```
/
├── apps/
│   ├── web/              # React frontend
│   ├── server/           # API + Hocuspocus in one app (split when it hurts)
│   └── workers/          # ffmpeg, AI workers (added in M12)
├── packages/
│   ├── shared/           # Shared types (slide model, object types)
│   ├── slide-model/      # Object type registry, Yjs bindings
│   ├── animation/        # JSON DSL + GSAP compiler + timeline runtime
│   ├── commands/         # Capability registry — the only writer (ADR 0010, agentic A0)
│   └── ui/               # Reusable UI primitives
├── infra/
│   ├── docker-compose.yml
│   ├── caddy/
│   └── scripts/
├── docs/
│   ├── adr/              # Architecture Decision Records
│   ├── handoff/          # Per-milestone handoff docs
│   └── milestones/       # Per-milestone notes
└── README.md
```

pnpm workspaces monorepo from M0. Turborepo optional (add when build times hurt).

---

## Key architectural decisions

### Three pillars validated in the first ~6 milestones

1. **Scene graph + resource manager** (M1) — lifecycle for textures, video frames, Lottie rasters, 3D render targets. One central manager from the start.
2. **Yjs-backed state + object type registry** (M2–M3) — plugin boundary from the start. `registerObjectType({ type, render, hitTest, defaultProps, inspector, schema })`.
3. **Animation engine: JSON DSL → GSAP compiler** (M6) — DSL is the only animation model from day one. No preset-then-DSL migration later.

### Edit mode vs. Present mode

One renderer, two modes. Present mode has its own entry point but shares the scene graph + resource manager. Separate mode stack (input handling, UI chrome), shared render stack. Validated in M5.

### DOM overlay over Pixi canvas

Solved once in M2 as a "layered compositor" primitive. Used for text edit (M2), present-mode video (M12), iframe (M24), Lottie (M25). Positioning + event routing solved once, then reused.

### Mixed-target animation pipeline

The animation engine can target both Pixi objects and DOM overlay objects in the same timeline. First-class concern from M6. Example: text letter-by-letter animation in the DOM + a shape fadeIn in Pixi in the same sequence.

### Server-side Yjs strategy

Agents write on the server: a ServerHost runs registry commands against `hocuspocus.openDirectConnection(deckId)`, after its own access check, in one transaction per command or batch with `agentOrigin(runId)` ([ADR 0011](./docs/adr/0011-agent-execution-over-mcp.md); built in A1, `apps/server/src/agent/serverHost.ts`, which also opens `component:<id>` to edit a component master). Every write, human or agent, goes through `packages/commands` ([ADR 0010](./docs/adr/0010-command-layer-is-the-only-writer.md)) — agents already do; the editor dispatches commands through `useCommand()` surface by surface as A2 migrates it (since 2026-09-28; 10 files still write directly after A2.10 (2026-09-29; was 13 after A2.9), listed in `apps/web/eslint.one-door.js` `ONE_DOOR_PENDING`). (Was: "direct Y.Doc manipulation in Node for AI slide generation (M16)"; superseded 2026-09-26.)

---

## Phase −1: Architectural spikes (before M0)

Three weekends, throwaway code, validation of the riskiest unknowns:

**Spike A — GSAP + Pixi performance.** Do 50 parallel tweens hold 60 fps? `gsap.timeline()` with 10 sequential animations + nested timelines — does it work cleanly? Flip plugin on 20 objects during slide transition?

**Spike B — Yjs scale.** 15 peers × 30 Hz awareness + 5 editors writing concurrently. Does scene diff keep up? How much network traffic?

**Spike C — DOM overlay + Pixi event routing.** DOM text input over a Pixi text object during zoom/pan. Event routing, focus, keyboard shortcuts. How clean does it get?

If any spike fails → change the stack **now**, not in M20.

---

## Where the project stands (2026-09-30)

M0–M13 and M28–M29 have shipped. M14–M27 are the open feature roadmap; the AI
milestones are replaced by the agentic plan (below). Since 2026-09-07 work has
been cut as point releases rather than milestones. Deployed: **v0.10.13**
(2026-09-30) — agentic A0 + A1 and A2.1–A2.11 (A2.11, text through
commands, in 0.10.13; A2.9–A2.10 in 0.10.12 the day before).

| Release         | Date                    | Subject                                                                                                                                                                          |
| --------------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0.9.0           | 2026-09-07              | five production-only defects behind Cloudflare Tunnel + the production CSP; GHCR image pipeline; GitHub Actions removed                                                          |
| 0.9.1           | 2026-09-08              | .pptx import: theme fonts + placeholder geometry inheritance                                                                                                                     |
| 0.9.2           | 2026-09-09              | repaint the canvas when a hidden tab becomes visible                                                                                                                             |
| 0.9.3           | 2026-09-09              | version guard — a browser on a stale cached `index.html` reloads itself                                                                                                          |
| 0.9.4           | 2026-09-18              | CSP `data:` for Pixi fonts + ImageBitmap probe; Caddy config mounted as a directory (was the "unreleased" row here until 2026-09-26)                                             |
| 0.9.5 – 0.9.24  | 2026-09-18 → 2026-09-23 | sidebar jump, text measurement and line height, .pptx import fidelity, append/drop into a deck, slide range selection, bullets                                                   |
| 0.9.25          | 2026-09-23              | PowerPoint import and export become one translation (ADR 0009)                                                                                                                   |
| 0.9.26 – 0.9.29 | 2026-09-24 → 2026-09-25 | per-paragraph line height, "no outline" from PowerPoint, deterministic export, slide duplicate (Mod+D) that draws                                                                |
| 0.10.0          | 2026-09-26              | **agentic layer A0**: command registry, zod schemas, parity guards (slide-model writers + server routes), and the editor bugs the survey found                                   |
| 0.10.0          | 2026-09-27              | **agentic layer A1**: personal access tokens + MCP OAuth, server host with runs / revert / audit log, 44 server commands, MCP server at `/api/mcp`, playbooks, `pnpm agent:eval` |
| 0.10.1          | 2026-09-28              | MCP tool list compacted ≈ 148 KB → ≈ 129 KB; agent eval runs with ToolSearch                                                                                                     |
| 0.10.2          | 2026-09-28              | **A2.1–A2.2**: one-door lint rule; the slides panel writes through commands                                                                                                      |
| 0.10.3 – 0.10.4 | 2026-09-28              | connecting Claude Code over MCP OAuth works (consent page referrer policy behind Cloudflare)                                                                                     |
| 0.10.5 – 0.10.9 | 2026-09-28              | **A2.3–A2.7**: guides, object creation and arrangement, transforms, paths and lines, copy / paste — each through commands                                                        |
| 0.10.10         | 2026-09-29              | **A2.7a**: agents upload local files (upload sessions); snapping can be switched off                                                                                             |
| 0.10.11         | 2026-09-29              | **A2.8**: gradients, shadows and the page-number field through commands                                                                                                          |
| 0.10.12         | 2026-09-29              | **A2.9–A2.10**: animations and tables through commands; triangles fill their box as in PowerPoint; table cell editor fixes                                                       |
| 0.10.13         | 2026-09-30              | **A2.11**: text through commands — `text.edit`, `text.replace`, `text.setBoxTypography`, `text.style.apply`; slide background pictures; paste fix                                |

Per-release detail lives in [CHANGELOG.md](./CHANGELOG.md).

Since 0.9.0 the release invariant is **git tag = package version = deployed
image tag** ([ADR 0008](./docs/adr/0008-release-and-image-tag-discipline.md)),
and the production CSP is treated as a hard renderer constraint
([ADR 0007](./docs/adr/0007-csp-as-a-renderer-constraint.md)).

**Read next**:
[`docs/plans/a2-extraction.md`](./docs/plans/a2-extraction.md) — the A2
steps, their decisions, and "Where we stand" (the next-steps list; A2.12
tokens, components and server propagation next). A1 — what it delivered, its release checklist and open
findings — is in
[`docs/handoff/A1-mcp-and-server-host.md`](./docs/handoff/A1-mcp-and-server-host.md).
A0 is in
[`docs/handoff/A0-agentic-foundations.md`](./docs/handoff/A0-agentic-foundations.md).
The 0.9.x production-hardening arc is in
[`docs/handoff/0.9.x-production-hardening.md`](./docs/handoff/0.9.x-production-hardening.md).

---

## Milestones

Each milestone is a shippable unit. Do not start the next one until the current one is committed, tested, has a CHANGELOG entry, and **a handoff document**.

### M0 — Foundation + CI/CD

Monorepo (pnpm workspaces). `apps/web` with Vite + React + TS strict + Tailwind. Empty `apps/server` skeleton. GitHub Actions: build + typecheck + test + lint on every push. Pre-commit hooks (husky + lint-staged). Local `docker-compose.yml` with Postgres for dev. README with setup instructions.

**Deliverable**: `pnpm dev` starts; CI green on an empty repo.

> **Superseded 2026-09-07**: GitHub Actions was removed entirely (commit
> `573ba64`) after both workflows had been red since 2026-06-17 on a pnpm
> version conflict. There is no `.github/` directory. The pre-commit hooks
> remain; the check gate is now local (`pnpm typecheck && pnpm lint && pnpm -r
test`) and codified in `CLAUDE.md`'s auto-run policy.

### M1 — Scene graph + resource manager

PixiJS v8 in a `<Canvas />` React component with proper mount/unmount lifecycle. **Resource manager** as a first-class primitive: central ownership of texture/asset lifecycles. One hardcoded rectangle rendered from a JSON definition. 3-pane layout: left sidebar, center canvas, right inspector. ADR-0001 (monorepo), ADR-0002 (renderer architecture).

**Deliverable**: empty canvas with one rectangle from data.

### M2 — Yjs from the start + object type registry + DOM overlay

Y.Doc in memory (no server yet). Slide = Y.Map, objects = Y.Array. `registerObjectType` registry with rectangle, ellipse, text types. All edits via `doc.transact()`. Y.UndoManager. Toolbar + canvas click creates an object. Pointer events for drag. **DOM overlay primitive** for text edit (positioning + focus management). Inspector shows editable properties.

**Deliverable**: single-user editor for shapes + text, CRDT-backed state, undo/redo.

### M3 — Renderer reconciler

Clean diff engine: Y.Doc state → PixiJS scene (add/update/remove). No direct mutations of Pixi objects from editing code. Observer layer on Y.Doc with batching. ADR-0003 (reconciler pattern).

**Deliverable**: same UX as M2, but with clean architecture. Ready for multiplayer.

### M4 — Hocuspocus sync + Postgres + first deploy

`apps/server` with Hocuspocus + Fastify API endpoint `/decks`. Hocuspocus persistence extension → Postgres. **First docker-compose setup** and deploy script to a staging server (hardcoded user, no auth). Frontend uses `HocuspocusProvider`. **MVP = sync between tabs/devices + online on a domain.**

**Deliverable**: **MVP — multi-tab sync, persistence, deployed.**

### M5 — Present mode MVP

Fullscreen present-mode route. Keyboard nav (Left/Right/Space/Esc). No editor chrome. No animations (yet). Forces edit/present architectural split early. Presenter view in a separate window (placeholder).

**Deliverable**: you can present static slides. Split mode stack confirmed.

### M6 — Animation engine (GSAP + DSL) + observability baseline

`packages/animation`: JSON DSL schema + compiler to `gsap.timeline()`. Runtime interpreter. Triggers: `onEnter`, `onClick`, `withPrevious`, `afterPrevious`. Mixed targets (Pixi + DOM overlay). Two presets as DSL factories: `fadeIn`, `slideIn`. Test: animations play in present mode. Sentry + basic metrics (FPS, Yjs update rate). Synthetic load script for continuous profiling.

**Deliverable**: animation engine. DSL is the only model from now on.

### M7 — Transform handles + multi-select + snapping

Resize handles (8 corners/edges) with Shift aspect lock. Rotation handle. Multi-select via drag rectangle + Shift-click. Group transforms. Smart guides (snap to grid, edges, centers of other objects, visible lines). Keyboard: Delete, Cmd/Ctrl+D, arrow nudge, undo/redo. **Figma-like object manipulation.**

**Deliverable**: full-featured editor.

### M8 — Awareness

Colored cursors per user (random color on join, stable per session). Selection highlights in user color. Avatar chips in the header. Cursor throttling at 30 Hz. Awareness payload: `{ name, color, selectedObjectIds, cursor: {x, y, slideId} }`.

**Deliverable**: visible collaborative presence.

### M9 — Multi-slide + transitions

Deck = Y.Array of slide Y.Maps. Sidebar with thumbnails (PixiJS renderToCanvas at 200 px). Add/delete/reorder (drag). Active slide = per-client state (not synced). **Slide transitions** (fade, push, cube, none) using the animation engine from M6. Per-slide setting.

**Deliverable**: full deck editing + transitions.

### M10 — Auth + permissions

Google OIDC sign-in (no self-hosted IdP). Per-deck permissions table (owner, editor, viewer). Sharing dialog. Public view-only share link with token.

**Deliverable**: multi-user system with permissions.

Two follow-up milestones below close gaps left from M10's first ship:

#### M10.1 — Server-driven session cookies (shipped 0.6.0–0.6.4)

Originally M10 used the browser-PKCE pattern from `oidc-client-ts`: SPA ran the full OAuth dance, held the Google `id_token` in `localStorage`, sent it as `Authorization: Bearer`, and refreshed via a hidden `prompt=none` iframe. That broke on Safari (third-party cookies blocked since 2020), Firefox strict ETP, and was on Chrome's deprecation roadmap. Sessions effectively capped at 1 hour.

Replaced with a server-driven OAuth + opaque session cookie:

- Server runs the OAuth dance (`/auth/start` → Google → `/auth/callback`).
- Session row in Postgres keyed by `SHA-256(cookie_value)`; raw id never lands in the DB.
- Browser holds only the `narrative_session` HttpOnly cookie.
- Sliding 30-day expiry; works in every browser identically.
- WebSocket auth via the same cookie on upgrade (Hocuspocus' `onAuthenticate` reads the cookie; client sends a sentinel `token: 'cookie'` to trigger the auth-frame). See ADR 0005.

#### M10.2 — Sharing rework (shipped 0.7.0)

M10 shipped the dialog with "invite by Google `sub`" — practically unusable because a `sub` is an opaque 21-digit number. M10.2 closes that gap:

- New `users` table: directory of every account that has logged in (sub, email, name). Populated on every `/auth/callback`.
- New `deck_invites` table: pending invites by email for users who haven't logged in yet. On their first OAuth callback the invite is consumed → permission row + invite marked accepted.
- Server: `POST /decks/:id/permissions` accepts `{ email, role }` and returns either `{kind:'granted'}` (existing user) or `{kind:'pending'}` (invite created).
- Server: `GET /decks/:id/permissions` enriched with `email`+`name` per row via a single IN-list join.
- Server: new `GET /decks/:id/invites` + `DELETE /decks/:id/invites/:inviteId`.
- Server: `/folders/:id/active-editors` enriched with the same `email`+`name` per editor.
- SPA: ShareDialog rewrites — invite by email with client-side validation, displays name+email, pending-invites section with cancel.
- SPA: ActiveEditorsBubbles uses initials from email/name, no more "1" for everyone.

### M11 — Image uploads

MinIO + tus-node-server in `apps/server`. Drag-and-drop onto the canvas. Progress UI. Non-blocking editor during upload. imgproxy service for on-the-fly variants (thumb 400w, display 1600w, original). Image object type uses imgproxy URLs by context.

**Deliverable**: images on slides, resumable uploads.

### M12 — Video support + preloading

BullMQ + Redis. `apps/workers/video` worker: ffmpeg generates HLS variants (360p/720p/1080p) + poster frame + thumbnail. Video object type: poster as a Pixi texture + play-icon overlay. In present mode: DOM overlay with hls.js video element positioned above the canvas. **Preloading pipeline**: before starting the presentation, scan media URLs → preload via Image()/manifest fetch → progress bar → IndexedDB cache. Fail gracefully (poster if HLS manifest fails).

**Deliverable**: video works, presentations don't stutter.

### M13 — Magic Move

**Manual flip pattern** (not the GSAP Flip plugin — that is DOM-only, verified in Spike A). Implementation: (1) snapshot transform state of Pixi objects from slide A, (2) immediately apply slide B's layout to the objects, (3) GSAP tween a proxy from the snapshot back to the target values. Match objects by ID across slides; non-matching fade out/in. DSL extension: `magicMove: true` per-transition. The GSAP Flip plugin remains for DOM overlay transitions (text, media placeholders above the canvas) as part of the mixed-target pipeline.

**Deliverable**: Keynote Magic Move feature.

### M14 — Animation timeline UI (inspired by Theatre.js Studio)

Timeline panel per slide. Drag-to-reorder. Visual delay/duration bars (drag to adjust). Trigger selector. Play button previews the entire slide sequence. Scrubbing (GSAP timeline seek). **Theatre.js Studio as design reference** — study the UX and transplant suitable patterns.

**Deliverable**: Keynote-like animation panel.

### M15 — Preset expansion + advanced animations

15 more presets as DSL factories: fadeOut, slideIn×4 directions, scaleIn/Out, rotateIn, bounceIn, flipIn, popIn, dissolveIn, wipeIn, zoomIn. Text-specific animations using the DOM overlay: letter-by-letter reveal, typewriter, word-by-word.

**Deliverable**: rich preset library.

### M16–M18 — AI (replaced by the agentic plan, 2026-09-26)

The three AI milestones that stood here (slide generation, per-slide
assistance, layout suggestions; renumbered M20–M22 in
`docs/handoff/polish-phase-plan.md`, while M16 was reused for folders,
tokens and components) are replaced by
**[`docs/plans/agentic-layer.md`](./docs/plans/agentic-layer.md)**.
All three goals are now covered there, along with:

- every capability callable by an agent through one command registry;
- an MCP server, so Claude Code and claude.ai drive Narrative (an in-app
  agent is deferred);
- Woodgrove style packs;
- a parity guard.

The plan runs in phases A0–A5:

1. **A0:** foundations. **Done 2026-09-26, released in 0.10.0** — see
   [`docs/handoff/A0-agentic-foundations.md`](./docs/handoff/A0-agentic-foundations.md).
2. **A1:** server host, identity and MCP. **Done 2026-09-27, released in
   0.10.0** — see [`docs/handoff/A1-mcp-and-server-host.md`](./docs/handoff/A1-mcp-and-server-host.md).
3. **A2:** extraction of web-only logic. **In progress** — A2.1–A2.8
   and A2.9–A2.11 released in 0.10.2–0.10.13 (A2.11 on 2026-09-30),
   A2.12–A2.13 open; see [`docs/plans/a2-extraction.md`](./docs/plans/a2-extraction.md).
4. **A3:** render worker (the agent can screenshot and see slides).
5. **A4:** style packs.
6. **A5:** deck builder and restyle.

**Deliverable**: an agent can do everything a user can, including
building a whole deck in a brand style.

### M19 — Speaker notes

Per-slide notes as Y.Text in the slide Y.Map. Notes panel (collapsible) in the editor. Rich text (bold, italic, lists, links) via Tiptap bound to Y.Text. Presenter view shows notes + current + next + timer.

**Deliverable**: notes system.

### M20 — Templates + themes

Theme = `{ colors, fonts, spacing }` at the deck level. Slide templates predefined in code (title, content, two-column, image+text, quote, section-divider). Template picker on new slide. "Apply theme" restyles all objects.

> Largely absorbed by the style packs of the agentic plan (phase A4:
> layouts and slots, furniture, `style.deck.applyPack`). Re-scope this
> milestone against it before starting.

**Deliverable**: design consistency.

### M21 — Comments + review

Comments as a Y.Array on the deck. Comment: `{ id, author, text, targetSlideId, targetObjectId?, resolved, thread: [...] }`. Pin indicators on the canvas. Comments panel. @mentions with a user picker. Notifications (email via SMTP + in-app).

**Deliverable**: review workflow.

### M22 — Version history

Snapshot the Y.Doc state every N edits or M minutes. Manual snapshot button. History view with timeline, diff view (what changed), one-click restore (creates a new snapshot first).

**Deliverable**: git-like history.

### M23 — Custom DSL editor

Monaco editor in the inspector (advanced tab) with JSON schema autocomplete for the animation DSL. Validation. Live preview. Power-user authoring.

**Deliverable**: advanced animation authoring. (The DSL already exists from M6; this is just UI.)

### M24 — Web embed (iframe)

Iframe object type. In the editor: placeholder with a screenshot from a backend Playwright service + URL label. In present mode: live iframe as a DOM overlay (same pattern as video). Sandbox attribute configurable per embed.

**Deliverable**: embedding web pages.

### M25 — Lottie

Lottie object type via the lottie-web renderer into an offscreen canvas → PixiJS texture. Upload .json files. Optional library browser for a built-in preset set.

**Deliverable**: Lottie animations.

### M26 — Three.js object type

Three.js scene as an object type. Offscreen WebGL canvas renders the Three scene, copied as a PixiJS texture every frame (or at reduced fps for perf). Scene config: `{ gltfUrl, camera, lights, autoRotate }`. Simple scene editor: import .glb, position camera. Optional: bind animations to slide-animation triggers.

**Deliverable**: 3D content on slides.

### M27 — Plugin system (public SDK)

Object type SDK as the public form of the registry that has existed since M2. `registerObjectType` documentation. Plugins in `packages/plugins/*`. Dynamic loading in the frontend. Built-in plugins for dogfooding: animated chart (chart lib), code block with syntax highlighting, static map (OSM static tiles).

**Deliverable**: extensible object system + 3 example plugins.

### M28 — PowerPoint import & export (shipped 2026-05-14)

Round-trip a deck between Narrative and Microsoft PowerPoint with acceptable fidelity for content-focused decks. Both flows run server-side: import via a tus upload + BullMQ worker that parses `.pptx` with `jszip` + `fast-xml-parser` and writes Yjs updates; export via a route that uses `pptxgenjs` and streams the result. **In MVP**: plain text frames, images, rect/ellipse/line shapes, slide backgrounds, position/size/rotation. **Tables** ship as exploded grids of `RectangleObject` + `TextObject` sharing a `groupId` — proper native table object lands in M29. **Deferred to follow-ups**: per-run text formatting, layouts/masters, theme tokens, charts, SmartArt, animations, transitions, video.

PDF / PNG export and view-only share link (the original M28 scope) move to their own follow-up milestone or stay parked. Video export remains parked.

**Plan**: `docs/plans/m28-pptx-import-export.md` — covers scope, library choices, data-model mapping, phases (spike → export MVP → import MVP → fidelity passes), and a Phase-1 spike that gates GO/NO-GO on the custom-parser approach.

**Deliverable**: drag-a-pptx-to-import + click-to-export. 80% fidelity for content decks. ✅

### M29 — First-class TableObject (shipped 2026-05-18)

Native `TableObject` in the slide model + editor. Users insert a table from the toolbar (10×10 grid picker), edit per-cell rich text inline, set per-cell / per-range / per-table style. Borders use a flat segment-keyed model so every grid line is a single value — no double-paint on shared edges. Inspector parity with the shape inspector (`IdentitySection` / `PositionSection` / `TypographySection` / `AnimationsSection` / `LayersPanel`). Linear / radial / image fills on tables via the shared `FillBody` + procedural-texture cache. Folder text-style presets bind to tables. Outer-rim alignment-inside trick + per-corner patches give clean Excel-style corners. M28's PPTX exploded-grid path still works during the migration; converting an exploded grid back into a `TableObject` is the next follow-up.

**Plan**: `docs/plans/m29-table-object.md`.
**Handoff**: `docs/handoff/0.8.0-table-object.md`.

**Deliverable**: insert / edit / collaborate on tables natively. ✅

### M30 — Performance + observability + polish

Profile with 50-slide decks, multiple videos, 15 concurrent editors (synthetic load script from M6, extended). Optimize hot paths: PixiJS scene diffing, Yjs update handling, awareness throttling, GSAP tween count. Prometheus metrics from server + workers. Structured logs (pino). Runbook in `docs/ops.md`. Backup scripts (Postgres pg_dump + MinIO mc mirror + ZFS snapshot).

(Was M29 in the original plan; renumbered after M29 was repurposed for the native TableObject.)

**Deliverable**: production-grade stability.

---

## Definition of done

- **M4** = MVP (sync + deployed)
- **M6** = animation engine complete, foundation solid
- **M12** = usable v1 (animations, video, live presentations)
- **M15** = rich preset library, product feels "luxurious"
- **M30** = feature-complete

## How to work with the developer

- Solo developer, learning web dev + AI-assisted.
- Wants **normal engineering collaboration**, not a tutorial.
- Briefly explain architectural choices when non-obvious.
- Do not add dependencies without mentioning them in the commit message with a one-line justification.
- Atomic commits. PR descriptions: what/why/how to verify.
- When stuck or facing ambiguous requirements → ask.
- Weekend/evening cadence — a session may end mid-milestone.
- **Handoff document** at the end of each completed milestone into `docs/handoff/MXX-<name>.md`. Contents: status, what was done, key decisions, how to verify, next step, known TODO, links. Enables continuation on another device.
- Always leave the repo in a compilable state with a clear next step.
- **Conversation language is Czech, but all code, comments, docs, and commits are English.**

## First task

**Phase −1 Spike A (GSAP + Pixi performance).** Throwaway project outside the monorepo. Validate:

- 50 parallel GSAP tweens on Pixi object properties → 60 fps?
- `gsap.timeline()` with 10 sequential animations + nested timelines → works cleanly?
- Flip plugin on 20 Pixi objects during a slide transition → acceptable latency?

If the spike is green → continue with Spike B (Yjs) + Spike C (DOM overlay).
If all three spikes are green → start M0.

**Stop and wait for confirmation after Spike A.** Write a handoff doc `docs/handoff/spike-a-gsap-pixi.md` before continuing.
