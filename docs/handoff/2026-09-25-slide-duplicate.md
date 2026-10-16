# Slide duplicate: blank canvas, late thumbnails — handoff (2026-09-25)

Petr's report: after Ctrl+D / ⌘D on a thumbnail (v0.9.28) the copy's canvas is
blank — objects can be selected but nothing draws — and its thumbnail appears
only after a very long time. The shortcut only exposed it: the thumbnail menu's
"Duplicate" behaves the same.

## Root causes (all four fixed, uncommitted work pushed as one commit)

1. **The duplicate corrupted the local Y.Doc.** `apps/web/src/ui/slideHelpers.ts`
   `duplicateSlide` re-added objects from a `listSlides()` snapshot, whose text
   bodies are the source slide's _live_ `Y.Text`. Yjs cannot give a type a
   second parent: integration threw half-way, the client was left with one
   `Y.Text` shared by two slides, and the server got the copy with **empty
   text** (verified: the source stays intact, the copy's texts are empty after a
   reload). → New slide-model mutation `duplicateSlide` (`packages/slide-model/src/slides.ts`):
   clones the slide's whole Yjs structure (`Y.Map.clone()` is deep: rich text,
   table cells, notes XmlFragment, transition, background, name, skipped,
   indent, collapsed), new slide id, object ids kept (Magic Move), one
   transaction = one undo step. Tests: `slides.duplicate.test.ts` (copies
   everything incl. formatting; independent text; one transaction/undo step;
   reaches a peer intact). The old web helper and its test are gone;
   `pasteSlides` stays (its clipboard holds JSON deltas, not live Y types).
2. **Texture race in `ResourceManager`** (the actual blank canvas). Releasing the
   last reference deleted the map entry synchronously and started Pixi's
   _asynchronous_ `Assets.unload`; the copy's image, acquiring the same URL a
   moment later, got the dying texture from Pixi's cache. The first frame that
   drew it threw in the batcher (`texture._source` null → `alphaMode`), Pixi left
   the render group half-updated, and every later frame threw
   (`renderPipeId` of null). Also: two concurrent acquires of one URL each wrote
   refCount 1. → Entries now exist from the first acquire (shared load promise,
   right ref count), a texture released to 0 is kept for `UNLOAD_GRACE_MS`
   (5 s) and taken back without reloading, and a load waits for any unload of
   the same URL still running. 5 new tests in `ResourceManager.test.ts`, all
   failing against the old implementation.
3. **`RenderScheduler` swallowed every render exception** ("renderer torn down")
   — which is why the console was clean. Teardown is now detected explicitly
   (`app.renderer`/`app.stage` null); a real failure is `console.error`ed once
   per run of failures. Tests in `RenderScheduler.test.ts`.
4. **Thumbnails queued behind the deck-opening pass.** `useSlideThumbnails`
   handed the renderer every slide at once; a slide duplicated right after
   opening a 56-slide deck waited ~12 s. Now a two-tier queue in the hook
   (background = opening pass, urgent = anything after), one render in flight.
   Gotcha found on the way: the order effect first runs with an **empty** list
   (before sync) — only a non-empty run counts as the opening.
   Measured on the reference deck: copy's thumbnail 12 s → 1.7 s.

## Verified

- `pnpm typecheck`, `pnpm lint` (no new warnings), `pnpm -r test`: 1,632 tests,
  32 skipped.
- Real reference deck (local), slide 7 duplicated: canvas draws, no render
  error, texts survive a reload, thumbnail ~1.7 s after Ctrl+D.
- New e2e `apps/web/e2e/slide-duplicate.spec.ts` (image slide → Mod+D → the copy
  draws the image and an edit on it reaches the canvas) passes.

## Verified on the MacBook (2026-09-25, evening)

- **Negative control holds.** `slide-duplicate.spec.ts` against the v0.9.28
  `ResourceManager.ts` (everything else at `6d8a91b`): 3/3 runs fail — the
  copy's canvas stays blank (98 blue pixels where ~3,700 are expected). Back
  on the fixed file: 3/3 pass. The single 64 px test image is enough to hit
  the race; the spec needs no heavier slide.
- **Auto-run policy e2e green:** `renderer-visual`, `inspector-flows`,
  `keyboard-shortcuts`, `image-upload`, `multi-client-collab`,
  `thumbnails-after-slide-switch` — 19 passed, 3 skipped (the opt-in
  `RUN_VISUAL_BASELINES=1` pixel baselines). On the Mac no Playwright env
  vars are needed.
- Gotcha: after pulling this range, run `pnpm install` — the dev server dies
  on the missing `sharp` package otherwise.

## Next steps

1. ~~Negative control for `slide-duplicate.spec.ts`~~ — done, see above.
2. ~~Auto-run policy e2e~~ — done, see above.
3. Release 0.9.29 (CHANGELOG section is already written under "Unreleased"):
   bump the 7 package.json files, tag, push, build-push, deploy, verify
   `/version.json`.
4. Tell Petr: slides duplicated before 0.9.29 lost their texts on the server
   (the copy's text bodies are empty after a reload). Nothing to repair
   automatically — duplicate those slides again.
5. Local-only leftover on petronijus-PC: dev deck `dbHsAIytbPfC` has one extra
   copy of slide 7 from a probe run (57 slides instead of 56). Irrelevant on
   the Mac.
