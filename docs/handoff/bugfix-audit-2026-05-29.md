# Bug-hunt audit + fixes — 2026-05-29

Whole-repo bug sweep (five parallel subsystem reviews: slide-model,
animation, renderer, server, web editor) followed by fixes for the four
highest-value findings. This doc records what was fixed, how it was
verified, and the audit findings that are **still open** so they don't
get lost.

## Fixed in this branch

### #1 — Texture/sprite leak on rapid asset swap (renderer)

`apps/web/src/renderer/objectRenderers/imageRenderer.ts`
`apps/web/src/renderer/objectRenderers/videoRenderer.ts`

`startLoad` (image) and the `startLoad → loadAuthoredPoster / video-info
→ applyVideoInfoResult → loadPosterTexture` chain (video) had no
abort/generation token for the **reload** case — the `ABORTED_TAG` was
only set on `destroy`. Changing an image/video's asset twice before the
first decode finished ran two async closures concurrently; the second to
finish overwrote the acquired-URL + sprite-wrap tags **without releasing
the first texture or destroying the first `Container`** → permanent
ResourceManager refcount leak (GPU memory) + orphan node in the scene
tree.

Fix: a monotonic **load-generation counter** per container
(`LOAD_GEN_TAG`). `startLoad` bumps it and captures `myGen`; every async
continuation re-checks `isStale(container, myGen)` (destroyed **or**
superseded) after each `await` and bails — releasing any texture it
acquired — before mutating tags. For video, `myGen` is threaded through
`loadPosterTexture`, `applyVideoInfoResult`, `loadAuthoredPoster`, and
the poll loop (`startPolling`), with a staleness guard placed _before_
the synchronous teardown in `loadPosterTexture` so a superseded load
can't tear down the current valid poster. This mirrors the slot-identity
re-check already used in `imageFillLoader.ts`.

### #2 — Stale animation observer after slide Y.Map replacement (slide-model)

`packages/slide-model/src/slideObserve.ts` — `subscribeToSlideAnimations`

The function bound `observeDeep` to the slide's `animations` Y.Array once
and never rebound. `moveSlide` (and Hocuspocus sync swapping a locally
hydrated empty Y.Map for the remote one) deletes-and-reinserts the
slide's Y.Map under the same `id`, leaving the observer on a detached
array. Its sibling `subscribeToSlideObjectsWithFlush` already had the P14
rebind; this one didn't. Symptom: reorder the active slide (or have it
sync from a peer), then edit an animation → the timeline panel silently
stops updating until you switch slides.

Fix: added a `ctx.slides.observe(slidesObserver)` that re-resolves the
slide's animations array by id and, on identity change, detaches the old
observer, rebinds to the fresh array, and re-emits the snapshot. The
original "no emit when the slide is absent at subscribe time" contract is
preserved (initial `callback` only fires when the array was found).
Regression test added: `slides.observe.test.ts` → "keeps firing after the
slide Y.Map is replaced by moveSlide (rebind)".

### #4 — `MediaUploadProvider` never cleaned up on unmount (web state)

`apps/web/src/state/useMediaUpload.tsx`

No effect aborted in-flight `tus.Upload`s or cleared transcode poll
timers. `startTranscodePoll` self-reschedules every 2 s forever (even on
network error). Navigating back to the deck list while a video was
transcoding left a runaway poll loop fetching `/video-info` and calling
`setUploads` on an unmounted component indefinitely.

Fix: a `disposedRef` flag (reset to `false` in the effect body so React
Strict Mode's unmount→remount on the same instance doesn't wedge it; set
`true` in cleanup). `poll` bails on `disposedRef.current` at entry, right
after the fetch await, and before the error-path reschedule. An unmount
cleanup effect aborts every live `tus.Upload` (`upload.abort()` —
local-only, not server-terminate) and clears every pending poll timer.

### #7 — Folder cascade-delete not transactional (server)

`apps/server/src/routes/folders.ts` — `DELETE /folders/:id`

`db.delete(decks)` then `db.delete(folders)` ran as two separate
top-level statements. A crash between them left the decks (and cascaded
`deck_updates` / `deck_permissions` / `share_links` / `media_assets`)
destroyed but the now-empty folder present — permanent partial data loss,
no rollback.

