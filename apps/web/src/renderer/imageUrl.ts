/**
 * renderer/imageUrl.ts
 *
 * Signed imgproxy URL resolver for every picture the renderer draws (image
 * objects, backgrounds, fills, posters) and the present-mode preload.
 *
 * Design:
 * - Framework-agnostic (no React, no Vite env reads). Pure TS.
 * - Batched (docs/plans/performance.md → L3): every asset asked for within
 *   one task goes out in one `GET /api/media/urls?ids=…&variants=…` (at most
 *   MEDIA_URLS_MAX_IDS ids a request), which answers all of them with one
 *   query and one access check per deck or folder. It used to be one
 *   `GET /api/media/:id/url` per (asset, variant), each its own queries. An
 *   asset is always asked for with the screen variants (`preview` for the
 *   slide panel, `medium` and `display` for the canvas), so a thumbnail, the
 *   canvas and a later upgrade to `display` share one round trip; `thumb` and
 *   `original` are added when someone asks for them. The ids of a request are
 *   sorted, so the deck-wide prefetch of a deck that did not change is the same
 *   URL as last time — its answer may come from the HTTP cache
 *   (`private, max-age=600`, as the single route).
 * - In-memory cache keyed by `${assetId}:${variant}`, of Promises, so
 *   concurrent callers share one fetch; the asset's pixel size is cached by
 *   id (`asset`), for the canvas's variant choice (imageVariant.ts).
 * - On a failure (the request, or an asset the caller may not have) the
 *   entries go, so the next call asks again.
 * - Per share token: the cache belongs to the page's `share_token` (or to
 *   the session when there is none); a page whose token changes starts a
 *   fresh one, so what one link may read is never served under another.
 * - A module-level default resolver is installed at app bootstrap time via
 *   setDefaultImageUrlResolver(). Renderer code calls getDefaultImageUrlResolver().
 *
 * Bootstrap (Canvas.tsx):
 *   setDefaultImageUrlResolver(createImageUrlResolver(API_BASE))
 *
 * Auth: the request goes with `credentials: 'include'`, so the
 * narrative_session cookie travels on same-origin (prod) and same-site
 * cross-origin (dev); a share-link visit (or the render page) adds its token.
 */

import {
  IMAGE_VARIANTS,
  MEDIA_URLS_MAX_IDS,
  imageVariantRank,
  type ImageVariant,
  type MediaUrlsResponse,
} from '@narrative/shared'
import { pageShareToken, withShareToken } from '../lib/shareToken.js'
import { trackRenderWork } from './renderWork.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ResolveImageUrlOpts {
  assetId: string
  /** Defaults to 'display'. */
  variant?: ImageVariant
}

/** What the canvas needs to choose an asset's variant: its source's pixel size. */
export interface ResolvedImageAsset {
  assetId: string
  /** The source's size, px; null when it was never probed. */
  width: number | null
  height: number | null
}

/**
 * Resolves signed imgproxy URLs. Callable: the URL of an asset in a variant.
 * Cached per (assetId, variant) for the lifetime of the resolver.
 */
export interface ImageUrlResolver {
  (opts: ResolveImageUrlOpts): Promise<string>
  /** The asset's source size (its screen variants' URLs are resolved with it). */
  asset(assetId: string): Promise<ResolvedImageAsset>
  /**
   * Resolve `assetIds` ahead, in as few requests as there are batches of
   * MEDIA_URLS_MAX_IDS: what a deck shows, when it opens. Settles once they
   * are resolved; never rejects (a failed asset fails again when it is asked for).
   */
  prefetch(assetIds: Iterable<string>): Promise<void>
  /** The URL of an asset in a variant if it is resolved already (the cap applied), else undefined. */
  peek(assetId: string, variant: ImageVariant): string | undefined
}

type Variant = ImageVariant

/** What every asset is asked for with: the slide panel's and the canvas's variants. */
const SCREEN_SET: readonly Variant[] = ['preview', 'medium', 'display']

let variantCap: Variant | null = null

/**
 * Serve no image larger than `cap` until reset (null): the render page sets
 * 'preview' (600 px) while it draws a contact sheet, whose tiles are at most
 * ~700 px wide — loading, decoding and keeping 2560-px pictures for them is
 * what made a sheet of a photo-heavy deck slow and memory-hungry on the
 * render worker. Pictures already loaded stay as they are.
 */
export function setImageVariantCap(cap: Variant | null): void {
  variantCap = cap
}

