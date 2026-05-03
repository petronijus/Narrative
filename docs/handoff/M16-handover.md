# M16 — Folder-scoped design system + shared components — Handover

**Branch:** `feat/m16-p6-master-expansion` (origin pushed; **NOT merged** — wait for explicit go-ahead before `gh pr merge`).
**Last commit:** `53007e6 fix(m16-p6): rendered-on-move ghost + native prompt → modal`.
**Status:** all 8 phases of M16 implemented + multiple round-trip fixes from manual QA. Code-reviewer and qa-tester (Opus) passes already done; remaining items are user-facing polish discovered in live testing.

## Pick up where we left off

```bash
git fetch
git checkout feat/m16-p6-master-expansion
git pull
pnpm install
pnpm dev      # web :5173, API :3001, Hocuspocus :3002
```

No DB migration to run for this branch — schema didn't change since `0010` (already applied locally before push).

## Phases shipped (P1–P8 + cleanup)

| Phase      | What                                                                         | PR (merged on main) | Commits on this branch                               |
| ---------- | ---------------------------------------------------------------------------- | ------------------- | ---------------------------------------------------- |
| P1         | Flat folders + 2-step home + Drafts                                          | #40                 | —                                                    |
| P2         | Folder Y.Doc tokens (colors / text styles), seeding, fill picker integration | #41                 | —                                                    |
| P3         | Custom fonts consolidated into folder-scoped pipeline                        | #42                 | —                                                    |
| P4         | Token usage scan endpoint + delete-time warning modal                        | #44                 | —                                                    |
| P5         | Component master data model + REST + Hocuspocus + promote-to-component       | #43                 | —                                                    |
| P6         | Master expansion in renderer + library drawer + master-edit route + detach   | —                   | 1fc507e, fc0e6af, 6fdfbaf, eeb9d1c, d223855          |
| P7         | Instance overrides (text/fill/stroke/position) + master-delete repair UX     | —                   | 6243c79, 354efe5                                     |
| P8         | Component animations as first-class slide rows + per-instance overrides      | —                   | becb27f, c36884b                                     |
| Punch-list | qa-tester / code-reviewer fixes                                              | —                   | d36a394, 10a4203, 6e583fe, 1d61b51, a25cb64, 53007e6 |

## Architecture (mental model)

- **Folder = design-system scope.** One Y.Doc per folder (`folder:<id>`) holds tokens (colors, textStyles, effectStyles slot reserved). Decks live inside one folder.
- **Component master = its own Y.Doc** (`component:<id>`) shaped like a single-slide deck (`slides[0].objects`, `slides[0].animations`). Persisted via a `component_updates` table; routed by Hocuspocus.
- **Instance on a slide = `componentInstance` slide-model object.** Holds `componentId`, position, size, and `overrides: { transform, leaves: { <leafId>: ... }, animations: { <stepId>: ... } }`. Renderer expands the master subtree at draw time, then applies overrides leaf-by-leaf.
- **Connection cache** (`apps/web/src/state/componentDocCache.ts`) — singleton, ref-counted, 30 s linger. One Hocuspocus connection per master regardless of how many instances reference it. Renderer + drawer + master editor all share this.
- **Override resolver** (`packages/slide-model/src/resolveOverrides.ts`) — pure functions `resolveInstanceTree` + `resolveInstanceAnimations`. Identity-preserving for unmodified leaves; dangling override entries (master leaf deleted) silently preserved so re-adding a leaf restores the customisation.
- **Animations** — `useMergedAnimations` (`apps/web/src/state/useMergedAnimations.ts`) merges native slide steps with per-instance master steps (target ids remapped to `instance:<i>:<l>`). Same compiler, single GSAP timeline.

Drawn diagram in `docs/handoff/M16-plan.md` — reference doc, mostly current.

## Open issues (verified, ordered by impact)

### 1. Stale "Auth token required" Hocuspocus warnings

