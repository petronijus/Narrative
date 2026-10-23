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
 * - A texture loaded from a URL is handed out once it is on the GPU: large
 *   ones pass the upload gate (textureUploadGate.ts, a bounded number of
 *   pixels per frame) first, so the frame that draws them uploads nothing
 *   and several becoming ready together do not stack into one long frame.
 *
 * M1: Malý scope — rectangle nepotřebuje textury. API existuje a je testované.
 * M11 (image uploads): ResourceManager bude zásadní — rozhraní musí být stabilní.
 */

import { trackRenderWork } from './renderWork.js'
import { perfCount } from '@narrative/shared'
import { Assets, Texture, type TextureSource, type TextureSourceOptions } from 'pixi.js'
import type { TextureUploadGate, UploadPriority } from './textureUploadGate.js'

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
  /** The texture loaded and admitted (on the GPU, or small enough for the frame that draws it). */
  load: Promise<Texture>
  /** The texture, once `load` has resolved. */
  texture: Texture | null
  refCount: number
  /** The unload waiting out UNLOAD_GRACE_MS once nothing holds the texture. */
  unloadTimer: ReturnType<typeof setTimeout> | null
  /** Its way through the upload gate; null once admitted. */
  admission: Admission | null
}

/** A URL texture on its way to the GPU: what its acquirers want it for, and where it waits. */
interface Admission {
  /** The acquirers' priorities while it loads (handed to the gate once it has loaded). */
  priorities: Array<UploadPriority | undefined>
  /** The gate it waits in, once loaded and until admitted. */
  queuedIn: { gate: TextureUploadGate; source: TextureSource } | null
}

/** What an acquirer wants a texture for (the upload gate's order). */
export interface AcquireTextureOptions {
  priority?: UploadPriority
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

/**
 * GPU bytes a texture source occupies: 4 bytes a pixel, a third more with
 * its mipmap chain. An estimate — what a driver allocates is its own — but
 * the same one for every scene, which is what a budget needs.
 */
export function textureSourceBytes(source: TextureSource): number {
  const px = Math.max(0, source.pixelWidth) * Math.max(0, source.pixelHeight)
  return Math.round(px * 4 * (source.autoGenerateMipmaps ? 4 / 3 : 1))
}

/**
 * How much the slide scenes prepared ahead in present mode
 * (renderer/presentSlides.ts) may keep on the GPU, counted over the union of
 * their textures (a photo two slides show counts once). Browsers do not
 * report GPU memory; 1 GiB holds a 12-slide deck of distinct 2560-px photos
 * (~23 MB each with mipmaps) several times over and stays well inside what
 * integrated GPUs of current laptops give a tab. A bigger deck keeps a window
 * of slides around the presenter's position resident, the next slides first.
 */
export const RESIDENT_SCENE_BUDGET_BYTES = 1024 * 1024 * 1024

export class ResourceManager {
  private readonly textures = new Map<string, UrlTextureEntry>()

  /** Texture sources of each resident scene (admitResident), by the scene's key. */
  private readonly residentScenes = new Map<string, ReadonlySet<TextureSource>>()
  private residentBudget = RESIDENT_SCENE_BUDGET_BYTES

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

  /** The upload gate of the canvas this manager serves (null: Pixi uploads in the frame that draws). */
  private uploadGate: TextureUploadGate | null = null
  private uploadHold: (() => boolean) | null = null

  /**
   * Install the gate textures loaded from now on pass before they are handed
   * out (Canvas.tsx, once the renderer exists), or none. A previous gate is
   * flushed: whatever waits in it goes now.
   */
  setUploadGate(gate: TextureUploadGate | null): void {
    if (this.uploadGate === gate) return
    this.uploadGate?.flush()
    this.uploadGate = gate
    gate?.setHold(this.uploadHold)
  }

  /** The installed upload gate, if any. */
  get uploads(): TextureUploadGate | null {
    return this.uploadGate
  }

  /**
   * While `probe` answers true, the gate uploads nothing (present mode: a
   * transition or a build is moving). Kept across `setUploadGate`.
   */
  setUploadHold(probe: (() => boolean) | null): void {
    this.uploadHold = probe
    this.uploadGate?.setHold(probe)
  }

  /**
   * Načte texturu z URL (nebo vrátí cachouvanou). Inkrementuje ref count.
   * Volající je zodpovědný za zavolání releaseTexture() po použití.
   *
   * A texture released to zero but still within its grace is taken back
   * as it is. A failed load leaves no entry behind, so the next acquire
   * tries again; the callers that shared it hold no reference to release.
   *
   * The promise resolves once the texture has passed the upload gate (see
   * `setUploadGate`): until then the caller keeps showing what it showed.
   * `priority` says where it will be drawn and what it replaces, so the gate
   * uploads what is on screen first.
   */
  acquireTexture(url: string, opts: AcquireTextureOptions = {}): Promise<Texture> {
    const existing = this.textures.get(url)
    if (existing !== undefined) {
      existing.refCount += 1
      if (existing.unloadTimer !== null) {
        clearTimeout(existing.unloadTimer)
        existing.unloadTimer = null
      }
      const admission = existing.admission
      if (admission !== null) {
        // Still loading: the gate hears of it once it is queued; queued: now.
        if (admission.queuedIn === null) admission.priorities.push(opts.priority)
        else void admission.queuedIn.gate.admit(admission.queuedIn.source, opts.priority)
      }
      return existing.load
    }

    const admission: Admission = { priorities: [opts.priority], queuedIn: null }
    const entry: UrlTextureEntry = {
      // Counted until it settles — admitted included — so the render page and
      // present mode's preparation wait for it (renderWork.ts).
      load: trackRenderWork(this.loadTexture(url).then((t) => this.admit(t, admission))),
      texture: null,
      refCount: 1,
      unloadTimer: null,
      admission,
    }
    entry.load.then(
      (texture) => {
        entry.texture = texture
        entry.admission = null
      },
      () => {
        if (this.textures.get(url) === entry) this.textures.delete(url)
      },
    )
    this.textures.set(url, entry)
    return entry.load
  }

