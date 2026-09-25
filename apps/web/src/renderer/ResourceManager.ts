/**
 * renderer/ResourceManager.ts
 *
 * Centrální správce GPU zdrojů — textury, assety, external rendery.
 *
 * Principy:
 * - Resource manager má poslední slovo nad alokací/dealokací GPU zdrojů.
 * - Object renderers neznají texture lifecycle — žádají resource manager.
 * - Ref counting: acquireTexture inkrementuje, releaseTexture dekrementuje.
 *   Při refCount=0 je textura po krátké lhůtě (UNLOAD_GRACE_MS) uvolněna;
 *   acquire v té lhůtě ji převezme zpět bez nového načítání.
 * - A texture is never handed out while it is being unloaded: a load of a
 *   URL whose unload is still running waits for that unload to finish.
 *
 * M1: Malý scope — rectangle nepotřebuje textury. API existuje a je testované.
 * M11 (image uploads): ResourceManager bude zásadní — rozhraní musí být stabilní.
 */

import { Assets, Texture, type TextureSourceOptions } from 'pixi.js'

interface TextureEntry {
  texture: Texture
  refCount: number
}

/**
 * A texture loaded from a URL. The entry exists from the first acquire on,
 * holding the load itself: every acquire that arrives while it runs shares
 * it, so the ref count is right from the start. (Recording the entry only
 * once the load had finished let two concurrent acquires each start a load
 * and each write a ref count of 1 — the first release then unloaded the
 * texture the other object was still drawing.)
 */
interface UrlTextureEntry {
  load: Promise<Texture>
  /** The loaded texture, once `load` has resolved. */
  texture: Texture | null
  refCount: number
  /** The unload waiting out UNLOAD_GRACE_MS once nothing holds the texture. */
  unloadTimer: ReturnType<typeof setTimeout> | null
}

/**
 * How long a texture nothing holds any more stays loaded before it is
 * unloaded. Switching slides, duplicating one, or undoing a delete removes
 * objects and mounts them (or others showing the same image) again right
 * away — but an image object only acquires its texture after resolving its
 * URL, which can take a round trip. Within the grace the texture is simply
 * taken back; after it, it is loaded again. Correctness does not depend on
 * the length: a load never overlaps an unload of the same URL (see
 * `unloading`), whatever the timing.
 */
export const UNLOAD_GRACE_MS = 5000

/**
 * P12c: cap on the procedural texture cache. Even with correct
 * acquire/release ref-counting, the LRU is a backstop so a missed
 * release (or a runaway slider scrub building thousands of unique keys)
 * can't grow GPU memory unbounded. Entries are only evicted when their
 * refCount has dropped to zero — no in-use texture is ever reclaimed.
 */
const PROCEDURAL_LRU_CAP = 128

export class ResourceManager {
  private readonly textures = new Map<string, UrlTextureEntry>()

  /**
   * Unloads in progress, by URL. Pixi's `Assets.unload` is asynchronous and
   * keeps the asset in its own cache until it has finished; an
   * `Assets.load` of the same URL in that window returns the texture about
   * to be destroyed. An object mounted with it made every later frame throw
   * (Pixi's batcher reads the destroyed texture's source) — the canvas
   * stopped drawing after a slide was duplicated. So a load waits for them.
   */
  private readonly unloading = new Map<string, Promise<void>>()

  /**
   * P12c: ref-counted cache for procedurally generated textures
   * (gradient fills, image fills painted into a canvas, future pattern
   * fills). Keys are caller-defined structural hashes — see
   * `acquireProcedural` for the contract.
   *
   * Insertion order is preserved by Map iteration, which the LRU sweep
   * relies on: the oldest entry sits at the front, the most recently
   * used at the back. Cache hits re-insert the entry to bump it to the
   * back so frequent-access keys survive eviction.
   */
  private readonly procedural = new Map<string, TextureEntry>()

