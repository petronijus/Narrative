# M16 — Flat-component refactor + master-editor unification

**Branch:** `feat/m16-p6-master-expansion` (pushed)
**Range:** `87a7435..44a0bc3` (8 commits)
**Status:** Working in dev. Existing components in dev DB must be cleared (incompatible Y.Doc shape — see Migration).

## What changed (user-facing)

1. **Components are now flat** — `promoteToComponent` rejects selections containing a `componentInstance`. The right-click menu disables "Promote to shared component" when the selection is mixed with an instance. Detach the inner instance first if you really need composition.

2. **Component instance = master 1:1** — inserting a component (toolbar picker click _or_ drawer drag-drop onto canvas) places the new instance at the master's authored slide-space position (`bbox.x, bbox.y, bbox.w, bbox.h`). The master is the canonical placement, not the slide centre. The drag-drop drop point is intentionally ignored — placement tracks the master.

3. **Inspector → "Master placement" → "Reset position"** — snaps an instance's `x / y / rotation` back to the master's _current_ bbox (re-reads the master each click, so a master moved later reflects the latest). Width/height + opacity are intentionally untouched.

4. **Master editor = full deck editor** — `Edit master` drops you into the same `EditorLayout` you use for slides: Toolbar, Inspector, animation timeline, undo/redo, peer cursors, transform handles, every shape tool, snap guides, rulers, the works. Slides panel is hidden, slide creation is structurally impossible (the only entry point lived inside `SlidesPanel`). Picker / Present / Preview-animations buttons are hidden in master mode (no nested components, no presentation surface).

5. **Violet selection chrome** for ComponentInstance selections (Figma-style purple). Mixed selections (instance + primitive) fall back to blue.

6. **Auto-select on insert** — picker click and picker drag-drop both replace the prior selection with the freshly-inserted instance.

7. **First-insert size correctness** — the picker insertion paths await the master's first sync (capped at 3 s) before stamping the instance, so a cold cache doesn't fall through to 400×300 on the first click.

## What changed (under the hood)

- **`writeComponentMasterTree.ts`** — no longer recursively encodes nested arrays/objects as `Y.Array` / `Y.Map`. Now mirrors the deck-side `bindings.ts:plainObjectToYMap`: shallow `yMap.set(key, plainValue)`, with `text` strings promoted to `Y.Text`. The deep encoding broke `pathRenderer` (indexed `anchors[0]` and got undefined because the field was a `Y.Array`); same hazard for gradient stops and group children. The master Y.Doc now carries the _exact_ same per-object shape as a deck slide.

- **`mutations.ts:addObjects`** — now mirrors `addObject`'s `text` string → `Y.Text` promotion. Required so `detach` (which feeds plain-string text bodies through `addObjects`) doesn't push raw strings into the slide doc.

- **`readMasterDoc.ts`** — deep-walks every `Y.Map` / `Y.Array` / `Y.Text` so the snapshot is fully plain JS. Fixes a hidden re-integrate crash on `detach` of an instance with rich content (`_YMap._integrate` `forEach` over null when shoving already-integrated shared types into the slide doc). Adds `readMasterFullBbox(componentId)` for the placement paths that need `(x, y)` in addition to `(w, h)`.

- **`componentInstanceRenderer.ts`** — now calls `markRenderDirty()` after each reconcile branch (placeholder, refit, full child diff). The cache-listener path runs off the `SceneGraph.applyChanges` flow, and P12b (`autoStart: false`) means nothing else wakes the render scheduler — fixes the "ghost on promote, paints when you nudge" bug. Also adds `thumbnailMount` that exposes a ready-promise resolved on first non-null snapshot (3 s timeout), so cold-reload thumbnails don't freeze the placeholder.

- **`promoteToComponent`** — rejects nested components (selection containing a `componentInstance`).

- **`EditorLayout`** — new `masterMode?: boolean` prop. When true, hides `SlidesPanel`, collapses `slidesInset` to 0, and threads `masterMode` to `<Toolbar>` so it hides Add Component / Present / Preview-animations.

