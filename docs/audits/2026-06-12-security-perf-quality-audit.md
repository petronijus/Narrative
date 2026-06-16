# Full audit — security, performance, code quality (2026-06-12)

Method: two-wave multi-agent audit of the full repo state on `main` (4c12443).
Wave 1 = three Opus auditors (security / quality / performance). Wave 2 = three
Fable auditors with wave-1 findings marked "known", tasked to find what was
missed and to adversarially verify the critical claims. Findings below are
deduplicated and cross-verified; severities reflect the post-verification view.

**Overall verdict:** architecture and auth foundations are unusually solid
(OIDC/PKCE, sessions, Hocuspocus auth, IDOR coverage, tus auth chain, SQLi,
SSRF, secrets handling all checked clean). The project is **not prod-ready**
because of (a) three stored-XSS-class vectors in user-generated content,
(b) a public same-origin media bucket, and (c) three silent data-loss bugs.

---

## Remediation status — 2026-06-13

Fixed this session (typecheck + lint clean; slide-model 267, server 398, web 528
tests green; web suite's lone error is a pre-existing Pixi+jsdom canvas artifact):

- **XSS-1** (fontFamily) — `richText.ts` `sanitizeFontFamily` allowlist, emitted
  unquoted (safe inside the double-quoted `style=""`); applied at PPTX import
  (`importDeck.ts`). `PeerCursors.tsx` color validated before the SVG innerHTML.
  Tests added in `richText.test.ts`.
- **XSS-2** (`javascript:` hyperlink) — `sanitizeHref` (new `packages/shared/src/
sanitize.ts`, allowlist http/https/mailto) applied at the `window.open` sink
  (`PresentLayout.tsx`) and at PPTX import (`writer.ts`). Tests in `sanitize.test.ts`.
- **XSS-3 / SVG-as-document** — closed via Caddy headers (`Content-Disposition:
attachment` + `sandbox` CSP + `nosniff` on `/storage/*`, plus site-wide
  nosniff/X-Frame-Options/Referrer-Policy). The exploit chain is broken; full
  DOMPurify SVG _content_ sanitization at upload is **deferred** (see below).
- **DL-1** (table paste erases cells) — `addObjects` now mirrors `addObject`'s
  two-phase cell-text init (`mutations.ts`, shared `applyPendingCellTextInserts`).
  Tests in `mutations.test.ts`.
- **DL-2** (PPTX text corruption on first keystroke) — `getElementInnerText`
  round-trips `<br data-pb="1">` → ` ` (`TextEditOverlay.tsx`).
- **DL-3** (deck delete orphans tus originals) — `purgeExplicitKeys` deletes
  `media_assets` storage keys + `.info` sidecars before the cascade, in both
  deck and folder delete paths (`bucketCleanup.ts`, `decks.ts`, `folders.ts`).

Deferred (need product/staging decision, not started):

- **SVG content sanitization** (DOMPurify+jsdom + magic-byte sniff at upload) —
  defense-in-depth on top of the now-closed header fix; adds deps + an S3
  read-modify-write to the upload hot path.
- **MEDIA-1** (private bucket + presigned URLs everywhere) — refactor of media
  routes + client; survives-revocation fix.
- **Site-wide CSP** for the SPA — needs staging verification before shipping.
- All P1 perf items, P1 security remainder (CONN-1/TUS-1/IDOR-1/DOS-1), P2 list.

### Deployed to prod — 2026-06-14

All P0 fixes above shipped to the prod VM (Proxmox 103 `narrative`,
commits b5ba00a…5174d03 on `main`) and verified live: server on new image,
Caddy security headers on `/` and `/storage/*`, migration 0014 applied,
thumbnails 200. Two infra bugs surfaced + fixed during the deploy
(imgproxy-cache host-port `!reset`, healthcheck `127.0.0.1`, deploy.sh +x).
See project `CLAUDE.md` → "Deployment & prod access".

---

## Round 2 — backlog burn-down (started 2026-06-14)

Status legend: ☐ todo · ◐ in progress · ☑ done

**Performance**

- ☑ **PERF-1** re-render storm — `subscribeToSlides` now rAF-coalesces
  (one callback/frame, not one per Yjs transaction; mirrors the sibling
  subscribers' pattern, observeDeep kept, no collab-event loss) +
  `SlideItem` is `React.memo`'d with a stabilized prop (`slideObserve.ts`,
  `SlidesPanel.tsx`, test in `slides.observe.test.ts`). Remaining tail
  (the `useSlides`/`listSlides` per-render identity churn → a
  `useSlideSummaries` migration) is a separate follow-up, noted in code.
- ☑ **PERF-2** full-doc persistence — `onStoreDocument` now does atomic
  snapshot-compaction (insert new full snapshot + delete older rows for the
  doc in one tx, `id < newId`), collapsing storage + cold-load from
  O(edits×doc) to O(doc). Load unchanged (applies all rows; full snapshots are
  idempotent → old multi-row decks load fine, compact on next store).
  `persistence.ts` + `docs/adr/0006`. **Deployed** — server reloaded clean on
  real data (no persistence errors, deck rows intact); compaction (N rows → 1)
  triggers on each deck's first edit post-deploy.
- ☐ PERF-3 thumbnail localStorage blob rewrite
- ☐ PERF-4 table keystroke restyle / SceneGraph O(n²) / main.tsx Sentry TLA
- ◐ PERF-5: ☑ pg pool sizing (`db/client.ts` + worker `db.ts` — bounded `max`
  - idle/conn timeouts, env-overridable) · ☑ `media_assets` composite indexes
    (hand-written migration `0015` + journal entry; applies at next `db:migrate`)
    · ☐ async PPTX · ☐ route code-split
- ☑ **drizzle-meta landmine** (surfaced by the indexes) — root cause: this repo
  hand-writes migrations + uses a custom per-statement-transaction migrator
  (`migrate.ts`, needed because drizzle's built-in single-tx migrator breaks
  `ALTER TYPE … ADD VALUE`); `drizzle-kit generate` was never used so snapshots
  were never maintained → `db:generate` emitted a destructive full-schema
  migration. Fix: `db:generate` now guarded to fail loudly, stale lone snapshot
  deleted, convention documented in `apps/server/drizzle/README.md`. (NOT a
  re-baseline — that would push toward the built-in migrator and reintroduce
  the enum bug the custom migrator deliberately avoids.)

**Security (deferred set)**

- ☑ SVG content sanitization — `svgSanitize.ts`: DOMPurify (svg profile,
  forbid `script`/`foreignObject`/`on*`, `href` clamped to `#frag`/`data:image`)
  - sniff renamed SVGs + raster magic-byte check, wired into `tus.ts`
    onUploadFinish (sanitize→rewrite, or reject+delete). · ☐ MEDIA-1 private bucket+presign
- ☐ site-wide CSP
- ☑ **CONN-1** Hocuspocus closes the revoked principal's live WS on share/
  permission/session revoke (`hocuspocus/connections.ts`, targeted — not
  the kick-everyone built-in) · ☑ **TUS-1** uploads bound to creator+deck,
  re-checked on PATCH/finish · ☑ **IDOR-1** folder-font clone scoped to
  caller-owned decks · ☑ **DOS-1** `MAX_DOC_BYTES` net-growth cap (32 MB) +
  disconnect
- ops: ☑ BYPASS_AUTH hard-fails in prod · ☑ /metrics gated on `METRICS_TOKEN`
  in prod · ☑ animation DSL clamp (duration/timeline/repeat) · ☐ CSRF token
  (deferred until SameSite relaxed / M24 iframe embeds)

**Quality P2**

- ☐ dedupe `parseDataUrl` · ☐ `no-console` + logger · ☐ dead `packages/ui`

### Deployed to prod — 2026-06-16

Round-2 batch shipped to the prod VM (commits through `74be7b8` on `main`) and
verified live: server/video-worker on new images, **PERF-1 + PERF-2 + pg pool
sizing + migration 0015 (kind indexes) + SVG sanitization** all live, deck data
intact, `/health` + `/storage` headers + thumbnails 200.

Infra/build issues surfaced + fixed during these deploys (each was a latent
landmine for every future deploy):

- ☑ **`USE_SHARED_TUNNEL=1` missing from prod `.env.prod`** — deploy.sh ran
  without the shared-tunnel overlay → internal services kept `127.0.0.1` host
  ports → hit the Docker 29.4 stale-port bind bug on every redeploy. Root cause
  of the 2026-06-14 port saga. Added to `.env.prod` + documented in
  `.env.prod.example`.
- ☑ **prod secrets now in the encrypted flow** — `infra/.env.prod` is SOPS-
  encrypted as `env.prod.sops` in the private overlay; `secrets-decrypt.sh` /
  `secrets-edit.sh` take a `[dev|prod]` target (was VM-only, no source of truth).
- ☑ **`undici-types` pinned to 7.27.2** — `@types/jsdom@28` (SVG devDep) pulled
  a <24h-old version that tripped pnpm's `minimumReleaseAge` supply-chain policy
  in the Docker build.
- ☑ **pnpm pinned to 9.15.4** (Dockerfiles + `packageManager`) — builds used
  `corepack prepare pnpm@latest` ≠ the lockfile's generator, so adding an
  `overrides` block broke the frozen install (`ERR_PNPM_LOCKFILE_CONFIG_MISMATCH`).

---

## P0 — fix before any external exposure

### XSS-1 (CRITICAL, confirmed reachable): stored XSS via unescaped `fontFamily` in rich text

`packages/slide-model/src/richText.ts:140` — `toHtml()` interpolates the
per-run `fontFamily` raw into `style="…"` (text body _is_ escaped on line
~156; the style attr is not). Sinks: `el.innerHTML = buildOverlayHtml(obj)` in
`apps/web/src/ui/TextEditOverlay.tsx:319` (edit mount) and `:379`
(**peer-edit observer** — victim only has to be viewing while a malicious peer
formats text), plus Pixi HTMLText SVG styles (the `quoteFamilyName` defense in
`fontFallback.ts` covers only the box-level path, not inline runs). Payload
e.g. `fontFamily = 'x"><img src=q onerror=…>'` — `<img onerror>` executes on
innerHTML assignment. Injectable by any collaborator via `Y.Text.format()` or
a crafted `.pptx` (`importDeck.ts:358` passes typeface through unvalidated).
**Fix:** route inline `fontFamily` through `quoteFamilyName`/allowlist
`[A-Za-z0-9 _,-]`; build the overlay via CSSOM (`.style.fontFamily =`) instead
of innerHTML; validate on PPTX import. Same class: `PeerCursors.tsx:91`
templates peer `color` into SVG innerHTML — use `setAttribute('fill', …)`.

### XSS-2 (HIGH, found in wave 2): `javascript:` hyperlink executed by Present mode

`apps/web/src/components/PresentLayout.tsx:416-420` — the normalizer only
prepends `https://` when there's _no_ scheme; `javascript:…` already has one
and is passed verbatim to `window.open`. No scheme allowlist exists anywhere.
Injection: any editor via `Inspector.tsx:5599` (raw `href` write into Yjs), or
PPTX `<a:hlinkClick>` (`parser.ts:1592` → `writer.ts:339`). Victim clicks a
linked object while presenting a shared/imported deck → script on app origin.
**Fix:** central href sanitizer (allow `http:`/`https:`/`mailto:` + bare
hosts) applied at write boundary AND at every navigation sink (also check
`EditorContextMenu.tsx:365`).

### XSS-3 chain (HIGH, confirmed end-to-end): SVG upload → public bucket → same-origin execution

- `media/tus.ts:469` accepts any `image/*` on the _declared_ MIME, incl.
  `image/svg+xml`; no sanitization, no magic-byte check.
- `infra/docker-compose.yml:106` — `mc anonymous set download` makes the whole
  bucket anonymously readable.
- `infra/caddy/Caddyfile` proxies it at `{$DOMAIN}/storage/*` (same origin as
  the SPA) with **zero security headers** repo-wide (no CSP, no nosniff, no
  X-Frame-Options, no Content-Disposition).
  An uploaded SVG with `<script>` executes when loaded as a document/iframe on
  the app origin. **Fix (layered):** reject or DOMPurify-sanitize SVG at upload;
  add `Content-Disposition: attachment` + `X-Content-Type-Options: nosniff` on
  `/storage/*`; add a Caddy `header` block with CSP
  (`script-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'`),
  `X-Frame-Options: DENY`, `Referrer-Policy`.

### MEDIA-1 (HIGH): public bucket + permanent raw MinIO URLs defeat permission revocation

`media/routes.ts:354` (`playbackUrl`) and `:400` (font URL) return raw public
MinIO URLs — bearer-less, permanent, survive share revocation; `nanoid` keys
are obscurity, not authz. The code itself tags this `TODO(M29)`.
**Fix:** drop `mc anonymous set download`; serve via short-TTL presigned URLs
(`presignGetUrl` already exists and is used for fonts at `routes.ts:544` —
extend to video/font URL endpoints). imgproxy reads via S3 creds, doesn't need
a public bucket.

---

## P0 — silent data-loss bugs (wave 2, all verified)

### DL-1: pasting/stamping a table erases all cell text

`packages/slide-model/src/mutations.ts` — `addObject` (lines ~81-117) has the
table workaround (`collectPendingCellTextInserts` + post-integration replay,
needed because `buildTableCellYMap` deliberately promotes string cell text to
an empty Y.Text); `addObjects` (~716-760) **does not**. `addObjects` is the
path for Cmd+V paste (`EditorLayout.tsx:2105`), paste-at-cursor
(`EditorContextMenu.tsx:505`) and component stamping (`stampComponent.ts:165`).
Empirically reproduced by the auditor with a throwaway vitest: `addObject`
keeps `'A1'`, `addObjects` yields `''`. **Fix:** mirror the `addObject`
workaround in `addObjects`' per-object loop; add a bulk-path test.

### DL-2: first keystroke in PPTX-imported multi-paragraph text corrupts content/formatting

`toHtml` renders ` ` paragraph separators as `<br data-pb="1">`
(`richText.ts:156`), but `getElementInnerText`
(`TextEditOverlay.tsx:207-234`) maps **every** `<br>` back to `'\n'`. So for
imported text (parser emits ` `, `pptx/parser.ts:2458`) `prev` ≠ `next`
from the very first input event; the prefix/suffix diff deletes everything
between first and last paragraph and re-inserts it flat (one run's attrs,
paragraph breaks downgraded to soft breaks → bullets collapse).
**Fix:** make the projections agree — emit `' '` for `data-pb="1"` breaks
in `getElementInnerText` and the offset-mapping helpers.

### DL-3: deck deletion never purges tus originals from MinIO

tus objects are stored at the compound key `"{assetId}:{deckId}:{b64}"`
(`media/tus.ts:361-385`, `storageKey = upload.id` at `:546-555`), but
`bucketCleanup.ts:44` sweeps prefix `decks/<deckId>/` — which matches only
thumbnails and worker outputs. After deck delete, originals (up to 500 MB per
video + `.info` sidecars) are orphaned and untracked; the planned M29 GC can't
find them either. **Fix:** collect `media_assets.storage_key` before the
cascade and `DeleteObjects` explicitly (+ `.info`), or key tus objects by the
real `decks/<deckId>/…` path and move ids to metadata.

---

## P1 — performance (top wins)

### PERF-1 (CRITICAL, confirmed + aggravated): keystroke/drag re-render storm

`subscribeToSlides` attaches an unfiltered `ctx.slides.observeDeep`
(`slideObserve.ts:91-99`) with **no rAF batching** → fires once per Yjs
transaction; drags mutate per pointer event (`EditorLayout.tsx:1302-1556`,
`bulkUpdateObjects` directly in `handlePointerMove`) → up to 120+ firings/s on
high-Hz mice. Each firing: `useSlides` → `listSlides()` deep-converts every
slide+object+animation to fresh identities (`slides.ts:54-113`), and there are
**~7 independent `useSlides` instances** mounted (SlidesPanel, Inspector ×2,
Canvas, useSlideThumbnails, useSlideBackground, useSlideObjectChanges).
`SlideItem` is unmemoized; `EditorLayout` (2.8k lines) subscribes to
`useSlideObjects`/`useAnimations` at the top.
**Fix order:** (1) rAF-coalesce drag mutations; (2) rAF-batch + event-filter
`subscribeToSlides`; (3) add a metadata-only `useSlideSummaries()` and migrate
consumers; (4) `React.memo(SlideItem)`; (5) ref-ify `objects` in
EditorLayout's pointer callbacks. Validate with `pnpm load:all` hot-edit
baseline.

### PERF-2 (HIGH, confirmed): persistence stores full doc state every flush

`hocuspocus/persistence.ts:154` — `Y.encodeStateAsUpdate(doc)` with no state
vector → a near-full snapshot row per ≤10 s of editing; `onLoadDocument`
replays all rows. 2 MB deck edited an hour ≈ ~0.7 GB and ever-slower cold
loads. **Fix:** since every row is already a full snapshot, cheapest correct
fix is snapshot+delete-older in one tx and load only the newest row; or true
deltas via tracked state vectors + periodic compaction. Pin behavior in
`lifecycle.test.ts`; needs a small ADR + migration note.

### PERF-3 (HIGH): thumbnail localStorage blob rewritten synchronously per refresh

`deckThumbnailCache.ts:31-66` — every `setDeckThumbnail` JSON-parses and
re-stringifies the whole ~2 MB 50-entry store + synchronous `setItem`, fired
every 500 ms while editing slide 1 (~25-70 ms main-thread stall each).
**Fix:** per-deck keys, in-memory cache, or async IndexedDB + debounce.

### PERF-4 (MEDIUM, cluster): thumbnails & tables

- Reorder/skip-toggle re-renders **every** thumbnail (`useSlideThumbnails.ts:487`)
  — skip when no `isSlideNumber` leaf exists; else only affected slides.
- Deck-event callback deep-converts the whole slide per rAF tick _before_ the
  500 ms debounce (`useSlideThumbnails.ts:293-318`) — move inside the debounce.
- One keystroke in a table cell restyles + DOM-measures every cell
  (`tableRenderer.ts:829-852` via whole-`rows` patches) — patch only the
  edited cell; also `textRenderer.ts:832` rebuilds `HTMLTextStyle` on
  text-only patches against its own documented contract.
- `SceneGraph.applyChanges:311-322` O(n²) child-order resync on update-only
  flushes — gate on added/removed.
- `main.tsx:108` top-level `await import('@sentry/react')` blocks first render
  in prod — fire-and-forget it.

### PERF-5 (MEDIUM, server/infra quick wins)

- pg `Pool` without `max`/timeouts; API+Hocuspocus share one default-10 pool,
  worker has another (`db/client.ts:26`, `video-worker/src/db.ts:33`).
- Missing composite indexes: `media_assets (deck_id, kind)`,
  `(folder_id, kind)`, partial font-postscript index (`schema.ts:306`).
- 2 GB synchronous PPTX parse on the API event loop (`pptxImport.ts:93`,
  `tus.ts:604`) — lower cap drastically, enforce unzip entry/size limits
  (zip-bomb), move to BullMQ (also a DoS finding).
- No route-level code splitting — `React.lazy` the editor routes to keep
  Pixi/Tiptap/GSAP off the dashboard path (`App.tsx:18-31`).

---

## P1 — security, remaining

- **CONN-1 (MEDIUM):** Hocuspocus resolves role once at connect
  (`hocuspocus/index.ts:68`); revoked/downgraded users keep live RW sync until
  disconnect. Close connections on revoke. (Verified clean: `readOnly` _is_
  enforced server-side by @hocuspocus/server on SyncStep2/update messages.)
- **TUS-1 (LOW/MED):** `onIncomingRequest` checks only "some valid session" on
  PATCH/DELETE; upload isn't bound to its creator, and `onUploadFinish`
  doesn't re-resolve deck access (`tus.ts:515-528`). Bind creator+deck
  decision at create, re-check at finish.
- **IDOR-1 (MEDIUM):** folder-font delete clones assets into _every_ deck in
  the folder regardless of deck owner (`media/routes.ts:604-628`) — scope to
  caller-owned decks.
- **DOS-1 (MEDIUM):** no Yjs doc-size cap or update-rate limit
  (`hocuspocus/index.ts:206`) — enforce max encoded size in `onStoreDocument`.
- **OPS:** hard-fail boot when `BYPASS_AUTH=true && NODE_ENV=production`
  (note `isDev = NODE_ENV !== 'production'`, so an _unset_ NODE_ENV is dev);
  set `METRICS_TOKEN` in prod; plan the `narrative_csrf` double-submit token
  before any SameSite relaxation / M24 iframe embeds; tighten imgproxy CORS;
  clamp animation DSL duration/repeats at compile time (client DoS).

---

## P2 — quality & tooling

- **Broken documented workflows (HIGH):** `apps/web` has **no `test:e2e`
  script** though CLAUDE.md references it in 7 rows and 38 specs exist — add
  `"test:e2e": "playwright test"`. `pnpm load:all` fails: `tests/load` isn't a
  workspace member so its `ts-node` is never installed — switch the loader to
  `tsx` (repo standard) or add the workspace glob.
- **Worker resilience:** no `unhandledRejection` handlers in server/worker; no
  Sentry in video-worker; `void updateTranscodeStatus(...)` in the `failed`
  handler can reject unobserved (`video-worker/src/index.ts:58`).
- **Invariant leaks (the only two):** raw Y mutations in
  `apps/web/src/state/applyShapeMask.ts:152` and the manual splice in
  `TextEditOverlay.tsx:491` belong in `slide-model/src/mutations.ts`.
  Everything else checked airtight (Animation=DSL: zero GSAP outside the
  package; Hocuspocus config test-guarded; tus metadata rule followed; package
  boundaries clean).
- **CRDT design note:** slide/object reorders are clone+delete+insert
  (`mutations.ts:455`, `slides.ts:262`) — concurrent remote edits to the moved
  item within one round-trip are silently dropped. Architecture-level;
  document it and consider fractional ordering keys long-term.
- **Animation nit:** `compiler.ts:78-88` — `addPause('>')` anchors to the last
  _added_ tween, `addLabel()` to timeline end; with
  `afterPrevious+withPrevious+onClick` the pause lands mid-animation. Anchor
  both to the same computed time.
- **Present-mode polish:** aborting a transition mid-flight (spam arrow keys)
  leaves the slide root frozen mid-tween (offset/dim) — reset
  position/scale/alpha in the abort path (`playTransition.ts:251`,
  `PresentLayout.tsx:295`).
- **Smalls:** dedupe `parseDataUrl` (decks.ts:94 / components.ts:43);
  `console.*` → pino in persistence/tus hot paths + add `no-console` rule;
  delete or React-19-align dead `packages/ui` (React 18 peer footgun);
  `folders.ts:248` returns a body with 204 (client never sees
  `deletedDeckCount`); Drafts-folder provisioning race (`folders.ts:60`);
  consolidate the ~12 ad-hoc `asAny` Pixi helpers into one typed
  `PixiInternals` helper; `colorHex` invalid CSS for out-of-range ints
  (`richText.ts:119`).

---

## Confirmed healthy (so it's on record)

Auth stack end-to-end (OIDC/PKCE server-side, opaque hashed sessions, sliding
expiry, open-redirect guard); Hocuspocus per-connection re-auth + server-side
readOnly enforcement; IDOR coverage on deck/folder/sharing/component routes
incl. last-owner guards; share-token scoping (no cross-resource reach); tus
auth chain incl. per-MIME caps and non-reflecting CORS; imgproxy
allowed-sources + HMAC signing (no SSRF); drizzle parameterization (no SQLi);
fast-xml-parser defaults (no XXE in PPTX); no secrets in repo, env-forced
compose; PPTX parser doesn't fetch external targets; no prototype-pollution
surface; strict TS config (`noUncheckedIndexedAccess`,
`exactOptionalPropertyTypes`); idle-clean renderer (autoStart:false +
dirty-flag scheduler — zero renders when idle); incremental scene diff;
**gradient procedural-texture leak from the M-era backlog is fixed**
(refcounted ResourceManager cache + LRU backstop); awareness 30 Hz throttled
with minimal payload; deck-list endpoints batched (no N+1); vendor chunking
clean (no ffmpeg/three/lottie in web bundle); video-worker job idempotency.

## Suggested attack order

1. XSS-1 + XSS-2 + XSS-3/MEDIA-1 + security headers — one coordinated
   "UGC hardening" PR set (closes the inject→execute→exfiltrate chain).
2. DL-1/DL-2/DL-3 — silent data loss, each a small scoped fix + test.
3. PERF-1 (+ PERF-3) — editor feel; then PERF-2 with ADR + migration.
4. Tooling (`test:e2e` script, load-test loader) — unblocks CLAUDE.md
   workflows; then the P1 security remainder and P2 list opportunistically.
