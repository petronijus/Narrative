# Dependency majors — what is left (2026-10-15)

Done on 2026-10-14/15, each its own commit on `main`: the minor/patch sweep
(`ad44e2f6`), the safe majors (`3ce913f4`: nanoid 6, jsdom 30, fast-check 4,
@fastify/cors 11, @nodable/entities 3, plugin-react 6, concurrently 10,
jest-dom 7, size-limit 14), pnpm 12 + bullmq 6 + ioredis 6 (`915bf671`),
Sentry 11 (`e18be461`), tus 2 (`6ed65ed9`), Hocuspocus 4 (`36ef21b1`),
opentype.js 2 and Vitest 5 (2026-10-15, below); the load tests run again
(2026-10-15, below).
None of it is released yet — the next release (0.12.2) ships it all; its
deploy is also the first through `private/release.env` (the build host and
VM moved out of `infra/release.env`).

## Next

1. **TypeScript 7**: wait for 7.1 and typescript-eslint support (the 8.x
   peer is `<6.1`; `apps/web/src/actions/catalog.test.ts` uses the compiler
   API 7.0 removed).
2. **@types/node** stays on 24 while the runtime is Node 24 LTS.

## Vitest 5 — how it went in

Every package is on `^5.0.4` (5.0.5 was a day too young for
`minimumReleaseAge`; the next dependency sweep takes it). What the migration guide
lists and what it meant here:

- **`clearMocks` defaults to true.** Kept: every unit and integration test
  passes with it, so no test counted calls across tests.
- **jest-dom's typings miss Vitest 5.** jest-dom 7.0.1 augments
  `jest.Matchers` (no longer read) and, in its `/vitest` entry,
  `Assertion<T>` (now `Assertion<R, T>`). `apps/web/src/jest-dom-vitest.d.ts`
  plugs its matchers into Vitest 5's `Matchers<R, T>`; `apps/web/tsconfig.json`
  no longer lists the jest typings. The runtime side (`expect.extend` in
  `src/test-setup.ts`) is unchanged. Delete the file once jest-dom ships
  Vitest 5 typings.
- **`bench` is a test fixture.** `applyChanges.bench.ts` runs both paths
  inside one `test()` through `bench.compare`; `vitest bench` still collects
  `*.bench.ts`.
- **Stryker needs a patch.** `@stryker-mutator/vitest-runner` 10.0.0 picks
  each mutant's tests by name, joined with a space; Vitest 5 matches
  `testNamePattern` against the describe chain joined with `' > '`, so
  every mutant ran zero tests and survived (0%). Upstream:
  stryker-js#6210, fix PRs #6214/#6220/#6247 open. No Stryker setting
  avoids it (`coverageAnalysis` "all" and "off" still send the filter).
  `patches/@stryker-mutator__vitest-runner@10.0.0.patch`
  (`pnpm-workspace.yaml` → `patchedDependencies`) joins the names the way
  Vitest does, empty root suite left out; the score is back at 49.05%
  (`mutations.ts` 65%, `slides.ts` 26%), as on 4.x. The patch is pinned to
  10.0.0: when a runner release arrives, pnpm refuses to install with "The
  following patches were not used" — then drop the patch and the
  `patchedDependencies` entry, and check that `just mutate` still scores.
- **The fs module cache.** Vitest 5 caches transformed modules on disk, by
  default in one directory for the whole workspace, and every vitest
  process wipes it when the lockfile changed; the four Stryker workers did
  so together and died with ENOTEMPTY. `vitest.cache.ts` gives each package
  its own cache in its own `node_modules` (what `just test`'s parallel
  packages need) and turns it off under Stryker.
- Not used here, so nothing to change: the removed `vitest/*` entrypoints,
  `test.sequential`, `toThrow('')`, `VITEST_POOL_ID`, json/junit reporters,
  snapshots, `projects`, `vi.mock` outside the top level, unawaited
  `resolves`/`rejects`. `-t` now joins describe and test names with `>`; no
  recipe or doc passes a multi-segment pattern.

## opentype.js 2 — how it went in

`apps/server/src/media/fontMetadata.ts` imports
`opentype.js/dist/opentype.mjs` by path. The package has no `exports` map
and its two builds disagree: `main` (CommonJS, what Node picks) has only a
default export, `module` (what Vite and Vitest pick) only named ones; the
`.mjs` build is ESM under Node, tsx and Vitest alike. Its typings are ours
(`src/media/opentype.d.ts`, the slice we read plus the writer the tests use;
`@types/opentype.js` is gone). `font.names` is keyed by platform now;
`pickName` reads Windows, then Macintosh, then Unicode — the order 1.x's
merge let win — and a key on any platform beats the next key.
`fontMetadata.test.ts` (new) builds its fonts with the library's writer.
Should the package ever gain an `exports` map without that path, the import
fails at server start, not silently.

## The load tests — how they came back

`just load` hung at "Connecting seed client" because the hand-written client
never sent an Auth message; the server queues every message until
`onAuthenticate` has run. It now does the handshake (the editor's `cookie`
sentinel, admitted as `dev-user` under BYPASS_AUTH) with the codec of
`@hocuspocus/common`, and fails with the reason instead of hanging. Behind
the hang sat more: each scenario now creates its own deck through the API
and deletes it (a made-up name is no deck dev-user may open), writes under
a harness root type (docGrowth wrote the model's `slides`), compares
convergence structurally, and destroys its Awareness (whose interval kept
the process alive after PASS); awarenessFlood measures delivery to the
other clients (it had timed two `performance.now()` in a row), and
runAll's baseline keys read the fields the scenarios print. Baseline
recorded in `tests/load/README.md`; `baselines.json` is gitignored.

## Also open

- **Going public**: the current tree is clean of client names and private
  infrastructure (`122600fc`), but `main`'s history still holds the client
  brand packs (since `c3d6ac4b`) and names. Publishing needs a history
  rewrite (`git filter-repo`) and a force-push — Petr's call.
- The e2e drag/typing specs (snapping, clipboard, path editing, tables,
  lists, text undo) fail under a parallel load of ~25+ and pass with two
  workers; worth a look at why the dev build's main thread stalls that much.