- **Symptom:** browser console logs `[HocuspocusProvider] An authentication token is required, but you didn't send one. Won't try again.` 4–6× on editor mount.
- **Diagnosis:** orphan `componentInstance` nodes on existing slides whose masters were deleted before P5 stabilised. Server returns Forbidden when `resolveComponentAccess` finds no row; HocuspocusProvider client logs the generic auth message.
- **Workaround until cleanup:** in DevTools, run `await fetch('http://localhost:3001/folders/drafts-958e2b33e6952467a1fbe3c71fc802e6/components').then(r => r.json())` to see live components, then delete instance nodes from slides that reference any other componentId.
- **Real fix backlog:** server should distinguish "missing component" from "auth required" so the client logs something meaningful. File: `apps/server/src/hocuspocus/index.ts` around the `component:` branch — replace `throw new Error('Forbidden')` for missing-component case with a more specific error code, and have the client surface a useful message.

### 2. Promote → first frame still occasionally "ghost"

- **Symptom:** very rarely, the placeholder doesn't flip to content even after the 750 ms recheck schedule lands.
- **Mitigation already in place:** `attachToComponent` (`componentInstanceRenderer.ts`) reschedules reconcile via rAF×2 + 250 ms + 750 ms timers. Move the instance once and content paints.
- **Real fix backlog:** the cache's `docObserver` registration may race with Hocuspocus's first delivery in dev. Add a `provider.once('synced', () => fireListenersImmediately())` path or compare `Y.encodeStateVector(doc).byteLength` against the placeholder fallback. Probably 30 minutes of work.

### 3. Pixi v8 destroy noise on edit→present transition

- **Symptom:** `[Canvas] Application.destroy threw, continuing teardown` — actually we silenced this in `1d61b51`. The remaining `PixiJS Warning: HTMLTextSystem: Failed to clean texture` is **Pixi-internal** and harmless.
- **Real fix backlog:** upstream Pixi v8 issue. Ignore.

### 4. `useFolderComponents` cache + components without thumbnails

- **Symptom:** picker drawer rows show ⌘ icon instead of a thumbnail. P5 reserved a `thumbnail_key` column but no upload pipeline writes to it yet.
- **Real fix backlog:** add a server-side thumbnail render of the master's first frame (similar to deck thumbnails — see `apps/server/src/routes/decks.ts` thumbnail handling). Wire it into the master editor's Done button so the thumbnail refreshes when the master changes.

### 5. Strict-mode-only test mock gaps

- The full `pnpm --filter web test` OOMs in strict-mode (Pixi-in-jsdom + many test files). Run per-folder:
  - `pnpm --filter web test -- --run src/state` — clean
  - `pnpm --filter web test -- --run src/ui` — `Inspector.test.tsx` has 11 pre-existing failures; my changes don't add to that count.
  - `pnpm --filter @narrative/slide-model test` — 281/281 pass.
  - `pnpm --filter @narrative/server test` — 7-failure baseline (pre-existing tus + decks).

### 6. No e2e specs for visual scenarios

- `apps/web/e2e/m16-component-flows.spec.ts` covers REST shape + cache counter symmetry. The visual round-trip scenarios (promote → master edit → instance reflects, present-mode parity, override badge flip) are still manual-only.
- Real fix backlog: extend the spec with Playwright canvas screenshots, OR get Pixi's `app.renderer.extract.canvas` into the test asserts.

## Test plan (what to walk through after pulling)

Same A–G plan as before — repeated here for offline use.

### A. Promote → expand → master propagates back

1. Open a deck in any folder (Drafts is fine).
2. Draw 2 rectangles (one red, one blue), select both.
3. Right-click → **Promote to shared component** → modal opens.
4. Type a name → Promote.
5. Originals replaced by 1 placeholder; within a few hundred ms the rectangles render inside.
6. Inspector → **Edit master** → master canvas opens at `/folder/<id>/component/<id>`.
7. Add a third green rectangle. Click **Done editing**.
8. Back on the deck, instance shows 3 rectangles. Open in another tab → also 3.

### B. + Add component drawer

1. Toolbar shows the component icon at first paint (alongside other tools — was popping in late before the DeckRoleContext fix).
2. Click → drawer slides in from the right with all folder masters + "Used N times".
3. Click row → instance lands at slide centre.
4. Drag row onto canvas → instance lands at drop point.

