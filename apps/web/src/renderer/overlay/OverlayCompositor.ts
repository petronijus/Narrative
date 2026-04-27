/**
 * renderer/overlay/OverlayCompositor.ts
 *
 * DOM overlay compositor pro Pixi canvas.
 *
 * Architektura (ze Spike C):
 * - overlayRoot je <div> sousedící s <canvas>, position:absolute;inset:0;pointer-events:none.
 * - Každý registrovaný overlay element: position:absolute; transform:translate(X,Y).
 * - Sync probíhá v Pixi ticker (app.ticker.add) — JEDEN centrální sync bod per RAF tick.
 *
 * KRITICKÉ pořadí v RAF ticku (Spike C nález — jitter = 0 px pouze při správném pořadí):
 *   1. Pixi scene update (automaticky před render)
 *   2. syncAllOverlays() — čte toGlobal(), zapisuje CSS transform
 *   3. (volitelně) diagnostika
 * Pixi ticker garantuje toto pořadí automaticky. Ticker priority NORMAL = po scene update.
 *
 * DPR handling:
 * Pixi v8 s autoDensity:true používá logické pixely (CSS px) ve všech Container
 * souřadnicích. container.toGlobal() vrací logické pixely — NIKOLI fyzické.
 * Projekční matice rendereru skaluje fyzické rozlišení interně; z pohledu
 * container.toGlobal() / toLocal() je DPR transparentní.
 * CSS translate() také pracuje v logických pixelech → žádná DPR kompenzace není nutná.
 *
 * (Spike C byl psán bez autoDensity a předpokládal fyzické px; od P2 s autoDensity:true
 *  je dělení DPR nesprávné a způsobovalo špatné pozicování na HiDPI displejích.)
 *
 * DPR changes (přesun okna na jiný monitor):
 * Compositor stále sleduje window 'resize' jako proxy — pro případ budoucího použití
 * a pro okamžitý resync pozic po resize.
 *
 * Performance (Spike C C3):
 * 50 overlays × style.transform update = 0.093 ms avg per frame (0.56% frame budget).
 * Compositor záměrně nealokuje objekty per-frame (žádný GC churn):
 * - Point({x,y}) by byl GC churn — místo toho čteme .x/.y přímo z toGlobal() výsledku
 *   reusing single scratch object (viz this._scratch).
 */

import { Point } from 'pixi.js'
import type { Application } from 'pixi.js'
import type { OverlayHandle, OverlayOpts } from './types'
import type { RenderScheduler } from '../RenderScheduler'

/** Interní stav jednoho registrovaného overlay. */
interface OverlayEntry {
  opts: Required<OverlayOpts>
  destroyed: boolean
}

export class OverlayCompositor {
  private readonly app: Application
  private readonly overlayRoot: HTMLElement
  private readonly entries = new Map<symbol, OverlayEntry>()

  /** Scratch Point pro toGlobal() — reuse per-frame, žádný GC churn. */
  private readonly _scratch = new Point(0, 0)

  /** Cached DPR — sledujeme pro resize detection; pozicování DPR nekompenzuje
   *  protože toGlobal() s autoDensity:true vrací logické px (viz komentář výše). */
  private _dpr: number

  /** Postrender hook — replaces the per-tick ticker subscriber under P12b
   *  so overlay sync only runs after Pixi actually drew a frame. */
  private readonly _postRenderFn: () => void

  /** Window resize listener pro DPR change detection. */
  private readonly _resizeFn: () => void

  /**
   * P12b: optional scheduler. When set, mutations that move overlays
   * (registerOverlay, update, destroy) poke the scheduler so a frame
   * is queued — otherwise the new overlay would only sync on the next
   * unrelated render and could appear at stale coords for one frame.
   */
  private scheduler: RenderScheduler | null = null

  /** Cleanup handle returned by `scheduler.onAfterRender(...)`. */
  private unsubscribeAfterRender: (() => void) | null = null