/** `variant`, or the cap when it is larger (setImageVariantCap). */
export function cappedImageVariant(variant: Variant): Variant {
  return variantCap !== null && imageVariantRank(variant) > imageVariantRank(variantCap)
    ? variantCap
    : variant
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (err: Error) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (err: Error) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  // A rejection nobody awaited (a prefetch's) must not surface as unhandled.
  promise.catch(() => undefined)
  return { promise, resolve, reject }
}

/** One asset waiting for the next request: the variants asked for, and who waits. */
interface PendingAsset {
  variants: Set<Variant>
  urls: Map<Variant, Deferred<string>>
  asset: Deferred<ResolvedImageAsset>
}

/**
 * Builds an ImageUrlResolver bound to a given API base URL.
 *
 * @param apiBaseUrl  Base URL without trailing slash, e.g. 'https://api.example.com'.
 *                    Pass '' to use relative paths (same-origin).
 */
export function createImageUrlResolver(apiBaseUrl: string): ImageUrlResolver {
  /**
   * The cache of one share token (null: the session's). What a share link
   * may read is not what the session may: a page whose token changes (a
   * same-tab navigation to another link) starts a fresh cache, and asks
   * still waiting go out with the token they were made under.
   */
  interface Generation {
    token: string | null
    urls: Map<string, Promise<string>>
    /** The settled ones of `urls`, for `peek`. */
    resolved: Map<string, string>
    assets: Map<string, Promise<ResolvedImageAsset>>
    pending: Map<string, PendingAsset>
    flushScheduled: boolean
  }
  const generation = (token: string | null): Generation => ({
    token,
    urls: new Map(),
    resolved: new Map(),
    assets: new Map(),
    pending: new Map(),
    flushScheduled: false,
  })
  let gen = generation(pageShareToken())

  /** The generation of the page's token now. */
  const current = (): Generation => {
    const token = pageShareToken()
    if (token !== gen.token) {
      if (gen.pending.size > 0) flush(gen)
      gen = generation(token)
    }
    return gen
  }

  const keyOf = (assetId: string, variant: Variant): string => `${assetId}:${variant}`

  /** A deferred URL of `assetId` in `variant`, in the cache from now on (asks during the flight share it). */
  const awaitUrl = (
    g: Generation,
    assetId: string,
    entry: PendingAsset,
    variant: Variant,
  ): Deferred<string> => {
    let d = entry.urls.get(variant)
    if (d === undefined) {
      d = deferred<string>()
      entry.urls.set(variant, d)
      entry.variants.add(variant)
      g.urls.set(keyOf(assetId, variant), d.promise)
    }
    return d
  }

  /**
   * The entry of `assetId` in the next request: its size and its screen
   * variants are cached as promises at once, so whatever asks for them before
   * the answer arrives shares this request.
   */
  const pendingFor = (g: Generation, assetId: string): PendingAsset => {
    let p = g.pending.get(assetId)
    if (p === undefined) {
      p = { variants: new Set(), urls: new Map(), asset: deferred<ResolvedImageAsset>() }
      g.pending.set(assetId, p)
      if (!g.assets.has(assetId)) g.assets.set(assetId, p.asset.promise)
      for (const v of SCREEN_SET) if (!g.urls.has(keyOf(assetId, v))) awaitUrl(g, assetId, p, v)
      // Variants already cached are asked for again: one answer has them all.
      for (const v of SCREEN_SET) p.variants.add(v)
    }
    if (!g.flushScheduled) {
      g.flushScheduled = true
      // One task's worth of asks in one request: every object of a slide
      // mounts in one applyChanges, every thumbnail of a frame in one pass.
      setTimeout(() => flush(g), 0)
    }
    return p
  }

  /** Drop `assetId`'s entries a failed request was to fill, so the next ask retries. */
  const forget = (g: Generation, assetId: string, entry: PendingAsset): void => {
    for (const [variant, d] of entry.urls) {
      const key = keyOf(assetId, variant)
      if (g.urls.get(key) === d.promise) g.urls.delete(key)
    }
    if (g.assets.get(assetId) === entry.asset.promise) g.assets.delete(assetId)
  }

  const fail = (g: Generation, assetId: string, entry: PendingAsset, err: Error): void => {
    forget(g, assetId, entry)
    for (const d of entry.urls.values()) d.reject(err)
    entry.asset.reject(err)
  }

  async function request(g: Generation, batch: Array<[string, PendingAsset]>): Promise<void> {
    const ids = batch.map(([id]) => id).sort()
    const asked = new Set<Variant>()
    for (const [, entry] of batch) for (const v of entry.variants) asked.add(v)
    const variants = IMAGE_VARIANTS.filter((v) => asked.has(v))
    let body: MediaUrlsResponse
    try {
      const url = withShareToken(
        `${apiBaseUrl}/api/media/urls?ids=${ids.map(encodeURIComponent).join(',')}` +
          `&variants=${variants.join(',')}`,
        g.token,
      )
      const res = await fetch(url, { credentials: 'include' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      body = (await res.json()) as MediaUrlsResponse
      if (typeof body !== 'object' || body === null || typeof body.assets !== 'object')
        throw new Error("missing 'assets'")
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      for (const [id, entry] of batch)
        fail(g, id, entry, new Error(`[imageUrl] Failed to resolve ${id}: ${reason}`))
      return
    }
    for (const [id, entry] of batch) {
      const got = body.assets[id]
      if (got === undefined) {
        fail(g, id, entry, new Error(`[imageUrl] Asset ${id} is not available`))
        continue
      }
      // Every variant the answer has is cached, asked for by this ask or not.
      for (const variant of IMAGE_VARIANTS) {
        const signed = got.urls[variant]
        const d = entry.urls.get(variant)
        const key = keyOf(id, variant)
        if (typeof signed !== 'string') {
          d?.reject(new Error(`[imageUrl] No ${variant} URL for ${id}`))
          if (d !== undefined && g.urls.get(key) === d.promise) g.urls.delete(key)
          continue
        }
        g.resolved.set(key, signed)
        if (d !== undefined) d.resolve(signed)
        else if (!g.urls.has(key)) g.urls.set(key, Promise.resolve(signed))
      }
      entry.asset.resolve({ assetId: id, width: got.width, height: got.height })
    }
  }

  function flush(g: Generation): void {
    g.flushScheduled = false
    const batch = [...g.pending]
    g.pending.clear()
    for (let i = 0; i < batch.length; i += MEDIA_URLS_MAX_IDS)
      void request(g, batch.slice(i, i + MEDIA_URLS_MAX_IDS))
  }

  const resolveImageUrl = (opts: ResolveImageUrlOpts): Promise<string> => {
    const g = current()
    const variant = cappedImageVariant(opts.variant ?? 'display')
    const cached = g.urls.get(keyOf(opts.assetId, variant))
    if (cached !== undefined) return cached
    const entry = pendingFor(g, opts.assetId)
    // Counted until it settles, so the render page waits for it (renderWork.ts).
    const promise = trackRenderWork(awaitUrl(g, opts.assetId, entry, variant).promise)
    promise.catch(() => undefined)
    return promise
  }

  const asset = (assetId: string): Promise<ResolvedImageAsset> => {
    const g = current()
    const cached = g.assets.get(assetId)
    if (cached !== undefined) return cached
    const promise = trackRenderWork(pendingFor(g, assetId).asset.promise)
    promise.catch(() => undefined)
    return promise
  }

  const prefetch = async (assetIds: Iterable<string>): Promise<void> => {
    const g = current()
    const waits: Promise<unknown>[] = []
    for (const id of new Set(assetIds)) {
      if (id === '' || g.assets.has(id)) continue
      waits.push(asset(id))
    }
    await Promise.allSettled(waits)
  }

  const peek = (assetId: string, variant: Variant): string | undefined =>
    current().resolved.get(keyOf(assetId, cappedImageVariant(variant)))

  return Object.assign(resolveImageUrl, { asset, prefetch, peek })
}

// ---------------------------------------------------------------------------
// Module-level default resolver (installed at app bootstrap)
// ---------------------------------------------------------------------------

let defaultResolver: ImageUrlResolver | null = null

/**
 * Install the default ImageUrlResolver.
 * Must be called before any imageRenderer is mounted.
 * Typically called in Canvas.tsx useEffect on mount.
 */
export function setDefaultImageUrlResolver(resolver: ImageUrlResolver): void {
  defaultResolver = resolver
}

/**
 * Returns the installed default resolver.
 * Throws if setDefaultImageUrlResolver() was not called yet.
 */
export function getDefaultImageUrlResolver(): ImageUrlResolver {
  if (defaultResolver === null) {
    throw new Error(
      '[imageUrl] No default resolver installed — call setDefaultImageUrlResolver() first',
    )
  }
  return defaultResolver
}

/**
 * Reset the default resolver (for testing).
 * @internal
 */
export function _resetDefaultImageUrlResolver(): void {
  defaultResolver = null
}
