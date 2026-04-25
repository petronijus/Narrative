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
 * DPR handling (Spike C nález):
 * container.toGlobal() vrací fyzické pixely (Pixi render space).
 * CSS translate() pracuje v logical pixelech.
 * Formula: cssX = global.x / DPR
 *
 * DPR changes (přesun okna na jiný monitor):
 * Compositor poslouchá window 'resize' event jako proxy pro DPR change detection.
 * Alternativa matchMedia(`(resolution: ${DPR}dppx)`) je přesnější ale složitější.
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

  /** Cached DPR — updatujeme při window resize (monitor přesun). */
  private _dpr: number

  /** Ticker sync funkce — potřebujeme referenci pro remove. */
  private readonly _tickerFn: () => void

  /** Window resize listener pro DPR change detection. */
  private readonly _resizeFn: () => void

  /**
   * @param app - Pixi Application instance (musí být plně inicializována).
   * @param overlayRoot - DOM element sousedící s <canvas>, uvnitř stejného parent.
   *   Caller musí zajistit: position:absolute; inset:0; pointer-events:none.
   */
  constructor(app: Application, overlayRoot: HTMLElement) {
    this.app = app
    this.overlayRoot = overlayRoot
    this._dpr = window.devicePixelRatio || 1

    this._tickerFn = () => {
      this._syncAllOverlays()
    }

    this._resizeFn = () => {
      // Přesun okna na jiný monitor — aktualizujeme DPR a okamžitě synchujeme
      const newDpr = window.devicePixelRatio || 1
      if (newDpr !== this._dpr) {
        this._dpr = newDpr
      }
      // I bez DPR změny mohlo dojít k resize — resync pozic
      this._syncAllOverlays()
    }

    // Ticker na NORMAL priority — po Pixi scene update, před render
    this.app.ticker.add(this._tickerFn)
    window.addEventListener('resize', this._resizeFn)
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
   * Čte toGlobal() pro worldOffset bod a aplikuje DPR kompenzaci.
   *
   * Reuse _scratch Point — žádný per-frame heap allokace.
   */
  private _syncEntry(entry: OverlayEntry): void {
    if (entry.destroyed) return

    const { pixiContainer, domElement, worldOffset, applyContainerTransform } = entry.opts

    // Scratch point s world offset — toGlobal transformuje do Pixi render space (fyzické px)
    this._scratch.x = worldOffset.x
    this._scratch.y = worldOffset.y

    const global = pixiContainer.toGlobal(this._scratch)

    // DPR kompenzace: fyzické px → logical (CSS) px
    const cssX = global.x / this._dpr
    const cssY = global.y / this._dpr

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
    this.app.ticker.remove(this._tickerFn)
    window.removeEventListener('resize', this._resizeFn)

    this.entries.forEach((entry) => {
      if (!entry.destroyed && entry.opts.domElement.parentNode === this.overlayRoot) {
        this.overlayRoot.removeChild(entry.opts.domElement)
      }
    })

    this.entries.clear()
  }
}