  /**
   * @param app - Pixi Application instance (musí být plně inicializována).
   * @param overlayRoot - DOM element sousedící s <canvas>, uvnitř stejného parent.
   *   Caller musí zajistit: position:absolute; inset:0; pointer-events:none.
   */
  constructor(app: Application, overlayRoot: HTMLElement) {
    this.app = app
    this.overlayRoot = overlayRoot
    this._dpr = window.devicePixelRatio || 1

    this._postRenderFn = () => {
      this._syncAllOverlays()
    }

    this._resizeFn = () => {
      // Přesun okna na jiný monitor — aktualizujeme DPR a okamžitě synchujeme
      const newDpr = window.devicePixelRatio || 1
      if (newDpr !== this._dpr) {
        this._dpr = newDpr
      }
      // Resize doesn't trigger a Pixi render on its own; bounce through
      // the scheduler so the overlay sync runs on the resulting frame.
      this.scheduler?.markDirty()
      this._syncAllOverlays()
    }

    // P12b: subscription hook lands when setRenderScheduler is called.
    window.addEventListener('resize', this._resizeFn)
  }

  /**
   * P12b: install (or replace) the render scheduler. Canvas.tsx wires this
   * up after `app.init()`. Replaces the per-tick ticker subscriber with a
   * post-render hook on the scheduler so overlay positions resync once
   * per painted frame instead of once per rAF.
   */
  setRenderScheduler(scheduler: RenderScheduler | null): void {
    if (this.unsubscribeAfterRender !== null) {
      this.unsubscribeAfterRender()
      this.unsubscribeAfterRender = null
    }
    this.scheduler = scheduler
    if (scheduler !== null) {
      this.unsubscribeAfterRender = scheduler.onAfterRender(this._postRenderFn)
    }
  }

  /**
   * Registruje DOM element jako overlay sledující Pixi Container.
   * Element je přidán do overlayRoot a bude synchronizován každý tick.
   *
   * @returns OverlayHandle pro update/destroy
   */
  registerOverlay(opts: OverlayOpts): OverlayHandle {
    const key = Symbol('overlay')

    // Normalize opts s defaults
    const fullOpts: Required<OverlayOpts> = {
      pixiContainer: opts.pixiContainer,
      domElement: opts.domElement,
      worldOffset: opts.worldOffset ?? { x: 0, y: 0 },
      interactive: opts.interactive ?? false,
      applyContainerTransform: opts.applyContainerTransform ?? false,
    }

    const entry: OverlayEntry = { opts: fullOpts, destroyed: false }
    this.entries.set(key, entry)

    // Setup element styly — pozicování přes transform, ne left/top (lepší GPU compositing)
    const el = fullOpts.domElement
    el.style.position = 'absolute'
    el.style.top = '0'
    el.style.left = '0'
    el.style.pointerEvents = fullOpts.interactive ? 'auto' : 'none'

    this.overlayRoot.appendChild(el)

    // Okamžitá sync (před dalším tickem) — aby nebyl frame s element na (0,0)
    this._syncEntry(entry)
    // P12b: queue a render so subsequent ticks observe the new overlay
    // and so postrender resyncs catch any container the overlay tracks
    // whose transform changes between now and the next frame.
    this.scheduler?.markDirty()

    const handle: OverlayHandle = {
      update: (partial: Partial<OverlayOpts>) => {
        if (entry.destroyed) return
        if (partial.pixiContainer !== undefined) {
          entry.opts.pixiContainer = partial.pixiContainer
        }
        if (partial.domElement !== undefined) {
          // Přesun elementu — odebereme starý, přidáme nový
          if (entry.opts.domElement.parentNode === this.overlayRoot) {
            this.overlayRoot.removeChild(entry.opts.domElement)
          }
          entry.opts.domElement = partial.domElement
          entry.opts.domElement.style.position = 'absolute'
          entry.opts.domElement.style.top = '0'
          entry.opts.domElement.style.left = '0'
          entry.opts.domElement.style.pointerEvents = entry.opts.interactive ? 'auto' : 'none'
          this.overlayRoot.appendChild(entry.opts.domElement)
        }
        if (partial.worldOffset !== undefined) {
          entry.opts.worldOffset = partial.worldOffset
        }
        if (partial.interactive !== undefined) {
          entry.opts.interactive = partial.interactive
          entry.opts.domElement.style.pointerEvents = partial.interactive ? 'auto' : 'none'
        }
        if (partial.applyContainerTransform !== undefined) {
          entry.opts.applyContainerTransform = partial.applyContainerTransform
        }
        // P12b: an `update` is the only signal we get when something like
        // a peer cursor moves to a new worldOffset — sync immediately so
        // it doesn't sit at the old position until the next render, and
        // queue a frame so the scheduler-driven onAfterRender re-checks.
        this._syncEntry(entry)
        this.scheduler?.markDirty()
      },

      setInteractive: (on: boolean) => {
        if (entry.destroyed) return
        entry.opts.interactive = on
        entry.opts.domElement.style.pointerEvents = on ? 'auto' : 'none'
      },

      destroy: () => {
        if (entry.destroyed) return
        entry.destroyed = true
        this.entries.delete(key)
        if (entry.opts.domElement.parentNode === this.overlayRoot) {
          this.overlayRoot.removeChild(entry.opts.domElement)
        }
      },
    }

    return handle
  }

