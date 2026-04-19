# Presentation Tool — Build Plan

Handoff document for Claude Code. Read this fully before starting.

## Project overview

A self-hosted, collaborative presentation tool with Keynote-level animations, heavy media support, and AI-native editing. Built incrementally, final stack from day one.

**Target users**: teams of up to 15 concurrent editors per deck.
**Deployment**: self-hosted on Proxmox via Docker Compose.
**Developer context**: solo developer, learning-as-building, AI-assisted workflow. Weekend/evening cadence. This is a long-running project, not a sprint. Prioritize clean code over speed; shipping stable milestones over broad features.

## Tech stack (final, used from M0)

- **Frontend**: React 18 + TypeScript + Vite + Tailwind CSS
- **Canvas renderer**: PixiJS v8 (WebGL/WebGPU)
- **Animations**: Motion (MIT, ex-Framer Motion), custom JSON DSL in later milestones
- **Realtime sync**: Yjs + Hocuspocus (WebSocket)
- **Backend API**: Node.js + Fastify (or Hono), TypeScript
- **Database**: Postgres (metadata, Yjs persistence via Hocuspocus extension)
- **Object storage**: MinIO (S3-compatible)
- **Media pipeline**: tus.io uploads, ffmpeg workers via BullMQ + Redis, imgproxy
- **Auth**: Authentik (OIDC) — added in M10
- **AI**: Anthropic API (primary), Claude Sonnet for generation tasks
- **Reverse proxy**: Caddy (automatic TLS)
- **Deploy**: Docker Compose on Proxmox LXC/VM, ZFS for storage
- **Observability**: Sentry + Prometheus + structured logs (added in M32)

## Working principles

1. **Final stack from M0.** No throwaway technologies. Every milestone builds on previous code without rewrites of foundations.
2. **Data model is the single source of truth.** PixiJS renders from state; state is Yjs-backed from M4 onward. Never mutate PixiJS objects directly as primary state.
3. **TypeScript strict mode everywhere.** No `any` without justification comment.
4. **Git commits per logical unit.** Conventional Commits format. PR-sized commits even on main.
5. **Each milestone ends with: working demo + tests for critical paths + short CHANGELOG entry.**
6. **Deploy early (M12), not at the end.** Staging instance from M12 onward.
7. **Explain architectural decisions inline as ADR comments** in `/docs/adr/` when making non-obvious choices.
8. **When in doubt, ask the developer before adding dependencies.** Keep the dependency tree lean.

## Repository structure (target)

```
/
├── apps/
│   ├── web/              # React frontend
│   ├── api/              # REST API (metadata, auth, AI)
│   ├── hocuspocus/       # Yjs sync server
│   └── workers/          # ffmpeg, imgproxy glue, AI workers
├── packages/
│   ├── shared/           # Shared types (slide model, object types)
│   ├── slide-model/      # Object types registry, Yjs bindings
│   └── ui/               # Reusable UI components
├── infra/
│   ├── docker-compose.yml
│   ├── caddy/
│   └── scripts/
├── docs/
│   ├── adr/              # Architecture Decision Records
│   └── milestones/       # Per-milestone notes
└── README.md
```

Set up as **pnpm workspaces monorepo** from M0. Turborepo optional (add if build times become a problem).

---

## Milestones

Each milestone is a shippable unit. Do not start the next one until the current one is committed, tested, and has a CHANGELOG entry.

### M0 — Foundation
Monorepo setup (pnpm workspaces). `apps/web` with Vite + React + TS + Tailwind. PixiJS mounted in a React component (`<Canvas />`) with proper lifecycle. Basic 3-pane layout: left sidebar (slides list placeholder), center canvas, right inspector placeholder. README with run instructions.

**Deliverable**: `pnpm dev` runs, empty PixiJS canvas renders in browser.

### M1 — Local editor (single-user, in-memory)
Toolbar with shape tools (rectangle, ellipse). Click canvas to create. Pointer events for drag. Single selection with visible selection outline. Delete key removes. Inspector panel shows x/y/w/h/fill of selected object, editable.

**Deliverable**: functional single-user shape editor.

