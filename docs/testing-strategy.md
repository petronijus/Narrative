# Narrative — Testing Strategy

> Last updated 2026-09-09 (was 2026-05-09, after Tier C roadmap completion).
> Current state, **measured** with `pnpm -r test` on 2026-09-09 — all green:
>
> | Package                | Files   | Passed    | Skipped |
> | ---------------------- | ------- | --------- | ------- |
> | `apps/web`             | 61      | 574       | 30      |
> | `apps/server`          | 32      | 494       | 1       |
> | `packages/slide-model` | 18      | 305       | 0       |
> | `packages/animation`   | 13      | 144       | 0       |
> | `packages/shared`      | 2       | 13        | 0       |
> | `apps/video-worker`    | 1       | 12        | 1       |
> | **Total**              | **127** | **1,542** | **32**  |
>
> (was 1,219 passing across 5 packages on 2026-05-09.) Plus **40 e2e spec
> files** in `apps/web/e2e/`. Note the skip count: **32 total, 30 of them in
> `apps/web`** — the long-standing "23 web skips" figure is stale, and 7 skips
> have accumulated since without being triaged into the tables below.
> Bundle budgets enforced via `size-limit` (`pnpm size`). Property-based CRDT convergence,
> server lifecycle/leak coverage, multi-client e2e collab, destructive-
> flow coverage, sampled-thumbnail visual regression all active.
> Lighthouse + Stryker mutation testing wired in (opt-in).
>
> Added in the 0.9.x arc: **5 .pptx parser regression tests** (theme fonts +
> placeholder geometry inheritance, 0.9.1) and the **first 3 tests for
> `RenderScheduler`** (0.9.2). Nothing in this suite could have caught the
> other eight defects of that arc — see _Environment traps_.
>
> ⚠️ **There is no CI.** GitHub Actions was removed on 2026-09-07 (commit
> `573ba64`); nothing runs these suites but a human or an agent following
> `CLAUDE.md`'s auto-run policy.
>
> ⚠️ **The e2e suite does not run on Ubuntu 26.04 as configured** — see
> _Environment traps_ below.

## TL;DR

- **Pure logic = unit tests.** `packages/slide-model`, `packages/animation`,
  `apps/server` core — these are the gravity well, stay strong.
- **User-visible behaviour = Playwright e2e.** Anything that depends on
  focus, keyboard scope, drag-and-drop, multi-step interactions, or visual
  rendering belongs here, not in jsdom.
- **Don't write component tests for "does this label render".** They break
  on every UI iteration without catching real bugs. We deleted ~80 of those
  this session.
- **Visual regression** for the Pixi renderer. Pixel sampling is the only
  honest renderer test.
- **Property-based** for CRDT convergence. Single most valuable test we
  _don't_ have.

## Test layers

| Layer                      | Where                                                                   | Purpose                                                                                                                  | Status                         |
| -------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------ |
| Unit (pure logic)          | `packages/{slide-model,animation,shared}`                               | Yjs mutations, CRDT, GSAP DSL compiler, schema validators                                                                | Strong (273 + 131 + 6)         |
| Integration (server)       | `apps/server/src/{routes,hocuspocus,media,auth}`                        | Fastify + Postgres test DB, Hocuspocus auth/persistence                                                                  | Strong (261)                   |
| Hook / state (React)       | `apps/web/src/state/*.test.tsx`                                         | Pure data hooks (`useMediaUpload`, `useSlideThumbnails`, `useVideoInfo`)                                                 | OK                             |
| Component contract (React) | `apps/web/src/{ui,components}/*.test.tsx`                               | ONLY for components with non-trivial logic (state machines, conditional branches) — not "does it render this label"      | Was bloated; cleaned up        |
| e2e (Playwright)           | `apps/web/e2e/*.spec.ts`                                                | User-visible behaviour — keyboard shortcuts, drag/drop, multi-window sync, full Inspector flows, present mode navigation | Strong (~30 specs)             |
| Visual regression          | `apps/web/e2e/visual/*.spec.ts` (TODO — convert `visual-check.spec.ts`) | Renderer output for canonical scenes (rect, text, image, magic-move keyframes)                                           | Missing                        |
| Load / soak                | `tests/load/{hotEdit,awarenessFlood,docGrowth}.ts`                      | Throughput, awareness rate, doc growth                                                                                   | Exists, no thresholds enforced |
| Property-based             | `packages/slide-model/src/*.property.test.ts`                           | CRDT convergence: random op sequences from N clients converge                                                            | **Zero coverage today**        |