Fix: wrapped both deletes in `db.transaction(async (tx) => …)`, matching
the deck-create pattern in `decks.ts`. The best-effort MinIO blob sweep
stays outside the transaction (it's loss-tolerant by design).

## Verification

- `pnpm typecheck` — clean (all 7 projects).
- `pnpm lint` — 0 errors (202 pre-existing warnings, none in touched files).
- `pnpm --filter @narrative/slide-model test` — **258 pass** (incl. new rebind regression).
- `pnpm --filter server test` — **393 pass, 1 skipped**.
- `pnpm --filter web test` — touched code adds **zero** new failures.
  Pre-existing/environment failures on this machine (confirmed identical
  via `git stash` on the clean tree): `thumbnails.test.ts`,
  `componentDocCache.test.ts`, `mediaCache.test.ts` (Hocuspocus/WebGL
  mocks), `VideoOverlay.test.tsx` (`new Hls()` mock not a constructor),
  `imageRenderer.test.ts` thumbnail test (asserts old `variant: 'thumb'`
  vs current `'preview'`). These predate this branch.
- **e2e NOT run.** CLAUDE.md references a `pnpm --filter web test:e2e`
  script that does not exist; e2e runs via `playwright test` and the
  config has no `webServer` block, so it needs the full backend stack
  (Postgres + MinIO + server + Hocuspocus) and a running dev server
  already up. On Ubuntu 26.04 it also needs `PLAYWRIGHT_USE_SYSTEM_CHROME=1
PLAYWRIGHT_NO_VIDEO=1`. Not booted for these logic-level fixes.

> Follow-up worth doing: the renderer async-swap race (#1) is exactly the
> kind of bug `renderer-visual.spec.ts` should guard. A deterministic
> e2e that swaps an image asset twice within one frame and asserts no
> orphan nodes / stable texture count would lock in the fix.

## Still open (audited, NOT fixed)

From the same sweep — ordered roughly by value. None touched in this branch.

**Medium**

- **Selection not pruned when a selected object disappears** —
  `state/SelectionContext.tsx` + `components/EditorLayout.tsx:787`. A peer
  deleting your selected object leaves a phantom id in `selectedIds`,
  broadcast over awareness; `objects.find(...)` returns `undefined`.
- **Thumbnail textures leak per re-render** — `imageRenderer.ts:~788`,
  `videoRenderer.ts:~1173`. `thumbnailMount` uses `Texture.from(img)` but
  never tags it, so `destroy` doesn't release it and Pixi's
  `Sprite.destroy()` doesn't free the texture by default.
- **CSRF defense documented but absent** — `auth/session.ts:26` claims a
  paired token in `csrf.ts`; no such file or token exists. `sameSite:'lax'`
  mitigates today, but the comment is a lie and there's no second layer.
- **`/metrics` unauthenticated** — `metrics/index.ts:20` (own `TODO(M29)`).
- **`duplicateObject` → NaN coords / raw Yjs handles on read-back** —
  `mutations.ts:235,303`. NaN x/y for objects with optional position;
  flat `Object.fromEntries(entries())` returns live `Y.Array`/`Y.Map`
  handles for a duplicated table.
- **`bulkUpdateObjects` clobbers `Y.Text`** — `mutations.ts:324`. Raw
  `yMap.set` skips the in-place `Y.Text` handling `updateObject` does;
  latent (current web callers only send x/y/rotation) but a trap. See the
  steering comment at `state/testApi.ts:243`.
- **Magic Move rotation lerps linearly** while position/scale ease —
  `animation/src/transitions/magic.ts:230`. Cosmetic de-sync.
- **Out-presets pop to base value** — `fadeOut.ts:29`, `scaleOut.ts:26`,
  `scaleIn.ts:31`, `bounceIn.ts:33`, `flipIn.ts:35` hardcode `from:{alpha:1}`
  / `scaleX || 1` instead of the authored value.
- **SlidesPanel click-after-drag collapses multi-selection** —
  `ui/SlidesPanel.tsx:290,832`; the claimed click-suppression (`void index`)
  does nothing.

**Low**

- Per-request `Y.Doc` never destroyed — `pptxExport.ts:68,216`,
  `pptxImport.ts:182` (`replayDoc.ts` contract says caller must destroy).
- SceneGraph z-order math off-by-N when a slide has an unsupported object
  type — `SceneGraph.ts:311` (uses snapshot index, not mounted-predecessor
  count).
- onClick advance can drop a click mid-tween — `compiler.ts:95`
  (`tl.play()` on a running timeline is a no-op).
- Single-letter shortcuts fire while a `<select>` is focused —
  `useShortcuts.ts:229` (`isInputElement` doesn't cover `<select>`).