### M2 — Text objects
Text as an object type. Double-click enters edit mode via DOM overlay positioned over the PixiJS text. Edit font size, weight, color, align in inspector. ESC or blur commits.

**Deliverable**: editor handles shapes + text.

### M3 — Data model refactor
Introduce typed slide state: `Slide { id, objects: SlideObject[] }`. `SlideObject` is discriminated union by `type`. Renderer diffs state → PixiJS scene (add/update/remove). All editing actions mutate state only. Create object type registry (`registerObjectType({ type, render, hitTest, defaultProps })`).

**Deliverable**: same UX as M2, clean architecture. Write ADR explaining the pattern.

### M4 — Yjs data layer
Replace plain state with Y.Doc. Slide is Y.Map, objects is Y.Array of Y.Maps. All edits via `doc.transact(() => ...)`. React binding layer observes Yjs and re-renders. Y.UndoManager for undo/redo (tracked origins = local user only).

**Deliverable**: CRDT-backed editor + undo/redo.

### M5 — Realtime sync (MVP)
`apps/hocuspocus` server with in-memory persistence. Frontend uses `HocuspocusProvider`. Room = one slide ID (hardcoded for now). Test with two browser tabs.

**Deliverable**: **MVP.** Multi-tab/multi-device sync, text + shapes.

### M6 — Multi-slide
Deck = Y.Array of slide Y.Maps. Sidebar shows thumbnails (render slide at 200px wide via PixiJS renderToCanvas). Add/delete/reorder slides. Active slide state per client (not synced). Drag-to-reorder.

**Deliverable**: full deck editing.

### M7 — Awareness
Colored cursors per user (random color on join, stable per session). Selection highlights with user color. Avatar chips in header. Cursor throttling at 30 Hz. Awareness user info: `{ name, color, selectedObjectIds }`.

**Deliverable**: visible collaboration presence.

### M8 — Transform handles and multi-select
Resize handles (8 corners/edges) with proper aspect ratio locking (Shift). Rotation handle. Snapping to grid and to other objects' edges/centers with smart guides (visible lines). Multi-select via drag rectangle and Shift-click. Group transformations. Keyboard: Delete, Cmd/Ctrl+D duplicate, arrow keys nudge, Cmd/Ctrl+Z/Y undo/redo.

**Deliverable**: Figma-like object manipulation.

### M9 — Persistence + Postgres
Hocuspocus persistence extension → Postgres (store Y.Doc updates). `apps/api` with Fastify: endpoints for list/create/delete decks. Deck metadata: id, title, owner, created_at, updated_at. Landing page with deck list (plain, no auth yet — use a hardcoded user).

**Deliverable**: persistent decks across restarts.

### M10 — Auth
Authentik in docker-compose. OIDC integration in API and Hocuspocus (validate JWT on WebSocket connect). Per-deck permissions table (owner, editor, viewer). Sharing dialog (invite by email/username).

**Deliverable**: multi-user system with permissions.

### M11 — Image uploads
MinIO in docker-compose. tus.io server (tus-node-server) integrated with API, writes to MinIO. Frontend: drag-and-drop onto canvas or toolbar upload button. Progress UI. imgproxy service for on-the-fly variants (thumbnail 400w, display 1600w, original). Image object type uses imgproxy URLs based on render context (thumbnail in sidebar, display on canvas, original for export).

**Deliverable**: images on slides, resumable uploads, no editor blocking on upload.

### M12 — Proxmox deployment
Single `docker-compose.yml` under `infra/`. Services: web (nginx static), api, hocuspocus, workers, postgres, minio, imgproxy, redis, authentik, caddy. Caddy auto-TLS. ZFS dataset mounted for Postgres data and MinIO. Backup script (Postgres pg_dump + MinIO mc mirror + ZFS snapshot). Document setup in `docs/deployment.md`.

**Deliverable**: production instance on the developer's domain.

### M13 — Present mode
Fullscreen view, no editor UI. Keyboard nav: Left/Right/Space/Esc. "Leader" role via awareness — other viewers follow leader's active slide. Presenter view in a separate window: current slide, next slide preview, notes placeholder, elapsed timer, "go live" control.

