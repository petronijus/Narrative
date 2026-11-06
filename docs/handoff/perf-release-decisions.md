# Performance programme: release decisions (handoff, 2026-11-06)

Branch `perf/crowded-slide`, pushed at 8207c7bc (8 commits over 10c9e044). Not
merged into `main`, nothing released. The final round's record is
`docs/plans/performance.md` → Final round wrap-up; full e2e (Chromium) 262/0,
`just check` green.

## Continue on another machine

```sh
git fetch && git checkout perf/crowded-slide && git pull
just setup && just dev
```

Perf baselines are per machine (`NARRATIVE_PERF_MACHINE`); the accepted ones
live only on the MacBook (`~/.cache/narrative-perf/petrs-macbook-pro/`), so a
timing on another machine needs its own baseline run first.

## Decisions open for Petr

Each with the recommendation.

1. **Merge, release 0.16.0 and deploy.** Merge into `main`, `just bump 0.16.0`,
   CHANGELOG, tag, push, `just gh-release v0.16.0`, `just deploy v0.16.0` to
   VM 103: set `METRICS_TOKEN` (64 hex characters, or the server refuses to
   boot), prune images `--drop v0.13.2 --drop v0.14.0`.
   Recommended: yes, after decision 5.
2. **ADR 0020 → Accepted.** The editor canvas draws the visible region; in
   present mode the `DensityHandover` alone owns density (option B, chosen
   2026-11-01). Still marked "Proposed". Recommended: accept.
3. **Two WebKit regressions from this branch.** `viewport.zoom.wheel`
   frame.max 39 → 48.5 ms; `present.advance.text` advance.p50 57 → 63 ms
   (frame.p99 18 → 19). No hitches or dropped frames.
   a) release and fix in the next round, b) fix first (~1–3 h).
   Recommended: a.
4. **Paragraph-final soft break.** Shift+Enter at the end of a paragraph
   opens an empty line with the caret on it (as Keynote / Google Slides),
   carried by a placeholder `<br data-empty="1">`. Chosen by the session,
   not confirmed. Recommended: confirm.
5. **Manual checks (need the MacBook).** Rotated text in Safari (~2 min);
   headed WebKit present benches with the window in front (~15–20 min).
   Recommended: Safari before the release, the WebKit benches after.
6. **State-sync review of `FolderFontLoader` / `bundledFonts`** (changed by
   the renderer agent, owned by state-sync; ~15 min, parallel).
   Recommended: yes.
7. **Window resize during a presentation** is unmeasured; analysis says the
   presenting set's rasters shift by under a pixel, as before this round.
   Recommended: next round.

## Other open items (no decision needed)

- Flake: `apps/server` `serverHost.test.ts` ("sees a change an editor
  makes…") timed out once under load; passes alone.
- `perf-accept --series` (new, `packages/perf/src/cli/acceptArgs.ts`) was
  added by the renderer agent; worth a look by the perf owner.
- Still open from the plan: F9; F10 (Tauri presenter window, Low Power Mode
  run, Linux / Windows driver input); F2 WebKit swap-frame misses; rasters of
  texts only partly in view at high zoom.
- Regressions already in HEAD's history (not this branch):
  `transform.move.text` / `.multi` render.ms +20 ms, `slide.switch.100`
  settle 72 → 100–122 ms.