  /**
   * Synchronizuje pozici jednoho overlay entry.
   * Čte toGlobal() pro worldOffset bod — výsledek je rovnou v CSS (logických) px.
   *
   * Reuse _scratch Point — žádný per-frame heap allokace.
   */
  private _syncEntry(entry: OverlayEntry): void {
    if (entry.destroyed) return

    const { pixiContainer, domElement, worldOffset, applyContainerTransform } = entry.opts

    // toGlobal() s worldOffset jako container-local bod → vrátí pozici v logických (CSS) px.
    // Pixi v8 s autoDensity:true má souřadnicový systém v logických pixelech; žádné
    // dělení DPR není nutné. CSS translate() pracuje ve stejných logických px.
    this._scratch.x = worldOffset.x
    this._scratch.y = worldOffset.y

    const global = pixiContainer.toGlobal(this._scratch)

    const cssX = global.x
    const cssY = global.y

    // Přímý CSS transform — no GC, no layout thrash (transform je compositor-only)
    if (applyContainerTransform) {
      // P8: propagate the container's rotation + alpha so a rotated /
      // faded VideoObject reflects on the DOM <video> overlay.
      const rot = pixiContainer.rotation || 0
      const alpha = pixiContainer.alpha
      domElement.style.transform = `translate(${cssX}px, ${cssY}px) rotate(${rot}rad)`
      domElement.style.transformOrigin = '0 0'
      domElement.style.opacity = String(alpha)
    } else {
      domElement.style.transform = `translate(${cssX}px, ${cssY}px)`
    }
  }

  /**
   * Synchronizuje všechny registrované overlays.
   * Voláno z Pixi ticker každý frame.
   * Záměrně žádné Object.entries() ani Array.from() — iterujeme Map přímo.
   */
  private _syncAllOverlays(): void {
    this.entries.forEach((entry) => {
      this._syncEntry(entry)
    })
  }

  /**
   * Uvolní compositor — odstraní ticker subscriber, window listener,
   * všechny overlay elementy z DOM, vyprázdní entries.
   * Volat před app.destroy() při unmount Canvas.
   */
  destroy(): void {
    if (this.unsubscribeAfterRender !== null) {
      this.unsubscribeAfterRender()
      this.unsubscribeAfterRender = null
    }
    window.removeEventListener('resize', this._resizeFn)

    this.entries.forEach((entry) => {
      if (!entry.destroyed && entry.opts.domElement.parentNode === this.overlayRoot) {
        this.overlayRoot.removeChild(entry.opts.domElement)
      }
    })

    this.entries.clear()
  }
}
