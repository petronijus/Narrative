# Dependency majors — what is left (2026-10-15)

Done on 2026-10-14/15, each its own commit on `main`: the minor/patch sweep
(`ad44e2f6`), the safe majors (`3ce913f4`: nanoid 6, jsdom 30, fast-check 4,
@fastify/cors 11, @nodable/entities 3, plugin-react 6, concurrently 10,
jest-dom 7, size-limit 14), pnpm 12 + bullmq 6 + ioredis 6 (`915bf671`),
Sentry 11 (`e18be461`), tus 2 (`6ed65ed9`), Hocuspocus 4 (`36ef21b1`),
opentype.js 2 (2026-10-15, below).
None of it is released yet — the next release (0.12.2) ships it all; its
deploy is also the first through `private/release.env` (the build host and
VM moved out of `infra/release.env`).

## Next

1. **Vitest 5**: `clearMocks` defaults to true (92 files mock; count-across-
   tests assertions may change — set it false first or audit), `bench` is no
   longer importable (`apps/web/src/renderer/applyChanges.bench.ts`), `-t`
   joins names with `>`. Check `just mutate` (the Stryker runner is not
   confirmed on vitest 5). Effort M.
2. **The load tests** (`just load`) hang at "Connecting seed client": the
   hand-written client (`tests/load/yjsClient.ts`, written for Hocuspocus 2)
   never sends an Auth message, which the server requires since M10. Send
   one (sentinel token under BYPASS_AUTH), then record a baseline.
3. **TypeScript 7**: wait for 7.1 and typescript-eslint support (the 8.x
   peer is `<6.1`; `apps/web/src/actions/catalog.test.ts` uses the compiler
   API 7.0 removed).
4. **@types/node** stays on 24 while the runtime is Node 24 LTS.

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

## Also open

- **Going public**: the current tree is clean of client names and private
  infrastructure (`122600fc`), but `main`'s history still holds the client
  brand packs (since `c3d6ac4b`) and names. Publishing needs a history
  rewrite (`git filter-repo`) and a force-push — Petr's call.
- The e2e drag/typing specs (snapping, clipboard, path editing, tables,
  lists, text undo) fail under a parallel load of ~25+ and pass with two
  workers; worth a look at why the dev build's main thread stalls that much.