### C. Override editor

1. Select an instance. Inspector shows leaves panel — one row per master leaf.
2. Override fill via the folder palette → row badge flips to **Modified**.
3. Click **Reset to master** → reverts.
4. Top **Reset overrides** clears every leaf in one Cmd+Z step.

### D. Component animations in the timeline

1. Open the master, add a slideIn animation.
2. Back on the deck slide, animation panel shows a **Component** group with the master step inside.
3. Edit the row's delay → Modified badge.
4. Drag a step within the group → re-orders only inside the instance; doesn't mutate the master. Cmd+Z is one step.

### E. Present mode parity

1. Cmd+Enter on a deck containing instances.
2. Master animations fire on the right leaves. No console errors (warnings are harmless).

### F. Master delete + repair

1. Folder Settings → Components → delete a master that has live instances.
2. Instances on slides flip to **"Missing component"** placeholder.
3. Inspector shows Detach (preserve nothing) + Replace…
4. Replace… opens the picker; pick a new master → instance rewrites.

### G. Detach instance (master alive)

1. Right-click an instance → **Detach instance**.
2. Becomes individual slide objects positioned + scaled exactly where the bbox was (centred letterbox).
3. Cmd+Z restores the instance.

## Files most likely to need follow-up edits

- `apps/web/src/renderer/objectRenderers/componentInstanceRenderer.ts` — the renderer's "ghost vs content" branching + reconcile loop.
- `apps/web/src/state/componentDocCache.ts` — connection cache; bug #2's likely fix lives here.
- `apps/server/src/hocuspocus/index.ts` — bug #1's likely fix lives here.
- `apps/web/src/ui/PromoteComponentDialog.tsx` — newly added; if you want a richer dialog (folder picker, thumbnail preview), this is the surface.
- `apps/web/src/ui/EditorContextMenu.tsx` — context menu, promote flow, replace, detach, edit-master entry.
- `apps/web/src/ui/Inspector.tsx` — leaves panel, missing-master repair panel, animations section in the instance inspector.
- `apps/web/src/ui/AnimationTimeline.tsx` + `ComponentAnimationGroup.tsx` + `ComponentAnimationRow.tsx` — timeline UI for component steps.
- `packages/slide-model/src/resolveOverrides.ts` — pure resolver (don't put React or Yjs writes in here).
- `packages/slide-model/src/instanceOverrides.ts` — Yjs mutation helpers; new override fields go here.

## Memory rules (auto-loaded in every session in this repo)

Two persistent notes already in `/Users/petronijus/.claude/projects/-Users-petronijus-Documents-Dev-Narrative/memory/`:

1. **All sub-agents must run on Opus.** Always pass `model: 'opus'` to the `Agent` tool. Sonnet output needed reviewer rework on M16 P5/P6.
2. **Never auto-merge PRs.** Push branches and open PRs is OK. `gh pr merge ...` is forbidden without an explicit user message containing "merge it" / equivalent.

These rules apply on the new machine too once you pull the memory dir (or just trust the assistant to read it).

## Useful commands

```bash
# Restart everything cleanly
docker compose -f infra/docker-compose.yml --env-file .env up -d
pnpm --filter @narrative/server db:migrate
pnpm dev

# Live state
curl -s http://localhost:3001/folders/drafts-958e2b33e6952467a1fbe3c71fc802e6/components | jq
curl -s http://localhost:3001/folders/drafts-958e2b33e6952467a1fbe3c71fc802e6/component-instance-counts | jq

# Y.Doc count debug counter
# In DevTools console:
window.__yjsDocCount

# Wipe orphan component_updates / components (use with care)
docker exec infra-postgres-1 psql -U narrative -d narrative -c \
  "DELETE FROM components WHERE folder_id NOT IN (SELECT id FROM folders);"
```

## Next milestone (after M16 ships)

Per `docs/handoff/polish-phase-plan.md` (renumbered 2026-05-01):

- **M17** — Comments
- **M18** — Version history
- **M19** — Speaker notes (already shipped)
- **M20–M22** — AI work