## What was just cleaned up

| Before                                                                                    | After                                                                            |
| ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Web: 102 failures across 21 files                                                         | Web: 0 failures, 23 skipped (Tier A+B unblocked + cleaned the rest)              |
| 6 `objectRenderers/*.test.ts` files asserting Pixi mock-call shapes                       | Deleted; replaced by sampled-thumbnail e2e in `inspector-flows.spec.ts`          |
| `Inspector.test.tsx`, `Toolbar.test.tsx`, etc. asserting against `getByLabelText('Fill')` | Stale-text assertions marked `it.skip` with `// see e2e/inspector-flows.spec.ts` |
| Each test file with its own inline `vi.mock('pixi.js', () => ...)`                        | Single `apps/web/src/test/pixiMock.ts` — fixed once, all tests get the fix       |
| Each test file with its own `<MemoryRouter>...<AuthProvider>` boilerplate                 | Single `apps/web/src/test/renderWithProviders.tsx`                               |

## Pending skipped-test triage (61 tests)

For each currently-skipped test the action is one of: **fix** (real
behaviour assertion, just rebind to current `data-testid`), **delete**
(pure DOM-presence, no signal), **replace with e2e** (interaction needs
real focus / drag / keyboard scope).

### High value — fix now

| File                                                            | Tests | Action                                                                                                                                               |
| --------------------------------------------------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/src/renderer/ResourceManager.test.ts:27,58,79`        | 3     | Patch `pixiMock.ts` to give `Texture.from` a `destroy: vi.fn()` and `source: { destroy: vi.fn() }` — the texture leak guard is too important to lose |
| `apps/web/src/renderer/playTransition.test.ts:220`              | 1     | Magic-Move pairing test — THE regression guard for the snap-final-state bug we just fixed in Tier 2-C                                                |
| `apps/web/src/state/useMediaUpload.test.tsx:476,552`            | 2     | Transcode poll lifecycle + cancel-during-finalizing timer cleanup — leak prevention                                                                  |
| `apps/web/src/ui/Inspector.componentInstance.test.tsx`          | 5     | M16 P7 leaf-override mutation payloads. Working sibling at L337 shows the pattern.                                                                   |
| `apps/web/src/ui/FillTokenTab.test.tsx:212,223,232,250,369,389` | 6     | Token resolution + style detach — real mutation-payload assertions, not labels                                                                       |
| `apps/web/src/state/useSlideThumbnails.test.tsx:195,229,302`    | 3     | Debounce semantics + multi-id fan-out — pure timer/state logic                                                                                       |
| `apps/web/src/pages/FoldersHome.test.tsx:224`                   | 1     | 409 error-modal handling — real branch logic                                                                                                         |

### Replace with e2e

| File                                                     | Tests | Where the e2e lives / belongs                           |
| -------------------------------------------------------- | ----- | ------------------------------------------------------- |
| `apps/web/src/ui/Toolbar.test.tsx:177,185,193,246,262`   | 5     | `apps/web/e2e/keyboard-shortcuts.spec.ts` (TODO)        |
| `apps/web/src/ui/SlidesPanel.test.tsx:286,301`           | 2     | Same — slides keyboard nav                              |
| `apps/web/src/components/PresentLayout.test.tsx:317-423` | 7     | `apps/web/e2e/present-layout.spec.ts` (extend existing) |
| `apps/web/src/ui/UploadDropZone.test.tsx:124,160,193`    | 3     | `apps/web/e2e/image-upload.spec.ts` (extend existing)   |
| `apps/web/src/pages/FoldersHome.test.tsx:197`            | 1     | New `e2e/folder-mgmt.spec.ts` for delete-via-kebab flow |
| `apps/web/src/ui/Inspector.test.tsx:559`                 | 1     | Multi-select placeholder — `inspector-flows.spec.ts`    |

### Delete

| File                                                         | Tests | Reason                                               |
| ------------------------------------------------------------ | ----- | ---------------------------------------------------- |
| `apps/web/src/ui/Inspector.test.tsx` (label-presence subset) | ~7    | Pure DOM presence — covered by sampled-thumbnail e2e |
| `apps/web/src/ui/Toolbar.test.tsx:129,148,161`               | 3     | "Has button with name foo"                           |
| `apps/web/src/ui/SlidesPanel.test.tsx:169`                   | 1     | CSS class assertion                                  |

## Critical-path coverage gaps

| Gap                                  | Status                                                                       | Concrete next test                                                                                      |
| ------------------------------------ | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Real-time collab convergence         | `multi-window-slide-sync.spec.ts` covers slide-switch only                   | `tests/load/convergence.ts` — 2 clients, random ops, assert `Y.encodeStateAsUpdate(a)` ≡ `b` after sync |
| Server resource leaks (Tier 2 fixes) | `persistence.test.ts` exists; no leak regression                             | `apps/server/src/hocuspocus/lifecycle.test.ts` — open+close 50 docs, assert listener count ≈ baseline   |
| Magic Move snap-final-state          | `transitions/magic.test.ts` covers DSL; `playTransition.test.ts:220` skipped | **Fix that skipped test** — it's the regression guard                                                   |
| Bundle size budget                   | None                                                                         | `size-limit` in `apps/web/package.json`, fail CI if main chunk > 500 KB gz                              |
| Visual regression for renderer       | `visual-check.spec.ts` writes PNGs but doesn't compare                       | Convert to `expect(page).toHaveScreenshot()` with committed baselines                                   |
| Performance budgets                  | `tests/load/*.ts` reports numbers; thresholds not enforced                   | Add `BUDGET_MS` constants; CI fails on regression                                                       |
| Awareness throughput                 | `awarenessFlood.ts` runs without baseline                                    | Commit baseline JSON; assert ±20% in CI                                                                 |
| Procedural texture leak              | Known issue (memory note); no test                                           | Once shared procedural lifecycle lands: redraw 100× → texture count stable                              |

## Roadmap

### Tier A — completed ✅

All six items landed in commits on `main`:

1. ✅ **3 `ResourceManager.test.ts` skips fixed** — assertions updated to current `Assets.load({src,parser})` + `Assets.unload(url)` API. Texture leak guard restored.
2. ✅ **`playTransition.test.ts:220` fixed** — added `getMountedIds()` + `getNode()` to the fake SceneGraph. Magic-Move regression guard active.
3. ✅ **3 `useMediaUpload.test.tsx` skips fixed** — switched mock from `getHeader` to `getBody` (server now returns assetId in JSON body, browser CORS strips custom headers). All transcode-poll lifecycle assertions green.
4. ✅ **5 `Inspector.componentInstance.test.tsx` skips replaced** — original tests asserted obsolete UX (one row per master leaf). Replaced with 4 tests against current contract (rows only for _modified_ leaves; clear-entry button dispatches mutation).
5. ✅ **12 dead DOM-presence skips deleted** — Inspector × 8 (label-presence section assertions), Toolbar × 3 (button presence + click), SlidesPanel × 1 (CSS class).
6. ✅ **`size-limit` wired in** at `apps/web/package.json`. Per-chunk + total-first-paint budgets. Run via `pnpm size`. Current floor:
   - Main app chunk: ≤ 210 KB gz (currently 188)
   - Pixi: ≤ 180 KB (currently 162)
   - React: ≤ 130 KB (currently 118)
   - Tiptap: ≤ 120 KB (currently 109)
   - Yjs: ≤ 45 KB (currently 37)
   - GSAP: ≤ 32 KB (currently 28)
   - hls.js: ≤ 170 KB (currently 161)
   - **Total first-paint: ≤ 800 KB** (currently 747)

### Tier B — completed ✅

All six items landed:

1. ✅ **Property-based CRDT convergence** — `packages/slide-model/src/convergence.property.test.ts`. fast-check generates arbitrary `Op[]` from {addSlide, removeSlide, addObject, updateObject, removeObject, moveObjectsLayer}; three properties asserted: disjoint+sync convergence (200 random sequences), three-client star topology (100), offline-then-reconnect (100). 400 random sequences total. The test caught a real subtlety on first run — `Y.encodeStateAsUpdate` is NOT canonical (clock entries serialise in insertion order, so byte-equal is not the right convergence test). The assertion is now structural deep-equality of `listSlides()` output.
2. ✅ **Visual regression** — `apps/web/e2e/renderer-visual.spec.ts`. Pragmatic two-tier:
   - **Sampled-thumbnail tests** (always-on): assert "rectangle paints inside its declared bbox not outside", "object added later renders on top of earlier object", "updating fill colour repaints". These read pixels out of the live thumbnail PNG — robust cross-platform.
   - **Pixel-perfect baselines** (opt-in via `RUN_VISUAL_BASELINES=1`): `expect(canvas).toHaveScreenshot()` for empty deck / rect / text. First-run baselines aren't committed — generate on a controlled machine when you adopt the workflow.
3. ✅ **Server lifecycle/leak test** — `apps/server/src/hocuspocus/lifecycle.test.ts`. Three properties: cache returns to zero after all connections close, opening+closing 50 docs sequentially keeps cache bounded (max observed ≤ 2 simultaneous), reopening the same doc reuses the cached entry while another connection is live. Validates the Tier 2-B `unloadImmediately:false` + `debounce:2000` settings.
4. ✅ **Keyboard-shortcut e2e** — `apps/web/e2e/keyboard-shortcuts.spec.ts`. Covers Toolbar (R/O/T/V/Shift+R/Shift+O/Shift+T), input-focus suppression (R while typing in inspector doesn't switch tool), Ctrl+Enter → present-mode URL, SlidesPanel (ArrowUp/Down through 3-slide deck), PresentLayout (ArrowRight/Space/PageDown advance, Esc exits).
5. ✅ **Performance budget regression tracking** — `tests/load/runAll.mjs` now compares against an optional `tests/load/baselines.json`; emits warnings when latency / size / sync time drifts > 20% even if absolute thresholds still pass. Template at `tests/load/baselines.example.json`. Threshold-breach exit-1 behaviour unchanged.
6. ✅ **FillTokenTab triage** — the 6 skipped tests asserted retired UX (the dedicated "Token" tab in the fill picker, replaced by token swatches inline in the colour-picker popover during M16-P8). Deleted with explicit comments pointing readers to the tokens unit tests in `slide-model` and the e2e replacement candidate in `inspector-flows.spec.ts`. 2 placeholder skips remain for the Detach-button rebind, clearly marked TODO.

### Tier C — completed (5 of 6) ✅

1. **Procedural-texture leak test** — ⏸ deferred. Blocked on the shared procedural-texture lifecycle landing (see memory note `procedural-texture-leak.md`). Add the test in the same PR that fixes the leak so they ship together.
2. ✅ **Destructive-flow e2e** — `apps/web/e2e/destructive-flows.spec.ts`. Five tests covering deck delete + share-link cascade, share-link revoke happy-path + IDOR-guard regression (Tier 1 fix), folder delete cascade, Drafts-folder protection.
3. ✅ **Mutation-testing pilot** — Stryker config at `packages/slide-model/stryker.config.json`. Run via `pnpm --filter @narrative/slide-model mutate`. Targets `mutations.ts` + `slides.ts` (highest-stakes files). HTML report → `reports/mutation/`. Threshold guidance: high=80%, low=60%, no break-build (informational; surface dead tests rather than gate).
4. ✅ **Multi-client e2e harness** — `apps/web/e2e/multi-client-collab.spec.ts`. Two scenarios: three browser contexts each adding slides + objects in parallel converge through real Hocuspocus sync; one context goes offline via `setOffline(true)`, peer makes changes, reconnect triggers Hocuspocus initial-sync handshake. Asserts deep-equal `listSlides()` snapshots across all contexts. The e2e analog to the unit-level CRDT property test from Tier B.1.
5. ✅ **Lighthouse CI** — `.lighthouserc.json` + `pnpm lighthouse` script. Audits the editor route on a built preview server. Budgets: performance ≥ 0.7, FCP < 2.5s, LCP < 4s, TBT < 600ms, CLS < 0.1, TTI < 5s. Currently `warn`-level (not `error`) so it's informational; promote after one or two PR cycles confirm CI stability.

## Environment traps

### Playwright has no browsers for Ubuntu 26.04

```
$ npx playwright install chromium
Failed to install browsers
Error: ERROR: Playwright does not support chromium on ubuntu26.04-x64
```

The ffmpeg download (needed for video capture) fails the same way. Verified on
`petronijus-PC` (Ubuntu 26.04.1 LTS) on 2026-09-09; `~/.cache/ms-playwright`
does not exist there. **A plain `pnpm --filter web test:e2e` therefore fails on
that machine.**

`apps/web/playwright.config.ts` already carries the escape hatch — it is easy
to miss, so it is written down here:

```bash
PLAYWRIGHT_USE_SYSTEM_CHROME=1 PLAYWRIGHT_NO_VIDEO=1 pnpm --filter web test:e2e
# or pin the binary:
PLAYWRIGHT_CHROME_EXECUTABLE=/usr/bin/google-chrome PLAYWRIGHT_NO_VIDEO=1 …
```

`PLAYWRIGHT_USE_SYSTEM_CHROME=1` → `channel: 'chrome'`;
`PLAYWRIGHT_NO_VIDEO=1` → `video: 'off'`. The 0.9.x diagnostic probes pinned
the same two settings per spec instead (`test.use({ channel: 'chrome', video:
'off' })`).

Whether the suite _passes_ with those vars set was not measured during the
0.9.x arc — do not claim it either way without running it. The durable fixes:
default to system Chrome when the bundled browser is absent, or run the suite
in a container with a supported base image.

### Diagnostic probes are not tests

A spec written to _measure_ production behaviour — not to assert a contract —
stays out of the committed suite until it becomes an assertion.
`apps/web/e2e/zoom-text-probe.spec.ts` is the
current example: it reads font faces, model-vs-measured text geometry and
artboard screenshots across a renderer-resolution change, driven by
`PROBE_DECK_ID` / `PROBE_SLIDE`. It is the starting point for the text-jump fix
described in
[`docs/handoff/0.9.x-production-hardening.md`](./handoff/0.9.x-production-hardening.md);
when that lands, the measurement becomes a real assertion or the probe is
deleted.

### Some defects are only reachable in production

Nine of the ten defects fixed in the 0.9.x arc were invisible to every local
suite, because the tunnel, the reverse proxy, the CSP and the minified build
exist only in production. No amount of unit or e2e coverage on `localhost`
would have caught them; the checks that did are `curl -sI` against the public
URL and a browser console on the deployed site. Both are listed under _How to
verify the current state_ in the 0.9.x handoff note.

## Maintaining this strategy

- New components SHOULD have a hook-level unit test if they have logic, an
  e2e if they have a multi-step interaction, and nothing in between.
- New Pixi renderers SHOULD NOT have unit tests asserting mock-call shapes.
  Add a sampled-thumbnail e2e instead — pattern in `inspector-flows.spec.ts`.
- New Yjs mutations MUST have unit tests in `packages/slide-model/src`.
- New Hocuspocus extensions MUST have a lifecycle test (open/close/leak).
- When you find yourself writing `getByText('Fill')`, stop. Use a
  `data-testid` AND/OR an e2e instead.

## How Claude uses this suite

Future Claude sessions read [`/CLAUDE.md`](../CLAUDE.md) on every
conversation. That file maps "files you touched" → "tests to run
automatically before declaring work complete". It is the operating
contract for autonomous changes; update it when you add a new test
target or retire an existing one. Examples of the policy:

- Edit anything → `pnpm typecheck` + `pnpm lint` + `pnpm -r test` (always).
- Touch the renderer → also run `renderer-visual` + `inspector-flows` e2e.
- Touch Yjs mutations → also run the property-based CRDT test +
  `multi-client-collab` e2e.
- Touch bundle entry points / dynamic imports → also run `pnpm size`.
- Touch perf-sensitive paths → also run `pnpm load:all` (compares
  against `tests/load/baselines.json`).

The slow gates (`pnpm lighthouse`, Stryker `mutate`) are NOT auto-run
per change — they belong before a release.

Nothing runs any of this automatically: **there is no CI** (was GitHub Actions
on every push and PR, removed 2026-09-07 — commit `573ba64` — after both
workflows had been red since 2026-06-17 on a pnpm version conflict). The
auto-run policy in `CLAUDE.md` is the only gate, and it is honoured by
convention, not by a machine. If a command cannot run (port collision, missing
service, the Playwright trap above), say so explicitly in the update — do not
silently skip it.
