# Polish Phase — Plan + Handoff

**Date:** 2026-04-22
**Status:** Plan approved. P1 not yet started.
**Context:** After M19 (speaker notes) merged, the product is a solid PoC.
This phase closes the UX gap vs. Keynote before we continue to the next
numbered milestones (M20 templates/themes, M21 comments, M22 version
history, then M16–M18 AI work).

## Where we are

- M0–M15, M19 merged to `main`.
- Deferred from original BUILD_PLAN: M16–M18 (AI), M20 (templates +
  themes — slide masters will land there), M21 (comments), M22 (version
  history), M23–M29.
- The polish phase below comes BEFORE all of those. Explicitly agreed
  with user.

## UI kit decision

- **shadcn/ui** — copy-pasted Radix-based components into the repo, full
  control over look.
- **lucide-react** — icon library.
- **Tailwind utilities** — already in use; extend with glass
  (`backdrop-blur-xl bg-white/5 border border-white/10`) and glow
  (`shadow-2xl shadow-blue-500/30`) tokens.
- **Design tokens** — CSS vars for colors, spacing, radii, shadows.

Rejected alternatives:

- HeroUI / Mantine / MUI — heavier, less customisable.
- Park UI — Panda CSS is extra tooling we don't need.

## 11 phases

Each phase = its own branch (`polish/pN-<name>`) + merge gate. User is
expected to test each branch before merge.

