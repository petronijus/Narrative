# Image quality — retina resolution + AVIF + result cache

Date: 2026-05-30

## Why

Imported (and uploaded) images looked soft. Investigation showed storage is
verbatim — the loss was entirely at display time: the editor canvas always
requested the `display` imgproxy variant, capped at **1600 px** and re-encoded
to **WebP**. On a retina screen (everyone here) or under editor zoom the canvas
rasterises at `devicePixelRatio × zoom`, so a 1600 px 1× texture gets upscaled →
blurry. Source images larger than 1600 px were also needlessly downsampled.

## What changed

1. **`display` variant cap 1600 → 2560 px** (`apps/server/src/media/imgproxyUrl.ts`).
   Stays crisp at 2× retina + zoom. `enlarge=0` is unchanged, so imgproxy still
   never upscales — a small logo stays its native size, no wasted bytes.
2. **Default output format WebP → AVIF** (same file). ~30-50 % smaller than WebP
   at equal quality. Current-Chrome target, so no fallback format needed. The
   2.5× pixel bump from the higher cap is mostly clawed back by AVIF, so a cold
   transfer is only modestly heavier than before while looking far sharper.
3. **imgproxy AVIF tuning** (`infra/docker-compose.yml`): `IMGPROXY_AVIF_SPEED=8`
   (fast encode — matters on the modest self-hosted CPU), `FORMAT_QUALITY=avif=63`
   (~WebP 80), `MAX_SRC_RESOLUTION=50` (decompression-bomb guard, = default).
4. **New nginx result-cache sidecar** (`infra/imgproxy-cache/nginx.conf` +
   `imgproxy-cache` service). Open-source imgproxy has **no result cache** —
   without one, every browser cache-miss re-encodes from scratch, and AVIF
   encode is CPU-heavy. The sidecar caches each encoded variant on disk so a
   given (asset, variant, format) encodes **once**, then serves off disk. Keyed
   on the full signed `$request_uri` (deterministic → collision-free). Includes
   `proxy_cache_lock` (thundering-herd collapse) and stale-while-revalidate.

## ⚠️ Deploy note (breaking infra change)

Caddy's `/imgproxy/*` route now points at **`imgproxy-cache:80`**, not
`imgproxy:8080` (`infra/caddy/Caddyfile`). A prod deploy that doesn't start the
new `imgproxy-cache` container will **502 on every image**. The base compose
defines the service, so a normal `docker compose up -d` brings it up — just make
sure the stack is recreated, not only `server`/`web` restarted.

New env (all have defaults; see `.env.example` + `infra/.env.prod.example`):
`IMGPROXY_AVIF_SPEED`, `IMGPROXY_FORMAT_QUALITY`, `IMGPROXY_MAX_SRC_RESOLUTION`,
`IMGPROXY_CACHE_PORT`, `IMGPROXY_CACHE_DATA_PATH` (prod ZFS dataset for the cache
volume — safe to wipe, it just re-encodes).

**Dev is unaffected**: Vite proxies `/imgproxy` straight to imgproxy:8080 (no
cache, no Caddy). The strong dev box doesn't need the cache.

## Scope / what was deliberately NOT touched

- **Crop / `imageRect`**: resolution-independent by design — the sprite is scaled
  so the texture maps to `imageRect` in _slide coords_ (`imageRenderer.ts`
  `layoutSprite`), and the mask clips in object-local coords. Higher-res textures
  change sharpness only, not geometry. Verified, no change needed.
- **Thumbnails** (`thumb` 400×225 / `preview` 600) — untouched; small tiles don't
  benefit from the bump and we keep their bandwidth low. They now also serve AVIF
  (smaller) since the default extension changed, which is a free win.
- **Video** transcode ceiling (1080p / CRF 23) — separate, larger trade-off;
  left for a follow-up. Video _posters_ do ride the new `display` AVIF path.

## Verification

- `pnpm --filter server test` — 398 passed / 1 skipped (incl. updated
  `imgproxyUrl.test.ts`: display→2560, default→avif).
- `pnpm --filter web test src/renderer/imageUrl.test.ts` — 9 passed.
- `pnpm typecheck` clean, `pnpm lint` 0 errors.
- `docker compose config` validates for base + prod compositions; new service
  - volume render correctly.
- Renderer is format-agnostic (`ResourceManager.acquireTexture` uses
  `parser: 'texture'` + `<img>.decode()` fallback) — AVIF decodes natively.

## Follow-up worth doing

- A renderer-visual e2e that imports a >2560 px image and asserts the loaded
  texture's intrinsic size — locks in the cap so a future regression to 1600 is
  caught.
- Verify AVIF in a real browser run (the encode path is only exercised against a
  live imgproxy; unit tests cover URL construction, not the pixels).