  /**
   * Načte texturu z URL (nebo vrátí cachouvanou). Inkrementuje ref count.
   * Volající je zodpovědný za zavolání releaseTexture() po použití.
   *
   * A texture released to zero but still within its grace is taken back
   * as it is. A failed load leaves no entry behind, so the next acquire
   * tries again; the callers that shared it hold no reference to release.
   */
  acquireTexture(url: string): Promise<Texture> {
    const existing = this.textures.get(url)
    if (existing !== undefined) {
      existing.refCount += 1
      if (existing.unloadTimer !== null) {
        clearTimeout(existing.unloadTimer)
        existing.unloadTimer = null
      }
      return existing.load
    }

    const entry: UrlTextureEntry = {
      load: this.loadTexture(url),
      texture: null,
      refCount: 1,
      unloadTimer: null,
    }
    entry.load.then(
      (texture) => {
        entry.texture = texture
      },
      () => {
        if (this.textures.get(url) === entry) this.textures.delete(url)
      },
    )
    this.textures.set(url, entry)
    return entry.load
  }

  private async loadTexture(url: string): Promise<Texture> {
    const unloading = this.unloading.get(url)
    if (unloading !== undefined) await unloading

    let texture: Texture | null = null
    try {
      // Pin the loader explicitly: imgproxy URLs end in `@avif` / `@webp`
      // / `@jpg` (format spec, not a file extension), so Pixi's extension-based
      // dispatch otherwise warns "could not be loaded as we don't know
      // how to parse it" before falling back. `parser: 'texture'`
      // tells Pixi to use the bitmap/texture loader regardless of the
      // URL's tail.
      texture = await Assets.load<Texture>({ src: url, parser: 'texture' })
    } catch {
      texture = null
    }

    // Fallback for URLs that even the explicit loader can't parse —
    // load via HTMLImageElement directly so we still get a Texture.
    if (!texture || !(texture as { source?: unknown }).source) {
      const img = new Image()
      img.crossOrigin = 'anonymous'
      img.src = url
      await img.decode()
      texture = Texture.from(img as unknown as TextureSourceOptions)
    }
    return texture
  }

  /**
   * Uvolní referenci na texturu. Při refCount=0 texturu po UNLOAD_GRACE_MS
   * uvolní z GPU, pokud si ji mezitím nikdo znovu nevyžádá.
   * Volání releaseTexture na neexistující URL je no-op (bezpečné).
   */
  releaseTexture(url: string): void {
    const entry = this.textures.get(url)
    if (entry === undefined || entry.refCount === 0) return

    entry.refCount -= 1
    if (entry.refCount > 0) return
    entry.unloadTimer = setTimeout(() => {
      entry.unloadTimer = null
      if (this.textures.get(url) !== entry || entry.refCount > 0) return
      this.textures.delete(url)
      this.unload(url, entry)
    }, UNLOAD_GRACE_MS)
  }

  /**
   * Uses Assets.unload(url) for textures that came through Assets.load
   * (the happy path); falls back to texture.destroy(true) for the
   * <img>-decoded fallback where the texture isn't tracked by Assets.
   * This avoids Pixi's "managed TextureSource was destroyed instead of
   * unloaded" warning that fires on every poster swap.
   */
  private unload(url: string, entry: UrlTextureEntry): void {
    const done: Promise<void> = entry.load.then(
      (texture) =>
        Assets.unload(url).catch(() => {
          // Not in the Assets cache (came from the <img> fallback path) —
          // destroy directly.
          if (!texture.destroyed) texture.destroy(true)
        }),
      // The load itself failed: nothing to unload.
      () => undefined,
    )
    this.unloading.set(url, done)
    void done.then(() => {
      if (this.unloading.get(url) === done) this.unloading.delete(url)
    })
  }

  /**
   * Zničí všechny spravované textury. Volat při unmount aplikace.
   * Po volání destroyAll() není instance použitelná.
   */
  destroyAll(): void {
    for (const [url, entry] of this.textures) {
      if (entry.unloadTimer !== null) clearTimeout(entry.unloadTimer)
      this.unload(url, entry)
    }
    this.textures.clear()
    for (const [, entry] of this.procedural) {
      entry.texture.destroy(true)
    }
    this.procedural.clear()
  }

  /**
   * Počet aktuálně spravovaných textur (pro debugging a testy) — including
   * those nothing holds that are still within their grace: they are still
   * on the GPU.
   */
  get textureCount(): number {
    return this.textures.size
  }

  /** Ref count pro danou URL (pro debugging a testy). */
  getRefCount(url: string): number {
    return this.textures.get(url)?.refCount ?? 0
  }

