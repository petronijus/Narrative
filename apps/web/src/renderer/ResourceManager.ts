/**
 * renderer/ResourceManager.ts
 *
 * Centrální správce GPU zdrojů — textury, assety, external rendery.
 *
 * Principy:
 * - Resource manager má poslední slovo nad alokací/dealokací GPU zdrojů.
 * - Object renderers neznají texture lifecycle — žádají resource manager.
 * - Ref counting: acquireTexture inkrementuje, releaseTexture dekrementuje.
 *   Při refCount=0 je textura zničena a GPU paměť uvolněna.
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
 * P12c: cap on the procedural texture cache. Even with correct
 * acquire/release ref-counting, the LRU is a backstop so a missed
 * release (or a runaway slider scrub building thousands of unique keys)
 * can't grow GPU memory unbounded. Entries are only evicted when their
 * refCount has dropped to zero — no in-use texture is ever reclaimed.
 */
const PROCEDURAL_LRU_CAP = 128

export class ResourceManager {
  private readonly textures = new Map<string, TextureEntry>()

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
   */
  async acquireTexture(url: string): Promise<Texture> {
    const existing = this.textures.get(url)
    if (existing !== undefined) {
      existing.refCount += 1
      return existing.texture
    }

    let texture: Texture | null = null
    try {
      // Pin the loader explicitly: imgproxy URLs end in `@webp` / `@jpg`
      // (format spec, not a file extension), so Pixi's extension-based
      // dispatch otherwise warns "could not be loaded as we don't know
      // how to parse it" before falling back. `parser: 'loadTextures'`
      // tells Pixi to use the bitmap/texture loader regardless of the
      // URL's tail (Pixi 8 renamed `loadParser` → `parser`).
      texture = await Assets.load<Texture>({ src: url, parser: 'loadTextures' })
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

    this.textures.set(url, { texture, refCount: 1 })
    return texture
  }

  /**
   * Uvolní referenci na texturu. Při refCount=0 zničí texturu a uvolní GPU paměť.
   * Volání releaseTexture na neexistující URL je no-op (bezpečné).
   *
   * Uses Assets.unload(url) for textures that came through Assets.load
   * (the happy path); falls back to texture.destroy(true) for the
   * <img>-decoded fallback below where the texture isn't tracked by
   * Assets. This avoids Pixi's "managed TextureSource was destroyed
   * instead of unloaded" warning that fires on every poster swap.
   */
  releaseTexture(url: string): void {
    const entry = this.textures.get(url)
    if (entry === undefined) return

    entry.refCount -= 1
    if (entry.refCount <= 0) {
      void Assets.unload(url).catch(() => {
        // Not in the Assets cache (came from the <img> fallback path) —
        // destroy directly. Catch keeps the cleanup chain alive even if
        // Assets has already unloaded the source from another release.
        if (!entry.texture.destroyed) entry.texture.destroy(true)
      })
      this.textures.delete(url)
    }
  }

  /**
   * Zničí všechny spravované textury. Volat při unmount aplikace.
   * Po volání destroyAll() není instance použitelná.
   */
  destroyAll(): void {
    for (const [url, entry] of this.textures) {
      void Assets.unload(url).catch(() => {
        if (!entry.texture.destroyed) entry.texture.destroy(true)
      })
    }
    this.textures.clear()
    for (const [, entry] of this.procedural) {
      entry.texture.destroy(true)
    }
    this.procedural.clear()
  }

  /** Počet aktuálně spravovaných textur (pro debugging a testy). */
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