- **`DeckRoleContext`** — new `DeckRoleStaticProvider` for surfaces outside the deck path that still feed `useDeckRole()`. The master editor uses it to grant `role='owner'` + threading `folderId` from the route.

- **`ComponentMasterEditor`** rewritten to mount `EditorLayout masterMode` wrapped in `DeckRoleStaticProvider` + `FolderDocProvider` + `MediaUploadProvider` + the standard provider stack. **`ComponentMasterShell.tsx` deleted** (330 LOC of bespoke chrome, superseded).

- **Selection chrome** — `handleVisuals.tsx` exports `SelectionAccent` + `ACCENT_BORDER` / `ACCENT_STROKE` lookups; `TransformHandles` accepts `accent` and forwards to `<Handle>` + the SVG outline. `EditorLayout` derives accent from selection: `'component'` if every editable id is a `componentInstance`, else `'default'`.

## Migration

**Existing components in your dev DB are incompatible** (deep-encoded Y.Array path anchors, gradient stops, etc.). Clear them and re-promote. SQL:

```sql
DELETE FROM components WHERE folder_id = 'your-folder-id';
-- and drop the corresponding `component:<id>` Y.Doc rows
DELETE FROM yjs_docs WHERE name LIKE 'component:%';
```

(Tables may differ — check `infra/migrations/` for current schema.) New promotes after `44a0bc3` will land in the shallow shape.

## Known issues / follow-ups

- **`Mod+Enter`** in master mode still navigates to `/deck//present` (404). Trivial fix: skip / re-target the shortcut when `masterMode` is on. Not blocking.
- **PixiJS `HTMLTextSystem: Failed to clean texture`** warnings still leak through on text destroy. Not introduced by this work; pre-existing P5c-era nuisance.
- **`HocuspocusProvider: An authentication token is required`** warnings appear when the picker drawer / master cache opens its WS in a state where the token getter hasn't registered yet. Functional under `BYPASS_AUTH=true`; pre-prod check needed.
- **Pre-existing uncommitted work** in your tree (server `presence.ts/test`, `api/client.ts:listFolderActiveEditors`, `useShortcuts` `canHandle` gate, `SlidesPanel` Mod+V yield, `clipboard`/`slideClipboard` changes, `FolderDecks` debug log, `SceneGraph` and `slide-model/observe` edits) — left untouched in this branch. Not part of these commits.
- **DB cleanup of orphaned components** after promote-undo is still intentionally not done — empties stay in the components table until the user removes them from folder settings.

## Test plan (manual)

After clearing the dev DB:

1. Promote a rectangle → master created. Right-click an instance → "Edit master" → land in the full editor (toolbar, transforms, animations, undo). Slides panel absent. Move/resize/animate inside the master.
2. Drop the instance back on the deck slide via the picker → instance lands at the master's authored bbox, 1:1.
3. Move the instance, hit "Reset position" in the inspector → snaps back to master coords (current latest).
4. Try promoting a selection that includes an existing instance → menu item disabled.
5. Promote a text + path + group → detach an instance → no `_YMap._integrate` crash, content lands at the same visual position.
6. Cold-reload the deck → thumbnails render real content, no indigo/red placeholders frozen into the bitmap.
7. Select an instance → violet handles. Add a rectangle, multi-select instance + rectangle → blue handles.

## Commits in this drop

```
44a0bc3 fix(m16): wire missing providers + flatten master Y.Doc encoding
ac44754 feat(m16): master editor uses full editor surface (drop bespoke shell)
0903f29 feat(m16): instance position = master bbox + Inspector "Reset position"
e6c3d66 fix(m16): detach + promote crashes, reject nested components
6e568a5 fix(m16): first-insert component lands at master bbox, not fallback
1d583f7 feat(m16): auto-select component instance on insert from picker
217c87a feat(m16): violet selection chrome for component instances (Figma-style)
8347443 fix(m16-p6): paint component instances on master sync, not on next nudge
```
