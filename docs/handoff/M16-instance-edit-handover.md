# M16 — Component-Instance Edit Mode (handover)

Branch: `feat/m16-p6-master-expansion` · Last commit: `786e568`

## What shipped

A full doubleclick-into-instance edit experience for component instances on slides.

### Behaviour

- **Doubleclick** an instance on the canvas → enters instance-edit mode (outer dashed violet chrome on the instance bbox).
- **Single-click a leaf inside** → selects the leaf with normal blue selection chrome + transform handles.
- **Drag the leaf body** → moves the leaf (writes absolute `x, y` overrides). Shift constrains to dominant axis.
- **Resize / rotate** via the blue handles → writes `x/y/width/height/rotation` overrides via `setLeafOverridePatch`.
- **Doubleclick again on the active instance with a text leaf selected** → opens an inline `<textarea>` over the leaf for plain-text editing. Esc / blur / click-outside commits, Enter inserts a newline.
- **Inspector** shows the normal per-object inspector for the active leaf — every mutation silently routes through `setLeafOverridePatch` instead of `updateObject`. No override badges, no per-field reset; only the global "Reset to master placement" remains in the component section.
- **Auto-fit on edit-end** — when leaves move/resize, the outer instance bbox grows on pointer-up to enclose the new content union. Done by writing `instance.overrides.masterBboxOverride` (the renderer's `applyInnerFit` reads it instead of the master snapshot's bbox), with `data.x/y/width/height` adjusted in lock-step so the inner letterbox `scale = min(W/bbox.w, H/bbox.h)` stays constant — content does not visually shift.
- **Reset to master placement** — restores `instance.x, y, width, height` to the master's authored bbox AND clears `masterBboxOverride` + `transform` from the existing overrides Y.Map. Per-leaf overrides (text, fill, etc.) are left intact.

### Multiplayer

- All override mutations go through `doc.transact(..., LOCAL_ORIGIN)`.
- `slideObserve.processMapEvent` walks up the parent Y.Map chain when `event.target` lacks an `id`, then re-emits the owning slide-object's top-level field as plain JSON — without this, deep writes inside `instance.overrides.leaves[id]` never reached the renderer.
- Instance leaves rendered on remote peers' canvases now repaint immediately; the previous "needs refresh to see it" symptom was caused by `componentInstanceRenderer.reconcileFromSnapshot` deriving both `prevList` and `nextList` from the already-mutated `data.overrides`. The renderer now caches `lastResolvedList` on the slot and reuses it as `prevList`.
- Master delete still cascades via the folder Y.Doc's `deletedComponentIds` array (every peer with the deck open sweeps the matching instances).
- `activeInstanceEditId` and `activeLeafId` are local React state — never replicated. Reactive guards in `EditorLayout` clear stale ids if a peer removes the instance or leaf mid-edit.

## Architecture summary

### Override storage (CRDT-safe)

```
ComponentInstanceOverrides {
  transform?: { x, y }                              // legacy inner nudge — auto-fit clears it
  masterBboxOverride?: { x, y, width, height }      // virtual master bbox for letterbox math
  leaves?: Record<leafId, LeafOverridePayload>      // generic Partial<SlideObject> patch
  animations?: Record<stepId, …>                    // unchanged from earlier milestones
}
```

The `overrides` slot on the instance Y.Map is a **Y.Map**, with each leaf override as its own nested Y.Map for clean CRDT merge semantics. Two write helpers exist:

- `setLeafOverridePatch(ctx, instanceId, leafId, patch)` — generic per-leaf write into `overrides.leaves[id]`. Used by Inspector, leaf drag, transform handles, and the inline text editor.
- `applyInstanceFit(ctx, instanceId, outer, masterBboxOverride)` — atomic auto-fit write. Mutates `overrides.masterBboxOverride` IN PLACE on the existing Y.Map; never replaces the slot. Same for `resetInstanceFit` which clears it.

**⚠ DO NOT** call `updateObject(ctx, instanceId, { overrides: plainObj })`. That would replace the `overrides` Y.Map with a plain JS object; the next `setLeafOverridePatch` would then create a fresh empty Y.Map and silently drop every other override. This bug was the root cause of multiple visible regressions during this milestone.

### Renderer

`componentInstanceRenderer.applyInnerFit()` reads `data.overrides?.masterBboxOverride ?? snapshot.bbox` to derive the inner letterbox scale. Auto-fit ensures the override and the outer rect change together so the scale stays pixel-stable.

`hitTestInstanceLeaf()` walks `slots.childMap` in reverse paint order. Lines / arrows use a point-to-segment distance threshold; other leaves use a 5-px-padded local AABB (`INSTANCE_HIT_PAD`).

`SceneGraph.getContainerBoundsFromData()` computes a leaf's slide-space corners by walking `toGlobal()` from the leaf container — used by the InstanceEditHandles outline + handle layout, the inline text editor, and the auto-fit pass.

### Inline text editor

`apps/web/src/ui/InstanceLeafTextEditor.tsx`:

- Plain `<textarea>` positioned over the leaf at slide-space coords (CSS scale on the artboard handles zoom).
- Keystrokes are debounced ~150ms before writing the override; flushed on commit, unmount, and Esc to guarantee no edits are lost.
- Plain text only on instance copies (no Y.Text rich-text formatting). Style overrides (font, weight, color, …) still go through the Inspector.

## Open issues / next iteration

### Animations of components

Master animations are merged into the slide timeline via `useMergedAnimations`, but there is no UI for editing per-instance animation overrides outside of disabling/reordering. The schema slot `overrides.animations` is wired and tested, but the inspector still treats master timing as authoritative for fields the user hasn't touched. Likely follow-ups:

