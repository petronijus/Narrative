# ADR 0007 — The production CSP is a renderer constraint, not just a header

**Status**: Accepted (2026-09-09).
**Scope**: `infra/caddy/Caddyfile` (the SPA `Content-Security-Policy`) and
every code path in `apps/web/src/renderer/` that PixiJS drives. Does not
touch the `/storage/*` sandbox policy, which stays stricter by design.
**Related**: `docs/audits/2026-06-12-security-perf-quality-audit.md` (where
the policy was first written), `docs/handoff/0.9.x-production-hardening.md`
(the four failures that produced this ADR).

## Context

Narrative serves its SPA under a deliberately tight, same-origin CSP. Vite's
dev server sends **no CSP at all**, so the policy is exercised for the first
time in production, on a build that is also minified differently. Between
2026-09-07 and 2026-09-09 that gap produced four separate rendering failures,
all of them from PixiJS and none of them visible in `pnpm dev`:

| Directive            | What Pixi does                                                                                                 | Symptom in production                                             |
| -------------------- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `script-src 'self'`  | v8 compiles shader code with `new Function`                                                                    | `app.init()` throws — renderer never starts, canvas fully blank   |
| `worker-src 'none'`  | decodes textures in a Worker                                                                                   | `Assets.load()` never settles — text renders, images never appear |
| `font-src 'self'`    | HTMLText embeds the font as a `data:` URL inside a generated SVG (`loadFontCSS.mjs`: `src: url('${dataSrc}')`) | every canvas text silently falls back to a system face            |
| `connect-src 'self'` | `checkImageBitmap` fetches a 1×1 `data:` PNG in the texture worker                                             | throws on every texture load                                      |

Two properties of these failures matter more than the individual fixes:

1. **A CSP denial is usually silent to the application.** A blocked worker
   leaves a promise that never resolves; a blocked font leaves a plausible
   wrong-looking result. Only the browser console names the directive, and
   only if someone is looking at production with devtools open.
2. **Adjacent code paths mask each other.** Slide thumbnails decode via
   `Image.decode()` rather than the Pixi texture worker, so thumbnails kept
   working while the canvas showed nothing — which pointed the first round of
   diagnosis at the wrong layer entirely.

## Decision

**The CSP is treated as a hard constraint on the renderer, and the renderer
adapts to it — the policy is loosened only for a capability that cannot be
provided any other way, and only to the narrowest value that provides it.**

Concretely:

- **`script-src` stays `'self'`.** No `'unsafe-eval'`, ever. Pixi's
  requirement is met by its own eval-free build: `import 'pixi.js/unsafe-eval'`
  at renderer entry. When a future dependency wants `eval`, the answer is the
  dependency's eval-free path or a different dependency.
- **`script-src` stays free of `'unsafe-inline'`**, which is why Cloudflare's
  injected Web Analytics beacon is blocked and stays blocked. The fix for that
  noise is switching Web Analytics off in the Cloudflare dashboard, not
  widening the policy for a third-party script.
- **`data:` is allowed where a browser API only accepts a data URL** —
  currently `font-src` and `connect-src`, both for Pixi's own internals. A
  `data:` URL cannot reach the network, so this does not create an
  exfiltration path.
- **`blob:` is allowed for `worker-src` and `img-src`**, because Pixi
  constructs its texture worker and some textures as blobs.
- **Everything else remains same-origin.** `object-src 'none'`,
  `base-uri 'self'`, `frame-ancestors 'none'`, `frame-src 'none'`.

The policy is stated once, on the SPA `handle {}` block in
`infra/caddy/Caddyfile` — deliberately **not** in the site-wide `header {}`
block, so it can never override the stricter `Content-Security-Policy sandbox`
that `/storage/*` puts on user-uploaded objects.

## Consequences

- **Any change to the renderer's asset, font, worker, or network path must be
  checked against the deployed CSP before it is called done.** The dev server
  will not tell you.
- **Verify the policy from the public URL, not from the repo.** `curl -sI
https://<domain>/ | grep -i content-security-policy`. The file on disk is not
  evidence that the header is live — see ADR 0008 and the single-file bind
  mount trap in PR #73.
- **When production renders wrong and dev renders right, read the CSP first.**
  It has now been the cause four times out of four.
- Each new directive value carries a comment in the Caddyfile naming the exact
  Pixi behaviour that needs it, so a future tightening pass can tell a
  requirement from an accident.
- The residual risk is accepted: `style-src` keeps `'unsafe-inline'` (Pixi and
  Tailwind both write inline styles) and `img-src`/`worker-src` keep `blob:`.
  These are same-origin-ish sinks with no script execution.