  /**
   * P5c: sync-friendly cache peek used by image fills on shapes. Does NOT
   * change ref count — it's a read-only probe so the caller can decide
   * whether to paint now or wait for an async acquire to finish.
   */
  peekTexture(url: string): Texture | null {
    return this.textures.get(url)?.texture ?? null
  }

  // -------------------------------------------------------------------------
  // P12c: procedural texture cache
  // -------------------------------------------------------------------------

  /**
   * Acquires a procedurally generated texture by structural key. The
   * factory is invoked exactly once per unique key — subsequent
   * `acquire` calls with the same key simply bump the ref-count and
   * return the cached Texture.
   *
   * Contract for callers:
   *   - The `key` MUST capture every input that affects the painted
   *     pixels (kind, stops, dimensions, etc). Two distinct visual
   *     outputs sharing a key would alias each other on screen.
   *   - Every successful `acquireProcedural` MUST be paired with exactly
   *     one `releaseProcedural` (typically when the renderer either
   *     transitions to a new key or destroys its container).
   *
   * The factory's returned Texture is owned by the ResourceManager
   * once handed over — caller MUST NOT call `texture.destroy()`.
   */
  acquireProcedural(key: string, factory: () => Texture): Texture {
    const existing = this.procedural.get(key)
    if (existing !== undefined) {
      existing.refCount += 1
      // LRU bump: re-insert at the end of iteration order.
      this.procedural.delete(key)
      this.procedural.set(key, existing)
      return existing.texture
    }

    const texture = factory()
    this.procedural.set(key, { texture, refCount: 1 })
    this.evictProceduralIfNeeded()
    return texture
  }

  /**
   * Decrement the ref-count for a procedural texture. When the count
   * hits zero the entry stays in the cache (so a quick re-acquire of
   * the same key is free) but is eligible for LRU eviction.
   */
  releaseProcedural(key: string): void {
    const entry = this.procedural.get(key)
    if (entry === undefined) return
    entry.refCount -= 1
    if (entry.refCount < 0) entry.refCount = 0
    // Don't destroy on refCount=0 — keep the entry so a fast
    // round-trip (slider that lands back on a previous key) reuses it.
    // The LRU sweep below reclaims when memory pressure builds.
  }

  /**
   * Number of cached procedural textures (regardless of ref count).
   * Surfaced through the perf HUD so we can watch the cache breathe.
   */
  get proceduralTextureCount(): number {
    return this.procedural.size
  }

  /**
   * Sum of (textures + procedural) so the perf HUD can show one
   * aggregate "managed textures" number.
   */
  get totalManagedTextureCount(): number {
    return this.textures.size + this.procedural.size
  }

  private evictProceduralIfNeeded(): void {
    if (this.procedural.size <= PROCEDURAL_LRU_CAP) return
    // Evict from the front (oldest) until we're back under the cap, but
    // only entries with refCount === 0. Skip entries that are still
    // held by a live container — those would crash on next render if
    // we destroyed their texture.
    for (const [key, entry] of this.procedural) {
      if (this.procedural.size <= PROCEDURAL_LRU_CAP) break
      if (entry.refCount > 0) continue
      entry.texture.destroy(true)
      this.procedural.delete(key)
    }
  }
}

// ---------------------------------------------------------------------------
// Module-level default ResourceManager (installed at app bootstrap)
// ---------------------------------------------------------------------------

let defaultResourceManager: ResourceManager | null = null

/**
 * Install the default ResourceManager instance.
 * Must be called in Canvas.tsx after the ResourceManager is created,
 * before any imageRenderer is mounted.
 */
export function setDefaultResourceManager(rm: ResourceManager): void {
  defaultResourceManager = rm
}

/**
 * Returns the installed default ResourceManager.
 * Throws if setDefaultResourceManager() was not called yet.
 */
export function getDefaultResourceManager(): ResourceManager {
  if (defaultResourceManager === null) {
    throw new Error(
      '[ResourceManager] No default instance installed — call setDefaultResourceManager() first',
    )
  }
  return defaultResourceManager
}

/**
 * Reset the default ResourceManager (for testing).
 * @internal
 */
export function _resetDefaultResourceManager(): void {
  defaultResourceManager = null
}