  /**
   * Pass `texture` through the upload gate, as urgent as the most urgent of
   * its acquirers: a waiter each (the gate orders by the most urgent), and an
   * acquirer that joins while it is queued adds its own (`acquireTexture`).
   */
  private async admit(texture: Texture, admission: Admission): Promise<Texture> {
    const gate = this.uploadGate
    if (gate === null) return texture
    admission.queuedIn = { gate, source: texture.source }
    const priorities = admission.priorities
    admission.priorities = []
    await Promise.all(priorities.map((p) => gate.admit(texture.source, p)))
    return texture
  }

  private async loadTexture(url: string): Promise<Texture> {
    const unloading = this.unloading.get(url)
    if (unloading !== undefined) await unloading

    perfCount('rm.texture.load')
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
   * Unload now every texture nothing holds any more, instead of after its
   * grace. The render page calls it after each slide switch: it renders a
   * deck's slides one after another in one page, and the previous slide's
   * pictures would otherwise stay in (SwiftShader's, i.e. the CPU's) memory
   * while the next one loads — on the render worker's memory limit a sheet
   * of photo-heavy slides ran out (0.10.24).
   */
  flushReleased(): void {
    for (const [url, entry] of [...this.textures]) {
      if (entry.refCount > 0) continue
      if (entry.unloadTimer !== null) clearTimeout(entry.unloadTimer)
      entry.unloadTimer = null
      this.textures.delete(url)
      this.unload(url, entry)
    }
  }

  // -------------------------------------------------------------------------
  // Resident scenes (present mode)
  // -------------------------------------------------------------------------

  /** Change the resident budget (tests; a machine known to have less or more). */
  setResidentBudget(bytes: number): void {
    this.residentBudget = bytes
  }

  /** The budget `admitResident` keeps the resident scenes within. */
  get residentBudgetBytes(): number {
    return this.residentBudget
  }

  /** GPU bytes of every resident scene's textures, each source counted once. */
  get residentBytes(): number {
    return this.unionBytes(this.residentScenes.values())
  }

  /** How many scenes are resident. */
  get residentSceneCount(): number {
    return this.residentScenes.size
  }

  /**
   * Let a slide scene built off stage (renderer/presentSlides.ts) keep
   * `sources` on the GPU. Admitted when the union of every resident scene's
   * textures with these stays within the budget, or with `force` (the slide
   * shown and its neighbours are resident whatever the budget says — showing
   * them is the point); refused otherwise, and the caller destroys the scene.
   * Admitting a key again replaces its sources.
   */
  admitResident(
    key: string,
    sources: ReadonlySet<TextureSource>,
    opts: { force?: boolean } = {},
  ): boolean {
    const others = [...this.residentScenes].filter(([k]) => k !== key).map(([, v]) => v)
    if (opts.force !== true && this.unionBytes([...others, sources]) > this.residentBudget) {
      perfCount('rm.resident.refused')
      return false
    }
    this.residentScenes.set(key, sources)
    return true
  }

  /** The scene `key` is gone (destroyed, or shown and kept by nobody): its sources no longer count. */
  releaseResident(key: string): void {
    this.residentScenes.delete(key)
  }

  private unionBytes(sets: Iterable<ReadonlySet<TextureSource>>): number {
    const seen = new Set<TextureSource>()
    let bytes = 0
    for (const set of sets)
      for (const source of set) {
        if (seen.has(source) || source.destroyed) continue
        seen.add(source)
        bytes += textureSourceBytes(source)
      }
    return bytes
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
    this.residentScenes.clear()
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
   * whether to paint now or wait for an async acquire to finish. Null until
   * the texture has passed the upload gate.
   */
  peekTexture(url: string): Texture | null {
    return this.textures.get(url)?.texture ?? null
  }

  /**
   * Whether a texture of `url` is loaded or loading — held, or released and
   * still within its grace. An image object that may be drawn from a smaller
   * variant takes a larger one of the same picture this says is here instead
   * of loading a second texture (objectRenderers/imageRenderer.ts).
   */
  hasTexture(url: string): boolean {
    return this.textures.has(url)
  }

  /**
   * Textures nothing holds any more, still waiting out UNLOAD_GRACE_MS before
   * they leave the GPU. The memory benches wait for these before they count
   * textures (perf/harness.ts → settle `unloads`): one released a moment
   * before a snapshot is on its way out, not a leak.
   */
  pendingUnloads(): number {
    let n = 0
    for (const entry of this.textures.values()) if (entry.unloadTimer !== null) n++
    return n
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
      perfCount('procedural.hit')
      existing.refCount += 1
      // LRU bump: re-insert at the end of iteration order.
      this.procedural.delete(key)
      this.procedural.set(key, existing)
      return existing.texture
    }

    perfCount('procedural.created')
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