**Deliverable**: usable for live presentations.

### M14 — Speaker notes
Per-slide notes stored as Y.Text in slide Y.Map. Notes panel in editor (collapsible). Rich text (bold, lists, links) via Tiptap or similar bound to Y.Text. Display in presenter view.

**Deliverable**: notes system.

### M15 — Basic animations (preset system)
Add Motion (`motion` package). Runtime animation runner class that takes animation definitions and a PixiJS object and animates properties via Motion's `animate()` callback into PixiJS property assignments. Animation schema in object model: `animations: Animation[]` where Animation is `{ id, preset, trigger: "onEnter" | "onClick" | "withPrevious" | "afterPrevious", delay, duration, easing }`. Presets (15): fadeIn, fadeOut, slideInLeft/Right/Up/Down, scaleIn, scaleOut, rotateIn, bounceIn, flipIn, popIn, dissolveIn, wipeIn, zoomIn. UI: "Add animation" button on selected object, dropdown of presets. Preview play in editor.

**Deliverable**: animations play in present mode.

### M16 — Animation timeline UI
Timeline panel per slide showing all animations in sequence. Drag-to-reorder. Visual delay/duration bars (drag to adjust). Trigger type selector. Play button previews entire slide sequence.

**Deliverable**: Keynote-like animation panel.

### M17 — Slide transitions + Magic Move
Slide transitions at the deck level: fade, push (with direction), cube, none. Per-slide setting. Magic Move preset: during transition between slide A and B, find objects with matching IDs, tween their transform properties (x, y, w, h, rotation, opacity). Non-matching objects fade out/in.

**Deliverable**: transitions + Magic Move.

### M18 — Video support
BullMQ + Redis. Worker (`apps/workers/video`) listens for upload-completed events, runs ffmpeg: generate HLS variants (360p/720p/1080p) + poster frame + thumbnail. Write to MinIO. Video object type: stores posterUrl, hlsUrl, duration. In editor: render poster as PixiJS texture + play icon overlay. In present mode: overlay `<video>` DOM element with hls.js, positioned over canvas.

**Deliverable**: heavy video support.

### M19 — Media preloading for present mode
Before starting presentation, scan all media URLs in deck, preload via Image() and video manifest fetches. Progress bar. Fail gracefully (use poster if HLS manifest fails). Cache in IndexedDB for subsequent opens.

**Deliverable**: lag-free live presentations.

### M20 — AI slide generation
Anthropic SDK in API. Structured output via tool use with JSON schema matching slide model. Server-side Yjs client (using @hocuspocus/server-extensions or direct Y.Doc manipulation) applies generated slides to a deck. Prompt UI: modal with textarea, "generate 10 slides about X" style. Stream slides one by one (use Anthropic streaming + apply per slide). Env var for ANTHROPIC_API_KEY.

**Deliverable**: "generate N slides about X" works.

### M21 — AI per-slide assistance
Context menu on objects/slides: rewrite, translate, simplify, expand, make more concise. LLM gets current object/slide + surrounding slides as context, returns proposed change. Diff preview modal before apply.

**Deliverable**: AI editing tools.

### M22 — AI layout suggestions
"Fix my slide" button. LLM receives current slide's objects with positions, returns new layout. Constrained to predefined layout templates (title + content, two-column, image + caption, quote, etc.) to avoid free-form chaos.

**Deliverable**: layout AI.

### M23 — Templates and themes
Theme = `{ colors: {...}, fonts: {...}, spacing: {...} }` at deck level. Slide templates pre-defined in code initially (title, content, two-column, image+text, quote, section-divider). Template picker on new slide. "Apply theme" button re-styles all objects in deck.

**Deliverable**: design consistency.

### M24 — Comments and review
Comments as a separate Y.Array on deck, each comment: `{ id, author, text, targetSlideId, targetObjectId?, resolved, thread: [] }`. Pin indicators on canvas. Comments panel. @mentions with user picker. Notification system (email via SMTP, in-app).

**Deliverable**: review workflow.

