# Narrative — Claude project guide

Read this before changing code. It tells you which test commands to run
automatically based on what you're touching, where the strategy lives,
and what NOT to add.

> Strategy + roadmap: [`docs/testing-strategy.md`](./docs/testing-strategy.md).
> Setup + env: [`SETUP.md`](./SETUP.md).
> Architecture / agent ownership: [`docs/agents.md`](./docs/agents.md).

## Auto-run policy: which tests to run when

Run the tests below **automatically before declaring work complete** —
do not wait for the user to ask. Pick the rows that match what you
touched. Always run unit + typecheck + lint as the baseline.

| Files you touched                                             | Run automatically                                                                                          |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Anything                                                      | `pnpm typecheck` + `pnpm lint` + `pnpm -r test`                                                            |
| `packages/slide-model/src/**`                                 | `pnpm --filter @narrative/slide-model test` (incl. property-based CRDT)                                    |
| `packages/animation/src/**`                                   | `pnpm --filter @narrative/animation test`                                                                  |
| `apps/server/src/**` (routes, auth, hocuspocus, media)        | `pnpm --filter server test` — covers lifecycle + leak guards                                               |
| `apps/web/src/renderer/**` or any Pixi-touching code          | unit tests + the sampled-thumbnail e2e: `pnpm --filter web test:e2e -g "renderer-visual\|inspector-flows"` |
| `apps/web/src/ui/**` or `apps/web/src/components/**`          | unit + relevant e2e: `pnpm --filter web test:e2e -g "<feature>"`                                           |
| Keyboard shortcuts, focus scope, drag/drop                    | `pnpm --filter web test:e2e -g "keyboard-shortcuts"`                                                       |
| Auth, sharing, folders, cascade-delete                        | `pnpm --filter web test:e2e -g "destructive-flows"` + `pnpm --filter server test`                          |
| Yjs mutations, Hocuspocus, sync                               | `pnpm --filter @narrative/slide-model test` + `pnpm --filter web test:e2e -g "multi-client-collab"`        |
| Bundle entry points, dynamic imports, vendor chunks           | `pnpm size` (size-limit budgets must stay green)                                                           |
| Hot edit / awareness / doc-growth perf-sensitive paths        | `pnpm load:all` (compares against `tests/load/baselines.json`, warns on > 20% drift)                       |
| Editor render path (FCP / LCP / TTI suspects)                 | `pnpm lighthouse` (warn-level Core Web Vitals)                                                             |
| `packages/slide-model/src/{mutations,slides}.ts` deep changes | `pnpm --filter @narrative/slide-model mutate` (Stryker — slow, ~5min, run before PR not on every save)     |

If a command doesn't exist or fails to start (port collision, missing
service), say so explicitly in your update — don't silently skip it.

## What NOT to test

These were deleted from the suite this audit; do not re-introduce them:

- **DOM-presence component tests** — `getByText('Fill')`, `expect(button).toBeInTheDocument()`. They break on every UI iteration without catching real bugs.
- **Pixi renderer unit tests asserting mock-call shapes** — replaced by sampled-thumbnail e2e in `apps/web/e2e/renderer-visual.spec.ts` and `inspector-flows.spec.ts`.
- **jsdom keyboard-shortcut tests** — focus model is approximate; real keyboard belongs in `apps/web/e2e/keyboard-shortcuts.spec.ts`.
- **CRDT byte-equality assertions** — `Y.encodeStateAsUpdate` is NOT canonical (clock entries serialise in insertion order). Use structural deep-equality of `listSlides()` instead.

## Architecture invariants — don't violate

- **State = Yjs only.** No parallel React state for object data. New mutations go in `packages/slide-model/src/mutations.ts`.
- **Render = SceneGraph diff only.** No direct Pixi mutations outside `apps/web/src/renderer/`.
- **Animation = DSL only.** Compile through `packages/animation/`, never call GSAP from a component.
- **Custom upload metadata goes in tus JSON body, not headers.** Browser CORS strips custom `X-Narrative-*` headers.
- **Hocuspocus settings**: `unloadImmediately: false` + `debounce: 2000` (lifecycle test enforces this).
- **Sub-agents always on Opus.** When delegating to the Agent tool in this repo, pass `model: 'opus'` — Sonnet output needs reviewer rework here.

## Test command quick reference

```bash
pnpm dev                                       # web :5173 + server :3001 + video-worker
pnpm dev:no-worker                             # skip video-worker for faster startup

pnpm typecheck && pnpm lint                    # always before declaring done
pnpm -r test                                   # 1,219 unit/integration tests
pnpm --filter web test:e2e                     # 31 Playwright specs
pnpm size                                      # bundle budgets
pnpm load:all                                  # load tests + drift detection
pnpm lighthouse                                # Core Web Vitals (built preview)
pnpm --filter @narrative/slide-model mutate    # Stryker mutation report
```

Filter a single e2e spec: `pnpm --filter web test:e2e <spec-name>`.
Filter by test name: `pnpm --filter web test:e2e -g "<grep-pattern>"`.

## Skipped tests

23 web tests are `it.skip` with rationale comments in-file. Don't
un-skip without reading the comment — most are deferred until a
specific UI redesign lands or have an e2e replacement noted.

## Git policy

- Never commit without explicit user confirmation ("push", "commit", "ship", "merge", "hotovo").
- Never `--no-verify` or force-push.
- Always read before editing a file.
- Conventional commits: `test:`, `fix:`, `feat:`, `chore:`, `perf:`.
