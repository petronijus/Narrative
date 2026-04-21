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

export class ResourceManager {
  private readonly textures = new Map<string, TextureEntry>()

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
      texture = await Assets.load<Texture>(url)
    } catch {
      texture = null
    }

    // Fallback for URLs with no/unrecognised extension (e.g. imgproxy paths
    // ending in "@webp") where Assets can't pick a loader → returns null/errors.
    // Texture.from bypasses extension detection by loading the URL into an
    // HTMLImageElement directly.
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
   */
  releaseTexture(url: string): void {
    const entry = this.textures.get(url)
    if (entry === undefined) return

    entry.refCount -= 1
    if (entry.refCount <= 0) {
      // Pixi's Assets singleton lives outside of our Pixi app lifecycle.
      // If we .destroy() without Assets.unload(), the Assets cache keeps
      // the URL key pointing at a now-destroyed TextureSource — the next
      // acquireTexture() for the same URL will return the stale zombie
      // texture and render as a grey rectangle. Always unload first.
      void Assets.unload(url).catch(() => undefined)
      entry.texture.destroy(true)
      this.textures.delete(url)
    }
  }

  /**
   * Zničí všechny spravované textury. Volat při unmount aplikace.
   * Po volání destroyAll() není instance použitelná.
   */
  destroyAll(): void {
    for (const [url, entry] of this.textures) {
      void Assets.unload(url).catch(() => undefined)
      entry.texture.destroy(true)
    }
    this.textures.clear()
  }

  /** Počet aktuálně spravovaných textur (pro debugging a testy). */
  get textureCount(): number {
    return this.textures.size
  }

  /** Ref count pro danou URL (pro debugging a testy). */
  getRefCount(url: string): number {
    return this.textures.get(url)?.refCount ?? 0
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
