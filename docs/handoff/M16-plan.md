# M16 — Folder-scoped design system + shared components

**Status:** P1 in progress on `feat/m16-p1-folders`.
**Date:** 2026-05-01.
**Replaces:** old M16 (templates + themes / slide masters).

Folders are the design-system scope (tokens, fonts, components). Any
object can be promoted to a shared component — there are no per-slide
masters.

## Locked decisions

| Topic                      | Decision                                                                                                                                                             |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Folder hierarchy           | **Flat, exactly one level.** Decks must live in a folder. No nesting.                                                                                                |
| Default folder             | **"Drafts"** — auto-created per user; every new deck lands here.                                                                                                     |
| Home page layout           | Step 1: folders grid. Click → step 2: decks grid inside that folder.                                                                                                 |
| Move / copy deck           | Both supported, folder → folder.                                                                                                                                     |
| Cross-folder components    | **No linking.** On move/copy, the component master is duplicated into destination folder as a new master.                                                            |
| Token rebinding on copy    | During duplication, token refs are rewritten to the destination folder's token (matched by name + category). Missing tokens fall back to literal value at copy time. |
| Component scope            | Folder-only. No workspace-wide components.                                                                                                                           |
| Instance overrides allowed | Text content, colors, position of inner elements, position of the whole component on slide.                                                                          |
| Reset overrides            | Inspector button "Reset overrides" — clears all overrides on selected instance.                                                                                      |
| Component animations       | Master animations appear in the slide's animation panel as regular rows — drag-reorderable, retriggerable, fully overridable per-instance.                           |
| Name conflict on duplicate | Append " copy" (no implicit merge).                                                                                                                                  |

## Token rebinding on duplicate — algorithm

When a component is copied with a deck into a new folder:

1. Walk the master's leaves, find every token ref.
2. Look up the token by name + category in destination folder.
   - Hit → rewrite ref to destination token id.
   - Miss → resolve to current literal value in source folder, write literal (no ref).
3. Same rule for any animation params that reference tokens (color tweens etc.).

Visual identity preserved if destination folder has matching tokens;
otherwise look frozen at copy time. No silent breakage.

## Phased breakdown — each on its own branch, merge gate

### P1 — Flat folders + home page _(branch: `feat/m16-p1-folders`)_

- `folders` table: `id, owner_id, name, created_at`. **No `parent_id`.**
- Auto-provision "Drafts" on first sign-in.
- Decks get non-null `folder_id`. Migration: assign all existing decks
  to owner's "Drafts".
- Home page: **two-step UI** — folders grid → click → decks grid.
  Breadcrumb back to folders.
- Folder card: name, deck count, cover (composite of latest deck
  thumbnails).
- Folder CRUD (rename, delete — block delete if non-empty, or
  "move all to Drafts" prompt).
- Move / copy deck UI (right-click on deck → "Move to / Duplicate to"
  modal with folder picker).

### P2 — Design tokens _(branch: `feat/m16-p2-tokens`)_

- Y.Doc per folder for tokens: `colors`, `textStyles`, `effectStyles`.
  CRDT for co-edit.
- Folder settings page (separate route, opened from folder card).
- Token IDs are stable shortids; refs are by id, names mutable.
- Fill picker gains "Token" tab. Text inspector "Style" dropdown.
- Token deletion: warn + show usage list + offer replace/detach.

### P3 — Custom fonts _(branch: `feat/m16-p3-fonts`)_

- Upload UI in folder settings → MinIO `fonts/<folder_id>/<font_id>`.
- `fonts` table: `id, folder_id, family, weight, style,
postscript_name, url, status`.
- On deck load: fetch folder font manifest → inject `@font-face` →
  await `document.fonts.ready` before first paint.
- Font picker in text inspector lists folder fonts first.
- Present-mode preloader extended to include folder fonts.

### P4 — Token consumption polish _(branch: `feat/m16-p4-token-polish`)_

- Palette-first color picker.
- "Detach token" per field.
- Token rename propagates (refs by id).

### P5 — Component master — data model _(branch: `feat/m16-p5-component-model`)_

- Right-click object / group / multi-selection → **Promote to shared
  component**.
- Creates `component:<id>` Y.Doc in folder, holding subtree + relevant
  animation steps (pruned to in-scope targets, leaf ids preserved).
- Original becomes `{type:'instance', componentId, overrides:{...}}`
  node on the slide.
- Renderer resolves instance → master doc subscription → expands
  subtree at render time.
- Override schema:

  ```
  {
    transform: { x?, y? },             // component position on slide
    leaves: {
      <leafId>: {
        text?: string,
        fill?: TokenRef | Color,
        stroke?: TokenRef | Color,
        transform?: { x?, y? }
      }
    },
    animations: {
      <stepId>: { trigger?, delay?, duration?, ease?, disabled?: true }
    }
  }
  ```

### P6 — Component library UI _(branch: `feat/m16-p6-component-library`)_

- Folder settings → **Components** tab. Grid of master thumbnails.
- Editor top-bar **+ Add component** picker drawer → drag onto canvas
  → instance node.
- "Edit master" opens isolated master-edit context.
- Detach instance → expand inline, drop linkage.
- Delete master → warn with usage count, then null all instances or
  remove.

### P7 — Instance sync + overrides _(branch: `feat/m16-p7-instance-overrides`)_

- Master edit → all instances re-render via Y.Doc subscription.
- Resolution: master values, then instance overrides win field-by-field.
- Inspector shows resolved values; editing writes to overrides.
- **Reset overrides** button at top of inspector clears the whole
  `overrides` blob.
- Structural deletion in master → drop dangling override entries
  (undo-logged).

### P8 — Component animations as first-class steps _(branch: `feat/m16-p8-component-animations`)_

- Master animation steps appear in the slide animation panel as
  regular rows (badged with component icon).
- Drag-reorderable among slide-native steps.
- Per-step override: trigger / delay / duration / ease / disable.
- "Reset animation overrides" sub-action of master Reset button.
- Master adds a step → appears at bottom of instance's section in every
  slide using it.
- Master deletes a step → row disappears, override dropped.
- Timeline scrubbing keeps working; instance steps compile into the
  slide GSAP timeline.

## Ship order

P1 → P2 → P3 → P4 → P5 → P6 → P7 → P8.

P2 / P3 can interleave. P5–P8 sequential.