- Expose `trigger`, `delay`, `duration`, `ease` per instance step in the Animation panel.
- Decide UX for "this instance plays the master step at a different time" vs. "drop the master step entirely on this instance" (`disabled: true` already supported).
- Confirm the merged-step ordering keeps stable across peers when one peer reorders.

### Instance overrides in the Inspector panel

Per the latest design conversation, override management is intentionally not surfaced (no badges, no per-field reset). The single global "Reset to master placement" is fine for size + position but does NOT clear leaf overrides. Possible follow-ups the user mentioned:

- A second Reset action: "Reset all overrides on this instance" (already wired internally as `resetAllOverrides`, but not exposed in the new ComponentInstance inspector).
- Visual cue when a property differs from master without making it noisy (e.g. a subtle dot on the section title, not on every input).
- Per-leaf reset from a right-click context menu on the leaf inside edit mode.

### Inline text editor polish

Working but rough:

- No rich-text formatting on instance copies. If we want italic/bold runs per-instance, the override schema needs to grow to store a Y.Text or a delta-style structure rather than a plain string.
- Font/colour rendering in the textarea is best-effort (CSS approximation of the Pixi text style). Glyph metrics will not match exactly — there's a small visual jump when the editor closes and Pixi takes over.
- A body→headline style change while the editor is open can produce a temporarily cropped rendering because `data.height` on the leaf still reflects the old style. The auto-fit only fires on drag/resize; a pure style change does not trigger it.

### Misc

- **Pixi v8 WebGL warning** `glTexSubImage2DRobustANGLE: Offset overflows texture dimensions` is non-fatal noise from the offscreen thumbnail renderer's HTMLText atlas-grow path. Pixi swallows it; rendering is correct on the next frame. Suppressing cleanly would require patching Pixi or pre-sizing atlases. Leave alone.
- **Instance bbox on master width-vs-height aspect change** — `masterBboxOverride` keeps content in place as long as scale is uniform. If the user resizes the outer instance bbox via the standard transform handles in a non-uniform way after auto-fit has fired, behaviour matches Figma frames (content letterboxes inside the new bbox, scale recomputes). This is fine but worth re-validating if we add aspect-lock to instances.

## Files of interest

| File                                                                 | Role                                                                                                                                   |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/shared/src/slide.ts`                                       | `LeafOverridePayload`, `ComponentInstanceOverrides.masterBboxOverride`                                                                 |
| `packages/slide-model/src/instanceOverrides.ts`                      | `setLeafOverridePatch`, `applyInstanceFit`, `resetInstanceFit`, `seedInstanceTextCopy`, `removeComponentInstancesFromDoc`              |
| `packages/slide-model/src/resolveOverrides.ts`                       | Generic `mergeLeafOverride` for the resolver                                                                                           |
| `packages/slide-model/src/slideObserve.ts`                           | `processMapEvent` deep-walk-up logic                                                                                                   |
| `apps/web/src/components/EditorLayout.tsx`                           | Doubleclick into edit mode, leaf drag, fit helper, inline text editor wiring                                                           |
| `apps/web/src/ui/InstanceEditHandles.tsx`                            | Outer dashed chrome + leaf transform handles + onEditEnd callback                                                                      |
| `apps/web/src/ui/InstanceLeafTextEditor.tsx`                         | Inline plain-text overlay                                                                                                              |
| `apps/web/src/ui/Inspector.tsx`                                      | `InstanceLeafInspector`, ComponentInstance section, MultiSelect "Create component template" button, narrowed Reset to master placement |
| `apps/web/src/renderer/objectRenderers/componentInstanceRenderer.ts` | `applyInnerFit` reads `masterBboxOverride`, `hitTestInstanceLeaf`, `getInstanceLeafContainer`, `lastResolvedList` slot                 |
| `apps/web/src/renderer/SceneGraph.ts`                                | `getContainerBoundsFromData`, `getSlideOriginX/Y`, dev-only `getInstanceLeafBounds`                                                    |
| `apps/web/src/state/SelectionContext.tsx`                            | `activeInstanceEditId`, `activeLeafId`, `selectLeaf`, `enterInstanceEdit`, `exitInstanceEdit`, `clearLeaf`                             |
| `apps/web/src/components/DeckShell.tsx`                              | `ComponentDeleteCascadeEffect` (CRDT path + window-event fast path)                                                                    |
| `apps/web/src/state/FolderDocProvider.tsx`                           | `deletedComponentIds` Y.Array + `markComponentDeleted`                                                                                 |
| `apps/web/e2e/component-instance-leaf-handles.spec.ts`               | Playwright spec asserting handle bounds match leaf bounds at multiple zooms                                                            |

## Test status

- `pnpm -w typecheck` clean across all 7 workspaces.
- `pnpm --filter @narrative/slide-model test` 272 tests passing (incl. 31 instanceOverrides + 37 resolveOverrides).
- Inspector vitest suite has a pre-existing `@/lib/utils` alias bug present on `main` too — unrelated to this milestone.
- Playwright `component-instance-leaf-handles.spec.ts` passes; assertion bounds are within 2 px at 100% and 50% zoom.

## Continuing

Next obvious threads:

1. Animations: expose `overrides.animations` editing in the per-instance row of the Animation panel.
2. Inspector polish: subtle override indicators + `resetAllOverrides` button surfaced again.
3. Inline text editor parity with the slide-level overlay (Y.Text in override slot for rich runs, glyph-accurate metrics).
