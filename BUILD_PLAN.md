# Narrative — Build Plan

Handoff document for Claude Code. Read this fully before starting.

## Project overview

Self-hosted kolaborativní prezentační nástroj s Keynote-level animacemi, těžkou podporou médií a AI-native editací. Stavěno inkrementálně, finální stack od M0.

**Target users**: týmy do 15 souběžných editorů na deck.
**Deployment**: self-hosted na Proxmoxu přes Docker Compose.
**Developer context**: sólo vývojář, learning-as-building, AI-assisted workflow. Víkendová/večerní kadence. Dlouhodobý projekt, ne sprint. Čistý kód před rychlostí; stabilní milníky před širokými featurami.

## Tech stack (final, od M0)

- **Frontend**: React 18 + TypeScript (strict) + Vite + Tailwind CSS
- **Canvas renderer**: PixiJS v8 (WebGL/WebGPU)
- **Animation runtime**: **GSAP + GSAP Flip plugin** (free od 2024 po Webflow akvizici, včetně všech plugins). Obalen za vlastní JSON DSL compiler → vyměnitelný.
- **Animation editor UX inspirace**: Theatre.js Studio jako referenční vzor pro M14 timeline panel (ne runtime dependency).
- **Realtime sync**: Yjs + Hocuspocus (WebSocket)
- **Backend**: Node.js + Fastify, TypeScript. API + Hocuspocus v jedné appce (`apps/server`), rozdělit až když to bude třeba.
- **Database**: Postgres (metadata + Yjs persistence přes Hocuspocus extension)
- **Object storage**: MinIO (S3-compatible)
- **Media pipeline**: tus.io uploads, ffmpeg workers přes BullMQ + Redis, imgproxy
- **Auth**: Authentik (OIDC) — přidáno v M10
- **AI**: Anthropic API (Claude Sonnet pro generování, tool use pro structured output)
- **Reverse proxy**: Caddy (automatic TLS)
- **Deploy**: Docker Compose na Proxmox LXC/VM, ZFS pro storage
- **Observability**: Sentry + základní metriky od M6, Prometheus full v M29

## Working principles

1. **Finální stack od M0.** Žádné throwaway technologie. Každý milestone staví na předchozím kódu bez přepisů základů.
2. **State je single source of truth.** Yjs od M2. PixiJS renderuje diff. Nikdy nemutovat Pixi objekty jako primární stav.
3. **TypeScript strict mode.** Žádné `any` bez justification komentáře.
4. **Git commity po logických jednotkách.** Conventional Commits.
5. **Každý milestone končí s:** funkční demo + testy kritických cest + CHANGELOG záznam + **handoff dokument v `docs/handoff/`**.
6. **Deploy brzo (M4), ne na konci.** Staging instance od M4 dál.
7. **ADR v `docs/adr/`** pro netriviální architektonická rozhodnutí.
8. **Při pochybnostech se zeptat** před přidáním závislosti.
9. **Handoff after every milestone.** `docs/handoff/MXX-<název>.md` — aby šlo pokračovat na jiném zařízení.

## Repository structure (target)

