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