| #   | Name                      | Scope summary                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1  | Visual foundation         | shadcn/ui setup, Lucide icons, design tokens (CSS vars), glass/glow utilities, restyled Toolbar / SlidesPanel header / Inspector chrome. No behavioural change.                                                                                                                                                                                                                                                                 |
| P2  | Artboard + backgrounds    | 16:9 artboard box visible in editor, outside greyed/masked. Per-slide background: color / linear gradient / radial gradient / image fill. Thumbnails render full artboard including background.                                                                                                                                                                                                                                 |
| P3  | Slides sidebar polish     | Resizable sidebar (drag handle on right edge). Inline slide rename. Slide count in header. Context menu (duplicate, delete, skip, add section). Skip-slide flag (hidden in present). Sections — Keynote-style nesting with collapse. "Back to overview" mode — full-screen slide grid.                                                                                                                                          |
| P4  | Toolbar — shapes + tools  | Select / Hand-pan / Zoom tools. Shape library: rect, ellipse, triangle, regular polygon, star, arrow, line, curve, speech bubble. Line tool with arrowheads. Zoom buttons + fit-to-screen. Undo / Redo buttons.                                                                                                                                                                                                                 |
| P5  | Inspector — Appearance    | Fill: solid, linear/radial gradient (angle + stops), image fill. Stroke: width, color, dash, end caps. Shadow + blur. Corner radius per-corner. Object name (rename instance, feeds Magic Move pair key). Lock + hide toggles.                                                                                                                                                                                                  |
| P6  | Object operations         | Group / Ungroup (Cmd+G, Shift+Cmd+G). Copy / Paste / Duplicate (Cmd+C/V/D). Align buttons (L/C/R/T/M/B). Distribute H/V. Layer order (bring front/forward/backward/back; [ / ] and Cmd-variants). Smart guides with px distance labels during drag.                                                                                                                                                                             |
| P7  | Text overhaul             | Double-click to enter inline edit (contenteditable overlay above Pixi). Full typography: family, weight, size, line-height, letter-spacing, horizontal + vertical alignment. Bullets, numbered lists. Stroke, gradient, shadow on text.                                                                                                                                                                                         |
| P8  | Video polish              | Apply rotation / scale / opacity transforms to the video overlay (today only position + size flow through). Volume control in Inspector. Click-to-play preview in editor (paused by default). Poster frame override (pick a second in the clip). Aspect-ratio lock toggle. Trim start/end — stretch goal, depending on ffmpeg worker.                                                                                           |
| P9  | Keyboard shortcuts        | Cmd+D duplicate (context-sensitive: slide in sidebar focus, object on canvas focus). Delete / Backspace remove in context (slide / object / animation step). Arrow-key nudge 1 px (Shift = 10 px). Esc deselect. Cmd+A select all objects on active slide. [ / ] layer order. Cmd+]/[ and Shift variants. Cmd+Z / Shift+Cmd+Z undo/redo. Space+drag for pan. Cmd+= / Cmd+- / Cmd+0 zoom. Cmd+/ opens shortcut cheatsheet modal. |
| P10 | Animation timeline polish | Per-bar trigger icon (clock = auto, hand = onClick, play = withPrevious, chain = afterPrevious). Delete key removes selected step. "Play only this step" button. Current-state preview during scrub (already present; verify).                                                                                                                                                                                                  |
| P11 | Keynote extras            | Right-click context menus (canvas / slide / object). Hyperlinks — objects link to another slide or URL, clickable in present mode. Rulers (top + left). Draggable horizontal / vertical guides. Eyedropper for color. Image cropping + basic rectangular mask. In-editor video playback controls. Recent-colors swatch in color pickers. Clipboard across decks (paste objects from another deck).                              |
| P12 | Performance pass          | Procedural-texture lifecycle (gradient / pattern / image fill / noise / mask reuse the same acquire+ref-count+release flow, extending `ResourceManager`). Filter instance reuse (shadow / blur). Frame pacing + render scheduler audit under rapid slider scrubs. Texture atlas / GC sweep for long editing sessions. Measure-first: add a perf scratchpad (FPS + texture count + DrawCall count) before tuning.                |

## Explicitly rejected during planning

- Onion-skin / ghost of previous slide during edit.
- Autosave indicator in the UI — autosave is already implicit via Y.Doc.
- Tab navigation between objects — keyboard-picker feature not wanted.
- Slide master layouts — stay in M20 (templates + themes).

## Video polish — why its own phase

Video transforms (rotation, scale, alpha) don't flow through to the DOM
`<video>` overlay today. The overlay lives above the Pixi canvas and is
positioned via OverlayCompositor matching world coords, but the compositor
currently only syncs `position` + `size`. Need to push CSS `transform:
rotate() scale()` and `opacity` from the Pixi container's live state onto
the overlay element every frame (same frame loop that drives position).

## Execution protocol

- One branch per phase: `polish/pN-<short-name>`.
- Commit messages include the phase id and a one-line summary.
- User tests each branch before merge. No merge without explicit ok.
- Handoff doc per phase at the end (`docs/handoff/polish-pN-<name>.md`).
- Before touching code: re-read this file to confirm scope.

## Resume instructions

Next session, the first action is:

1. `git checkout main && git pull`.
2. Create branch `polish/p1-visual-foundation`.
3. Install `lucide-react`, set up shadcn/ui (their CLI creates
   `src/components/ui/*.tsx` — directory to be decided at execution time,
   probably `apps/web/src/components/ui/`).
4. Extend `tailwind.config.*` with color / radius / shadow tokens.
5. Write + apply glass/glow utility classes.
6. Refactor Toolbar + Sidebar header + Inspector chrome to use the new
   look, no functional change.
7. Smoke test: E2E suite still green.
8. Commit + push. Ask user to test.

## Dependencies to add (planned)

- `lucide-react` (icons)
- `class-variance-authority` + `clsx` + `tailwind-merge` (shadcn util layer)
- `@radix-ui/react-*` — only the primitives shadcn needs (dialog,
  dropdown-menu, popover, tooltip, scroll-area, separator, label, slot)

No runtime framework changes.

---

## Technical approach per phase

The Narrative stack today: Yjs CRDT for deck state, PixiJS v8 for the
canvas scene graph, DOM overlay compositor for videos / future text
edit overlays, Hocuspocus for WS sync, Tailwind + React for UI chrome.
Every phase lands inside those primitives — no new architectural layer.

### P1 — Visual foundation

**Goal:** new look without touching functional code.

- `apps/web/src/styles/tokens.css` — new file, defines CSS variables:
  - `--surface-0..3` (layered backgrounds, dark→darker), `--glass-fg`,
    `--glass-bg` (rgba, low alpha), `--border-subtle`, `--border-strong`,
    `--accent-500/600`, `--accent-glow` (rgba w/ alpha).
  - `--radius-sm/md/lg/xl`, `--shadow-sm/md/lg/glow`.
- `apps/web/tailwind.config.ts` — extend `theme.colors`, `theme.borderRadius`,
  `theme.boxShadow` to reference the vars so utility classes pull from
  tokens (e.g. `bg-surface-1`, `shadow-glow`).
- Initialise shadcn/ui into `apps/web/src/components/ui/` via its CLI.
  Copy Button, Dialog, DropdownMenu, Popover, Tooltip, ScrollArea,
  Separator, Input, Label, Slider. Adjust their default classes to
  consume our tokens (shadcn copies code, so it's just an edit pass).
- Swap inline SVGs and `<button className="...">` chrome throughout
  Toolbar / SlidesPanel header / Inspector to use `<Button variant>`
  and Lucide icons. Keep event handlers and data flow identical.
- No Y.Doc / schema changes. No E2E changes beyond visual regression —
  suite should stay green.

**Verification:** manual smoke test of editor + present mode. E2E 2/2
green. `pnpm --filter @narrative/web typecheck` clean.

### P2 — Artboard + backgrounds

**Goal:** visible 16:9 artboard with per-slide background.

- Schema: add `background` field to slide Y.Map. Type:
  `{ kind: 'color', color: number } | { kind: 'linearGradient', stops:
Array<{ offset: number, color: number }>, angleDeg: number } |
{ kind: 'radialGradient', stops, centerX, centerY } | { kind:
'image', assetId: string, fit: 'cover'|'contain' }`.
  Stored as nested Y.Map (not plain object) so gradient stops can be
  co-edited atomically.
- Renderer: new `ArtboardBackground` Pixi container mounted as the
  first child of the slide root. Reads background via a subscription
  (same pattern as `useSlideObjects`). For gradients, render into an
  offscreen canvas → Pixi texture; for images, resolve via imgproxy
  (existing `/api/media/:id/url`). Rebuild texture only when inputs
  change.
- Editor chrome: wrap the slide in a container that masks everything
  outside the 16:9 area with a semi-transparent scrim. Artboard border
  is a 1 px outline. Keep the Pixi canvas at its existing world size
  (1920×1080) — the mask is pure CSS.
- Thumbnails: `useSlideThumbnails` already invokes a headless Pixi
  render of the slide. Extend `renderSlide` to mount the
  `ArtboardBackground` container FIRST before the object children so
  thumbnails show the right background.
- Inspector: add a "Background" section to `SlideInspector` — a picker
  that switches between kinds (color / linear / radial / image), shows
  the appropriate editor per kind.

**Risks:** Pixi texture memory for many-gradient decks; lazy-load per
slide and reuse a single texture per background identity.

### P3 — Slides sidebar polish

**Goal:** richer slide panel UX.

- Schema: add `name?: string`, `skipped?: boolean` to slide Y.Map. Add
  a `section` Y.Map sibling to `slides` or a `sectionId?: string` on
  each slide — decide at execution; the Y.Array approach keeps ordering
  simple: slides carry `sectionId`, sections are metadata
  `{ id, title, collapsed, order }`.
- Resizable sidebar: flex wrapper with a drag handle on the right
  edge. Width stored in `localStorage` (`narrative:sidebarWidth`).
- Inline rename: double-click or F2 on the slide row switches to
  `<input>` bound to `slide.name`.
- Context menu: use shadcn DropdownMenu (P1 dependency), wired to the
  existing `addSlide`, `removeSlide`, `duplicateSlide` helpers. New:
  `toggleSkipSlide(ctx, slideId)`, `setSectionCollapsed`,
  `createSection`.
- "Back to overview" — new route `/deck/:id/overview` renders a grid of
  slide thumbnails (reusing `useSlideThumbnails`). Click opens the
  slide in the editor. A toolbar button + Esc from slide editor take
  the user there.
- Present mode must honour `slide.skipped` — `navigateToSlide` filters
  skipped slides before computing next/prev.

### P4 — Toolbar: shapes + tools

**Goal:** richer creation toolset.

- New object types in the registry (`packages/slide-model`):
  - `line` (`{x1,y1,x2,y2,stroke,strokeWidth,startCap,endCap,dash}`)
  - `arrow` — a `line` with `endCap: 'arrow'` default.
  - `polygon` — `{points: number[], fill, stroke, ...}`. Star, triangle
    emitted as specific polygons with computed points.
  - `curve` — Bézier `{points: Array<{x,y,cp1x,cp1y,cp2x,cp2y}>,
stroke, fill}`.
  - `speechBubble` — composite: rect + triangle tail; stored as
    polygon for simplicity.
- Renderers in `apps/web/src/renderer/objectRenderers/`: one file per
  type, following `rectangleRenderer` template. `applyPatch` path for
  performance.
- Toolbar modes: new `activeTool` state, one of
  `'select'|'hand'|'zoom'|'rect'|'ellipse'|...`. Current implicit
  state is always `'select'`. Hand tool gates pan. Zoom gates click →
  zoom in / option-click → zoom out.
- Shape-creation flow: pointer-down on canvas in shape tool mode →
  drag to define bounding box → release creates the object. Reuse
  existing `objectsCtx` + `createObjectOfType`.
- Undo/Redo buttons: wire to existing `undoManager` (already lives in
  `SlideDocProvider` since M7-ish). Keyboard (Cmd+Z / Shift+Cmd+Z) —
  consolidate into P9.

### P5 — Inspector Appearance

**Goal:** rich object appearance controls.

- Schema extension (applies to rect, ellipse, polygon, text, image):
  - `fill`: union — solid number | `{kind:'linearGradient', stops,
angleDeg}` | `{kind:'radialGradient', stops, center}` |
    `{kind:'image', assetId, fit}`. Stored as a Y.Map per object.
  - `stroke`: `{color, width, dash, lineCap, lineJoin}` optional.
  - `shadow`: `{color, blur, offsetX, offsetY, opacity}` optional.
  - `blur`: radius px.
  - `cornerRadius`: `number | {tl, tr, bl, br}` for per-corner.
  - `name`: string, drives Magic Move pairing + Inspector label.
  - `locked`, `hidden`: booleans.
- Renderers: Pixi v8 has `GradientFillStyle` — map our gradient shape
  to it. Filter pipeline covers shadow / blur
  (`new BlurFilter`, `new DropShadowFilter` from `@pixi/filters`).
- Inspector UI: extend `AppearanceSection` — fill picker switches
  between modes with sub-editors; gradient editor is a horizontal
  track with draggable color stops.
- Lock/hide flags: Select tool skips locked objects for picking; hidden
  objects skip in render + in animation target resolver (warn once).

**Deps to evaluate:** `@pixi/filters` for drop-shadow + blur. Install at
execution, ~50 KB.

### P6 — Object operations

**Goal:** multi-object editor parity with design tools.

- Group/Ungroup: new object type `group` — `{children: SlideObject[]}`.
  OR model as a slide-level attribute `{groupId}` on each object.
  Execution preference: `groupId` attribute — avoids cascading renderer
  changes; a group is implicit ("all objects sharing a groupId").
- Copy/Paste: in-memory clipboard (no Y.Doc ties). Serialize selected
  objects to JSON, deserialize on paste with fresh ids. Cross-deck
  paste lives in P11.
- Duplicate: paste-at-offset convenience. Cmd+D = copy + paste +
  offset(+10, +10).
- Align / Distribute: compute bounding rects for selected objects,
  solve for target positions, write in a single `doc.transact`.
- Layer order: Y.Array index is the z-order (front = last in array).
  Helpers: `moveObjectBy(ctx, id, delta)`, `moveObjectToFront/Back`.
- Smart guides with distance labels: on drag, compute snap candidates
  from other objects + artboard center/edges. When snap fires, render
  a dashed line + px label (small overlay component on top of canvas).

### P7 — Text overhaul

**Goal:** Pixi text is rendered but not editable today. Upgrade.

- Strategy: inline contenteditable DOM overlay above the Pixi text
  container. Reuse `OverlayCompositor` (same primitive as videos). On
  double-click, hide the Pixi text, mount a contenteditable div sized
  and positioned to match. On blur or Esc, flush content into Y.Doc
  and hide.
- Rich text model: lean. Keep simple — inline rich text as a single
  HTML string with allowed tags (`<b>`, `<i>`, `<u>`, `<span
style=...>`). NO Tiptap here — keep it dumb, we render ourselves.
  If complexity creeps, consider Tiptap in a later polish pass.
- Typography: font family (from a curated list — bundled web fonts or
  safe system stacks initially), weight, size, line-height,
  letter-spacing, horizontal + vertical alignment. Vertical alignment
  needs the bounding box of the text to be known; store an explicit
  `height` on TextObject (already present).
- Lists: `<ul>` / `<ol>` inside the contenteditable; in Pixi render,
  parse the HTML and render with HTML.container (Pixi v8) OR fall
  back to a pre-rendered canvas texture. Evaluate at execution.
- Stroke / gradient on text: Pixi text `TextStyle` supports stroke and
  gradient fills natively — wire through from Inspector.

**Risk:** Pixi v8's HTML text rendering is still experimental; if it's
shaky, fall back to a rasterised texture path (render to canvas, upload
as texture).

### P8 — Video polish

**Goal:** video objects match other objects in transform + control.

- Overlay transform: `OverlayCompositor` currently reads Pixi container
  position + size. Extend to also read `rotation`, `scale`, and
  `alpha`, and emit them as CSS `transform: translate() rotate()
scale()` + `opacity` on the `<video>`'s wrapper element. Transform
  origin → container pivot in DOM-space px.
- In-editor click-to-play: today the editor shows the poster
  (imgproxy). Wire a small `VideoObjectRenderer` chrome: overlay a
  `<video>` behind the Pixi object for edit mode, pauseable via click.
  Rebuild via same overlay compositor with `interactive: true` so the
  click reaches the element.
- Inspector: volume slider, loop toggle, autoplay toggle, muted
  toggle, poster frame seek (shows a scrubber; on commit, worker
  regenerates poster at that timestamp — reuse existing BullMQ
  pipeline, new job type `regen-poster`).
- Aspect ratio lock: editor-side only, constrains width/height
  dragging to the video's native aspect.
- Trim: add `trimStartSec`, `trimEndSec` to `VideoObject`. hls.js
  supports media source buffering offsets; seek on load to trimStart;
  pause at trimEnd. Worker does NOT recut the video — pure client
  playback window. If we later want re-cut output, that's a separate
  worker job.

### P9 — Keyboard shortcuts

**Goal:** global keybinds registry with scope awareness.

- New `apps/web/src/state/useShortcuts.ts` — centralised registry.
  Hooks into `document.keydown`. Dispatches to handlers based on:
  - `scope` — `'slidePanel'`, `'canvas'`, `'timeline'`, `'global'`.
  - Scope detection — `event.target.closest('[data-shortcut-scope]')`
    walked up the DOM.
- Consolidates the ad-hoc keydown listeners currently in EditorLayout,
  PresentLayout, and AnimationTimeline.
- Cheatsheet modal (Cmd+/) — shadcn Dialog listing all registered
  shortcuts with scope labels.
- Preserves existing scoped behaviour: Delete removes an animation step
  only when the timeline has focus, removes a slide only when the
  slide panel has focus, etc.

### P10 — Animation timeline polish

**Goal:** trigger visual clarity + timeline-first delete.

- Bar chrome: replace the 6 px colour chip with a 14 px icon slot on
  the left — clock (auto / withPrevious / afterPrevious), hand-pointer
  (onClick). Lucide has both. Keep clicking the icon to open the
  trigger dropdown (today's chip).
- Delete: already hooked in the per-row × button; add a global
  `keydown` handler scoped to the timeline container (using the P9
  registry) that removes `selectedId` on Delete / Backspace.
- "Play only this step": compile a one-step timeline via
  `createAnimationRuntime([step], ctx)`, run, destroy. Safe against
  the rest of the slide's animations because it's a fresh runtime.

### P11 — Keynote extras

**Goal:** Keynote-parity long tail.

- Right-click menus: shadcn ContextMenu component. Distinct menus for
  canvas (paste, insert shape here, select all, fit to screen), slide
  row (rename, duplicate, delete, skip, add section, move to
  section), object (cut, copy, paste, duplicate, bring front, send
  back, lock, hide, delete, hyperlink).
- Hyperlinks: `object.hyperlink` — `{kind:'slide', slideId} |
{kind:'url', href, target}`. In present mode, pointer-events on
  object's overlay; click → `navigate(slide)` or `window.open(url)`.
  Inspector section with type picker.
- Rulers + guides: overlay component with two 24 px pixel strips (top,
  left). Drag out from ruler → creates a guide stored in a per-deck
  Y.Array `guides` (position in world px + orientation). Snap uses
  existing smart-guide infrastructure.
- Eyedropper: use native `EyeDropper` API (Chromium; graceful fallback
  with a message where unsupported).
- Image cropping: CropMode boolean per ImageObject + extra `cropRect`
  `{x,y,width,height}` in image pixels. Renderer uses Pixi sprite's
  texture rectangle.
- In-editor video controls: reuse the P8 overlay with a small
  play/pause/mute chrome that appears on hover.
- Recent-colors swatch: localStorage ring buffer (last 12 colors) per
  user, surfaced in every color picker.
- Cross-deck clipboard: extend the in-memory clipboard (P6) to also
  write to `localStorage` on copy; read on paste if the in-memory
  entry is empty.

### P12 — Performance pass

**Goal:** clean up lifecycle debt accumulated during feature phases and
keep the editor fast under rapid Inspector scrubs + long editing
sessions.

**Known technical debt entering P12** (add to this list as future
phases create more):

- **Procedural texture leak (gradients).** `apps/web/src/renderer/fillStyleToPixi.ts`
  builds a fresh `Texture.from(canvas)` on every redraw for linear and
  radial gradient fills. `rectangleRenderer` / `ellipseRenderer` /
  `polygonRenderer` call it from `drawRect` / `drawEllipse` /
  `drawPolygon` which run on every `update` / `applyPatch` — so each
  slider tick on the angle or stop colour allocates another GPU texture
  and drops the old one on the floor. Intentional trade-off to ship
  around Pixi v8's `FillGradient.buildLinearGradient` quadrant bug; see
  memory note `procedural-texture-leak.md` for context.
- **Filter instance churn.** `apps/web/src/renderer/filterEffects.ts`
  now destroys + re-allocates `DropShadowFilter` / `BlurFilter` on
  every change (needed to avoid Pixi's bind-group desync bug), but a
  per-container slot cache would still dedupe across unchanged tick
  dispatches if we time the calls right.
- **Image fill (deferred from P5c).** Same procedural-texture problem
  plus async resolve from `media_assets` → imgproxy → Pixi texture.
  Share the P12 lifecycle with the gradient fix.
- **Video sidebar thumbnail can render the gray placeholder instead of
  the poster (P8 follow-up).** `useSlideThumbnails` doesn't re-render
  when a VideoObject's transcode flips from pending → done. If the
  thumbnail was generated while the asset was still transcoding, it
  bakes in the gray placeholder at the object's bounding box and never
  refreshes until something else on the slide changes. Visually that
  looks like a "squished" rectangle (especially after the user resized
  the video bbox to a non-native aspect). Fix: subscribe the thumbnail
  pipeline to per-asset video-info polls and invalidate affected
  slides on terminal transcode transitions.
- **Video editor preview duplicates VideoOverlay (P8 quick fix).**
  `apps/web/src/ui/EditorVideoPreview.tsx` was added because the
  present-mode `VideoOverlay` positions via `OverlayCompositor` /
  `toGlobal`, which doesn't account for the editor artboard's
  `transform: scale(zoom)` parent — the result was a DOM `<video>` that
  drifted away from the Pixi-painted poster as zoom changed and stayed
  at unscaled pixel size. Editor preview now mounts directly inside
  the scaled artboard in slide-space CSS coords, sidestepping the
  compositor entirely. Two near-identical HLS / trim / poster /
  play-from-top blocks now live in `EditorVideoPreview` and
  `VideoOverlay`. Consolidation: either teach `OverlayCompositor` to
  observe ancestor CSS transforms (proper fix, also helps any future
  DOM overlay), or extract the shared HLS + trim + poster wiring into
  a hook that both surfaces consume. Pick one in P12 alongside the
  rest of the renderer-lifecycle work.
- **WebGPU preference forced back to WebGL.** `apps/web/src/renderer/Canvas.tsx`
  currently runs with `preference: 'webgl'`. Pixi v8.18 WebGPU
  `BindGroupSystem._createBindGroup` intermittently null-derefs on the
  first render tick when a Graphics has a texture-based fill
  (image fill, canvas-built gradient fill) — race between
  `Texture.from(canvas)` upload and WebGPU bind-group construction.
  Revisit with a newer pixi.js release; repro is "refresh the editor
  with a shape that has gradient / image fill saved". Expected win:
  ~1.5–2× draw call throughput for heavy decks.

**Approach (proposed):**

1. **Shared procedural-texture registry.** Extend `ResourceManager` with
   `acquireProceduralTexture(key, factory) → Texture` +
   `releaseProceduralTexture(key)`. Keys are structural — a stable
   string hash of `{kind, stops, angleDeg, centerX/Y, width, height}`
   for gradients; analogous for patterns / noise / procedural masks.
   Factory only runs on cache miss. Ref-count identical to the image
   path so a container can `acquire` on redraw and `release` on destroy
   / fill-change without worrying about double-frees.
2. **Per-container fill slot.** Each filled renderer stores the last
   acquired texture key under a Symbol tag (same pattern as `DATA_TAG`).
   On `drawX()` redraw: compute new key → if unchanged, reuse; else
   `release(oldKey) + acquire(newKey)`. Drops the allocation to "once
   per distinct fill descriptor" even during slider drags (every tick
   hits the same (colors, angle±ε) bucket).
3. **LRU cap.** `ResourceManager` evicts the least-recently-acquired
   procedural texture above some cap (e.g. 128 textures) so unbounded
   scrubbing over time doesn't leak GPU memory even if `release` is
   missed somewhere.
4. **Perf scratchpad.** Before tuning, add a debug overlay (gated on
   `?perf=1`) showing FPS, active texture count from ResourceManager,
   and Pixi `renderer.stats`. Without measurement the "fix" is guessing.
5. **Long-session texture GC.** Investigate `TextureGCSystem` in Pixi
   v8 — it has a GC pass already; make sure our procedural textures are
   tagged so it can sweep them. If we mark them as "managed by
   ResourceManager" the built-in GC should leave them alone and ours
   reclaims instead.

**Exit criteria:** running the editor for 10 minutes with active slider
scrubbing (gradient angle, stop colour, shadow blur, stroke width) does
not grow the active texture count beyond ~2× the count of filled
shapes visible on screen. FPS stays ≥ 55 during the scrub.

## Testing strategy

- Each phase ships with Vitest unit coverage for the new primitives
  (schema migrations, geometry helpers, alignment math…).
- Each phase ends with an E2E smoke run (`pnpm --filter web exec
playwright test`). Zero new spec files required unless the phase
  introduces a new user-visible flow worth a regression (e.g. P7
  double-click-to-edit, P8 video transform smoke).
- Visual regression via Playwright `toHaveScreenshot` — reserved for
  P1 (new visual baseline) and P2 (artboard appearance).

## Rollback protocol

- Each phase is an atomic fast-forward on main. If a phase breaks in
  user testing, revert with `git revert -m 1 <merge-sha>` and iterate
  on the re-created branch. Never amend history on main.

## Out-of-scope reminders (do not scope creep)

- Cross-tab sync for presenter view is already done (M19 phase 3).
- AI-anything is deferred to M16–M18.
- Templates + themes with masters is M20.
- PDF / PNG / video export is parked (M28 in original plan).
- Custom DSL editor (Monaco) is M23.