### M25 — Version history
Snapshot Y.Doc state every N edits or every M minutes (whichever first). Manual snapshot button. History view with timeline, diff view (which objects changed), one-click restore (creates a new snapshot first).

**Deliverable**: git-like history.

### M26 — Export
PDF export via Playwright headless rendering present mode. PNG per slide via PixiJS renderToCanvas. Share link for view-only access (separate viewer route with token). PPTX export: **parked** unless needed — it's a major project on its own.

**Deliverable**: export pipelines.

### M27 — Three.js object type
Three.js scene as object type. Offscreen WebGL canvas renders Three scene, copied as PixiJS texture each frame (or at reduced fps for perf). Scene config in object: `{ gltfUrl, camera: {position, target}, lights: [...], autoRotate }`. Simple scene editor: import .glb, position camera. Optional: animation binding (trigger scene animations from slide animations).

**Deliverable**: 3D content on slides.

### M28 — Web embed (iframe)
Iframe object type. In editor: placeholder with screenshot taken by backend Playwright service + URL label. In present mode: live iframe as DOM overlay positioned over canvas (same pattern as video). Sandbox attribute configurable per embed.

**Deliverable**: embed web pages.

### M29 — Lottie
Lottie object type using lottie-web renderer into an offscreen canvas → PixiJS texture. Upload .json files. Library browser for lottiefiles.com-style presets (optional: curate a small built-in set).

**Deliverable**: Lottie animations.

### M30 — Plugin system
Object type SDK: `registerObjectType({ type, render, hitTest, defaultProps, inspector, schema })`. Plugins live in `packages/plugins/*`. Dynamic loading in frontend. Built-in plugins to dogfood the system: animated chart (using a chart lib), code block with syntax highlighting, static map (Mapbox or OSM static tiles).

**Deliverable**: extensible object system with 3 example plugins.

### M31 — Custom animation DSL
JSON DSL per the spec in conversation: `{ steps: [{ target, preset, duration, delay, easing }, { parallel: [...] }, { wait }, ...] }`. Monaco editor in inspector (advanced tab) with JSON schema autocomplete. Runtime interpreter converts DSL to Motion timeline.

**Deliverable**: power user animation authoring.

### M32 — Polish, performance, observability
Profile with 50-slide decks, multiple videos, 15 concurrent editors (use synthetic load script). Optimize hot paths: PixiJS scene diffing, Yjs update handling, awareness throttling. Add Sentry. Prometheus metrics from API, Hocuspocus, workers. Structured logs (pino). Runbook in `docs/ops.md`.

**Deliverable**: production-grade stability.

---

## Definition of done

- **M5** = MVP (sync works, text + shapes)
- **M12** = deployed alpha
- **M19** = usable v1 (animations, video, live presentations work)
- **M32** = feature-complete

## How to work with the developer

- Developer is solo, learning web dev while building, AI-assisted.
- They want **normal engineering collaboration**, not a tutorial.
- Explain architectural choices briefly when making non-obvious ones.
- Do not add dependencies without mentioning them in the commit message with a one-line justification.
- Keep commits atomic. PR descriptions should include: what changed, why, how to verify.
- When stuck or facing ambiguous requirements, ask before implementing.
- Weekend/evening cadence — session might end mid-milestone. Always leave the repo in a compilable state with a clear `TODO.md` or commit message noting the next step.

## First task

Execute M0:
1. Initialize git repo, pnpm workspaces monorepo.
2. Create `apps/web` with Vite + React + TypeScript strict + Tailwind.
3. Install PixiJS v8. Create `<Canvas />` React component with proper mount/unmount lifecycle (dispose PixiJS Application on unmount).
4. 3-pane layout: left sidebar (static "Slides" heading), center Canvas filling available space, right inspector placeholder.
5. Root `README.md` with setup/run instructions.
6. `docs/adr/0001-monorepo-layout.md` documenting the monorepo choice.
7. `CHANGELOG.md` with M0 entry.
8. Verify: `pnpm install && pnpm dev` starts, browser shows empty canvas in 3-pane layout.

Commit as: `feat(m0): foundation — monorepo, web app, pixi canvas, layout`.

Then stop and wait for confirmation before starting M1.