```
/
├── apps/
│   ├── web/              # React frontend
│   ├── server/           # API + Hocuspocus v jedné appce (rozdělit až bolí)
│   └── workers/          # ffmpeg, AI workers (přidáno v M12)
├── packages/
│   ├── shared/           # Shared types (slide model, object types)
│   ├── slide-model/      # Object types registry, Yjs bindings
│   ├── animation/        # JSON DSL + GSAP compiler + timeline runtime
│   └── ui/               # Reusable UI components
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

pnpm workspaces monorepo od M0. Turborepo volitelně (přidat, až build times bolí).

---

## Klíčová architektonická rozhodnutí

### Tři pilíře ověřené v prvních ~6 milestonech

1. **Scene graph + resource manager** (M1) — lifecycle pro textures, video frames, Lottie rastry, 3D render targets. Jeden centrální manager od začátku.
2. **Yjs-backed state + object type registry** (M2-M3) — plugin boundary od začátku. `registerObjectType({ type, render, hitTest, defaultProps, inspector, schema })`.
3. **Animation engine: JSON DSL → GSAP compiler** (M6) — DSL jako jediný model animací od začátku. Žádné preset→DSL migrace později.

### Edit mode vs. Present mode

Jeden renderer, dva módy. Present mode má vlastní entry point ale sdílí scene graph + resource manager. Oddělený mode stack (input handling, UI chrome), sdílený render stack. Ověřeno v M5.

### DOM overlay nad Pixi canvasem

Vyřešeno jednou v M2 jako "layered compositor" abstrakce. Použije se pro text edit (M2), present mode video (M12), iframe (M24), Lottie (M25). Positioning + event routing jednou odladěn, pak jen použit.

### Mixed-target animation pipeline

Animation engine umí cílit na Pixi objekty i DOM overlay objekty ve stejném timeline. First-class concern od M6. Příklady: text letter-by-letter animace v DOMu + shape fadeIn v Pixi ve stejné sekvenci.

### Server-side Yjs strategie

Pro AI generování slidů (M16): přímá Y.Doc manipulace v Node se broadcasts přes Hocuspocus extension. Rozhodnuto v ADR před M4.

---

## Fáze −1: Architectural spikes (před M0)

Tři víkendy, throwaway kód, ověření nejrizikovějších neznámých:

**Spike A — GSAP + Pixi performance.** 50 simultánních tweenů na 60 fps? Timeline s 10 sekvenčními animacemi + nested timelines funguje? Flip plugin na 20 objektů při slide transition?

**Spike B — Yjs scale.** 15 peerů × 30 Hz awareness + 5 editorů píšících současně. Stíhá scene diff? Jak moc síťového traffiku?

**Spike C — DOM overlay + Pixi event routing.** Text edit DOM input nad Pixi textem při zoomu/panu. Event routing, focus, keyboard shortcuts. Jak čisté to jde udělat?

Pokud některý spike selže → měníme stack **teď**, ne v M20.

---

## Milestones

Každý milestone je shippable jednotka. Nezačínat další před committem, testy, CHANGELOG záznamem a **handoff dokumentem**.

### M0 — Foundation + CI/CD
Monorepo (pnpm workspaces). `apps/web` s Vite + React + TS strict + Tailwind. Prázdný `apps/server` skeleton. GitHub Actions: build + typecheck + test + lint na každý push. Pre-commit hooks (husky + lint-staged). Local `docker-compose.yml` s Postgres pro dev. README s setup instructions.

**Deliverable**: `pnpm dev` startuje, CI zelená na prázdném repu.

### M1 — Scene graph + resource manager
PixiJS v8 v `<Canvas />` React komponentě s proper mount/unmount lifecycle. **Resource manager** jako první-class primitive: centrální správa texture/asset lifecyklů. Jeden hardcoded obdélník renderovaný z JSON definice. 3-pane layout: left sidebar, center canvas, right inspector. ADR-0001 (monorepo), ADR-0002 (renderer architecture).

**Deliverable**: prázdný canvas s jedním obdélníkem z dat.

### M2 — Yjs od začátku + object type registry + DOM overlay
Y.Doc v paměti (žádný server). Slide = Y.Map, objects = Y.Array. `registerObjectType` registry s rectangle, ellipse, text typy. Všechny edity přes `doc.transact()`. Y.UndoManager. Toolbar + klik na canvas vytvoří objekt. Pointer events pro drag. **DOM overlay primitive** pro text edit (positioning + focus management). Inspector ukazuje editovatelné properties.

**Deliverable**: jednouživatelský editor shapes + text, CRDT state, undo/redo.

### M3 — Renderer reconciler
Čistý diff engine: Y.Doc state → PixiJS scene (add/update/remove). Žádné přímé mutace Pixi objektů z editing kódu. Observer layer na Y.Doc s batching. ADR-0003 (reconciler pattern).

**Deliverable**: stejný UX jako M2, ale čistá architektura. Připraveno pro multiplayer.

### M4 — Hocuspocus sync + Postgres + první deploy
`apps/server` s Hocuspocus + Fastify API endpointem `/decks`. Hocuspocus persistence extension → Postgres. **První docker-compose setup** a deploy script na staging server (hardcoded user, no auth). Frontend používá `HocuspocusProvider`. **MVP = syncuje mezi taby/zařízeními + je online na doméně.**

**Deliverable**: **MVP — multi-tab sync, persistence, deployed.**

### M5 — Present mode MVP
Fullscreen present mode route. Keyboard nav (Left/Right/Space/Esc). Žádný editor chrome. Žádné animace (zatím). Forces edit/present architectural split early. Presenter view v separátním okně (placeholder).

**Deliverable**: lze prezentovat statické slidy. Split mode stack potvrzen.

### M6 — Animation engine (GSAP + DSL) + observability baseline
`packages/animation`: JSON DSL schema + compiler do `gsap.timeline()`. Runtime interpreter. Triggery: `onEnter`, `onClick`, `withPrevious`, `afterPrevious`. Mixed targets (Pixi + DOM overlay). Dva presety jako DSL factories: `fadeIn`, `slideIn`. Test: animace běží v present mode. Sentry + základní metriky (FPS, Yjs update rate). Synthetic load script pro průběžný profiling.

**Deliverable**: animační engine. DSL je jediný model od teď.

### M7 — Transform handles + multi-select + snapping
Resize handles (8 hran/rohů) s Shift aspect lock. Rotation handle. Multi-select přes drag rectangle + Shift-click. Group transforms. Smart guides (snap na grid, edges, centers jiných objektů, viditelné čáry). Keyboard: Delete, Cmd/Ctrl+D, arrow nudge, undo/redo. **Figma-like object manipulation.**

**Deliverable**: plnohodnotný editor.

### M8 — Awareness
Barevné kurzory per user (random barva na join, stabilní per session). Selection highlights v user barvě. Avatar chips v headeru. Cursor throttling 30 Hz. Awareness payload: `{ name, color, selectedObjectIds, cursor: {x, y, slideId} }`.

**Deliverable**: viditelná kolaborativní přítomnost.

### M9 — Multi-slide + transitions
Deck = Y.Array slide Y.Maps. Sidebar s thumbnails (PixiJS renderToCanvas na 200px). Add/delete/reorder (drag). Active slide = per-client state (nesynchronizuje se). **Slide transitions** (fade, push, cube, none) využívající animation engine z M6. Per-slide nastavení.

**Deliverable**: plné deck editing + přechody.

### M10 — Auth + permissions
Authentik v docker-compose. OIDC v serveru (JWT validace na WebSocket connect). Per-deck permissions tabulka (owner, editor, viewer). Sharing dialog (invite by email). Public view-only share link s tokenem.

**Deliverable**: multi-user systém s perms.

### M11 — Image uploads
MinIO + tus-node-server v `apps/server`. Drag-and-drop na canvas. Progress UI. Non-blocking editor během uploadu. imgproxy service pro on-the-fly varianty (thumb 400w, display 1600w, original). Image object type používá imgproxy URLs podle kontextu.

**Deliverable**: obrázky na slidech, resumable uploads.

### M12 — Video support + preloading
BullMQ + Redis. `apps/workers/video` worker: ffmpeg generuje HLS varianty (360p/720p/1080p) + poster frame + thumbnail. Video object type: poster jako Pixi texture + play icon overlay. V present mode: DOM overlay s hls.js video elementem, pozicovaný nad canvas. **Preloading pipeline**: před startem prezentace scan media URLs → preload přes Image()/manifest fetch → progress bar → IndexedDB cache. Fail gracefully (poster pokud HLS manifest failne).

**Deliverable**: video funguje, prezentace neseká.

### M13 — Magic Move
GSAP Flip plugin integrace. Při přechodu mezi slide A a B: match objekty po ID, tween transform properties (x, y, w, h, rotation, opacity, scale). Non-matching fade out/in. DSL rozšíření: `magicMove: true` per-transition.

**Deliverable**: Keynote Magic Move feature.

### M14 — Animation timeline UI (inspired by Theatre.js Studio)
Timeline panel per slide. Drag-to-reorder. Visual delay/duration bars (drag to adjust). Trigger selector. Play button previewuje celou sekvenci slidu. Scrubbing (GSAP timeline seek). **Theatre.js Studio jako referenční design** — studovat UX a transplantovat vhodné patterny.

**Deliverable**: Keynote-like animation panel.

### M15 — Rozšíření presetů + advanced animations
Dalších 15 presetů jako DSL factories: fadeOut, slideIn×4 směry, scaleIn/Out, rotateIn, bounceIn, flipIn, popIn, dissolveIn, wipeIn, zoomIn. Text-specific animace využívající DOM overlay: letter-by-letter reveal, typewriter, word-by-word.

**Deliverable**: bohatá knihovna presetů.

### M16 — AI slide generation
Anthropic SDK v serveru. Structured output přes tool use s JSON schema pro slide model. Server-side Yjs client (přímá Y.Doc manipulace) aplikuje vygenerované slidy. Streaming: slide po slidu, jakmile přijde z modelu. Prompt UI: modal s textareou ("generate 10 slides about X"). `ANTHROPIC_API_KEY` env var.

**Deliverable**: generování slidů z promptu.

### M17 — AI per-slide assistance
Context menu na objektech/slidech: rewrite, translate, simplify, expand, shorten. LLM dostane aktuální objekt/slide + okolní slidy jako kontext. Diff preview modal před aplikací. Apply = Yjs transaction.

**Deliverable**: AI editační tooly.

### M18 — AI layout suggestions
"Fix my slide" tlačítko. LLM dostane objekty + pozice, vrátí nový layout. Constrained na předdefinované layout templates (title+content, two-column, image+caption, quote, section divider) aby se zabránilo chaosu.

**Deliverable**: layout AI.

### M19 — Speaker notes
Per-slide notes jako Y.Text v slide Y.Map. Notes panel (collapsible) v editoru. Rich text (bold, italic, lists, links) přes Tiptap bound na Y.Text. Presenter view show notes + current + next + timer.

**Deliverable**: notes systém.

### M20 — Templates + themes
Theme = `{ colors, fonts, spacing }` na deck levelu. Slide templates předdefinované v kódu (title, content, two-column, image+text, quote, section-divider). Template picker při novém slidu. "Apply theme" přestyluje všechny objekty.

**Deliverable**: design konzistence.

### M21 — Comments + review
Comments jako Y.Array na decku. Comment: `{ id, author, text, targetSlideId, targetObjectId?, resolved, thread: [...] }`. Pin indicators na canvasu. Comments panel. @mentions s user pickerem. Notifikace (email přes SMTP + in-app).

**Deliverable**: review workflow.

### M22 — Version history
Snapshot Y.Doc state každých N editů nebo M minut. Manual snapshot button. History view s timeline, diff view (co se změnilo), one-click restore (vytvoří nový snapshot před).

**Deliverable**: git-like historie.

### M23 — Custom DSL editor
Monaco editor v inspectoru (advanced tab) s JSON schema autocomplete pro animation DSL. Validation. Live preview. Power user authoring.

**Deliverable**: advanced animation authoring. (DSL už existuje od M6, tohle je jen UI.)

### M24 — Web embed (iframe)
Iframe object type. V editoru: placeholder se screenshotem z backend Playwright služby + URL label. V present mode: live iframe jako DOM overlay (stejný pattern jako video). Sandbox attribute konfigurovatelný per embed.

**Deliverable**: embed webových stránek.

### M25 — Lottie
Lottie object type přes lottie-web renderer do offscreen canvas → PixiJS texture. Upload .json souborů. Volitelný library browser pro built-in set presetů.

**Deliverable**: Lottie animace.

### M26 — Three.js object type
Three.js scéna jako object type. Offscreen WebGL canvas renderuje Three scénu, kopíruje se jako PixiJS texture každý frame (nebo reduced fps pro perf). Scene config: `{ gltfUrl, camera, lights, autoRotate }`. Jednoduchý scene editor: import .glb, pozicovat kameru. Volitelné: binding animations na slide animation triggery.

**Deliverable**: 3D obsah na slidech.

### M27 — Plugin system (public SDK)
Object type SDK jako veřejná forma registry, která existuje od M2. `registerObjectType` dokumentace. Plugins v `packages/plugins/*`. Dynamic loading ve frontendu. Built-in plugins pro dogfooding: animated chart (chart lib), code block se syntax highlightingem, static map (OSM static tiles).

**Deliverable**: extensible object system + 3 example plugins.

### M28 — Export (zatím nechcete — parked)
PDF export přes Playwright headless rendering present mode. PNG per slide přes PixiJS `renderToCanvas`. Share link pro view-only (separátní viewer route s tokenem). **PPTX export: parked.** **Video export: parked (explicit rozhodnutí).**

**Deliverable**: základní export pipeline. Přeskakujeme, pokud nepotřeba.

### M29 — Performance + observability + polish
Profile s 50-slide decky, více video, 15 souběžných editorů (synthetic load script z M6, rozšířený). Optimalizace hot paths: PixiJS scene diffing, Yjs update handling, awareness throttling, GSAP tween count. Prometheus metrics z serveru + workers. Structured logs (pino). Runbook v `docs/ops.md`. Backup scripty (Postgres pg_dump + MinIO mc mirror + ZFS snapshot).

**Deliverable**: production-grade stabilita.

---

## Definition of done

- **M4** = MVP (sync + deployed)
- **M6** = animation engine hotový, foundation kompletní
- **M12** = usable v1 (animace, video, live prezentace)
- **M15** = rich preset library, produkt vypadá "luxusně"
- **M29** = feature-complete

## Jak pracovat s vývojářem

- Sólo vývojář, learning web dev + AI-assisted.
- Chce **normal engineering collaboration**, ne tutorial.
- Architektonické volby vysvětlit krátce když jsou netriviální.
- Nepřidávat dependencies bez zmínky v commit message s one-line justification.
- Atomic commity. PR popisky: what/why/how to verify.
- Když stuck nebo ambiguous requirements → zeptat se.
- Víkendová/večerní kadence — session může skončit uprostřed milestonu.
- **Handoff dokument** na konci každého hotového milestonu do `docs/handoff/MXX-<název>.md`. Obsah: status, co bylo uděláno, klíčová rozhodnutí, jak ověřit, další krok, známé TODO, odkazy. Umožňuje pokračovat na jiném zařízení.
- Vždy nechat repo v kompilovatelném stavu s clear next step.

## First task

**Fáze −1 spike A (GSAP + Pixi performance).** Throwaway projekt mimo monorepo. Ověřit:
- 50 simultánních GSAP tweenů na Pixi object properties → 60 fps?
- `gsap.timeline()` s 10 sekvenčními animacemi + nested timelines → funguje clean?
- Flip plugin na 20 Pixi objektech při slide transition → přijatelná latence?

Pokud spike zelený → pokračovat spike B (Yjs) + spike C (DOM overlay).
Pokud všechny tři spiky zelené → spustit M0.

**Stop a čekat na potvrzení po spike A.** Handoff doc `docs/handoff/spike-a-gsap-pixi.md` před pokračováním.
