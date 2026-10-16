/**
 * renderer/overlay/OverlayCompositor.test.ts
 *
 * Unit testy pro OverlayCompositor.
 *
 * Pixi.js je mockován — testy běží v Node/jsdom bez GPU.
 * Container.toGlobal() je mockován aby vrátil testovatelné souřadnice.
 *
 * Testujeme:
 * - registerOverlay: vrátí handle, přidá element do overlayRoot
 * - handle.update: aktualizuje opts (interactive, worldOffset, pixiContainer)
 * - handle.setInteractive: přepne pointer-events
 * - handle.destroy: odstraní element z DOM, maže z entries
 * - compositor.destroy: cleanup ticker + window listener + všechny elementy
 * - DPR kompenzace: CSS transform odpovídá global / DPR
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { pixiMock } from '../../test/pixiMock'

// Mock pixi.js
vi.mock('pixi.js', () => pixiMock())

import { OverlayCompositor } from './OverlayCompositor'
import { Container } from 'pixi.js'
import type { Application } from 'pixi.js'

/**
 * Výsledek makeApp() — app + tick helper oddělené pro čistý typing.
 *
 * P12b: OverlayCompositor no longer subscribes to the Pixi ticker — it
 * subscribes to the RenderScheduler's `onAfterRender` instead. To keep
 * the test surface stable, the mock app exposes a fake scheduler whose
 * `fire()` call mimics what the real scheduler does after each render
 * (invoke every `onAfterRender` subscriber). `tick()` is preserved as
 * an alias for `scheduler.fire()` so existing tests continue to read
 * naturally.
 */
interface MockScheduler {
  markDirty: ReturnType<typeof vi.fn>
  onAfterRender: ReturnType<typeof vi.fn>
  fire: () => void
  /** spy that resolves when `OverlayCompositor.destroy` removes its sub. */
  unsubscribed: { count: number }
}

interface MockApp {
  app: Application
  /** Spustí všechny registrované sync funkce — alias pro scheduler.fire(). */
  tick: () => void
  scheduler: MockScheduler & { _wire: (compositor: OverlayCompositor) => void }
  /** Mock spies pro asserce — kompatibilita s před-P12b testy. */
  tickerAdd: ReturnType<typeof vi.fn>
  tickerRemove: ReturnType<typeof vi.fn>
}

/** Helper: vytvoří mock Pixi Application + fake render scheduler. */
function makeApp(): MockApp {
  const subs: Array<() => void> = []
  const unsubscribed = { count: 0 }

  const onAfterRender = vi.fn((fn: () => void) => {
    subs.push(fn)
    return () => {
      const idx = subs.indexOf(fn)
      if (idx !== -1) subs.splice(idx, 1)
      unsubscribed.count++
    }
  })

  const markDirty = vi.fn()

  const fire = (): void => {
    for (const fn of subs.slice()) fn()
  }

  const scheduler: MockScheduler & { _wire: (compositor: OverlayCompositor) => void } = {
    markDirty,
    onAfterRender,
    fire,
    unsubscribed,
    _wire: (compositor: OverlayCompositor) => {
      // Cast to the real scheduler shape — we only implement the methods
      // OverlayCompositor calls.
      compositor.setRenderScheduler(
        scheduler as unknown as Parameters<OverlayCompositor['setRenderScheduler']>[0],
      )
    },
  }

  // Ticker stub: kept around so `app.ticker` exists if any code path on
  // the production side still touches it (none after P12b, but safe).
  const tickerAdd = vi.fn()
  const tickerRemove = vi.fn()
  const ticker = { add: tickerAdd, remove: tickerRemove }
  const renderer = { render: vi.fn(), on: vi.fn(), off: vi.fn() }
  const app = { ticker, renderer } as unknown as Application

  return {
    app,
    scheduler,
    tick: fire,
    tickerAdd,
    tickerRemove,
  }
}

/** Helper: vytvoří overlayRoot div připojený do document.body */
function makeOverlayRoot(): HTMLDivElement {
  const el = document.createElement('div')
  document.body.appendChild(el)
  return el
}

/** Helper: vytvoří DOM element pro overlay */
function makeDomEl(): HTMLDivElement {
  return document.createElement('div')
}

/** Helper: nastaví container.x, y jako fyzické px pro toGlobal */
function makeContainer(x: number, y: number): InstanceType<typeof Container> {
  const c = new Container() as InstanceType<typeof Container>
  c.x = x
  c.y = y
  return c
}

describe('OverlayCompositor', () => {
  let mockApp: MockApp
  let overlayRoot: HTMLDivElement
  let compositor: OverlayCompositor

  beforeEach(() => {
    // Mock window.devicePixelRatio
    Object.defineProperty(window, 'devicePixelRatio', {
      configurable: true,
      value: 1,
    })

    mockApp = makeApp()
    overlayRoot = makeOverlayRoot()
    compositor = new OverlayCompositor(mockApp.app, overlayRoot)
    mockApp.scheduler._wire(compositor)
  })

  afterEach(() => {
    // Cleanup DOM
    compositor.destroy()
    if (overlayRoot.parentNode) {
      document.body.removeChild(overlayRoot)
    }
  })

  describe('constructor', () => {
    it('subscribes to scheduler.onAfterRender once setRenderScheduler is called', () => {
      // P12b: ticker subscription replaced by scheduler hook.
      expect(mockApp.scheduler.onAfterRender).toHaveBeenCalledTimes(1)
    })

    it('registruje window resize listener', () => {
      // Ověříme přes window.removeEventListener spy při destroy
      const removeSpy = vi.spyOn(window, 'removeEventListener')
      compositor.destroy()
      expect(removeSpy).toHaveBeenCalledWith('resize', expect.any(Function))
      // Prevent double destroy v afterEach
      compositor = new OverlayCompositor(mockApp.app, overlayRoot)
    })
  })

  describe('registerOverlay()', () => {
    it('vrátí OverlayHandle s metodami update, setInteractive, destroy', () => {
      const domEl = makeDomEl()
      const container = makeContainer(0, 0)

      const handle = compositor.registerOverlay({ pixiContainer: container, domElement: domEl })

      expect(handle).toHaveProperty('update')
      expect(handle).toHaveProperty('setInteractive')
      expect(handle).toHaveProperty('destroy')
    })

    it('přidá domElement do overlayRoot', () => {
      const domEl = makeDomEl()
      const container = makeContainer(0, 0)

      compositor.registerOverlay({ pixiContainer: container, domElement: domEl })

      expect(overlayRoot.contains(domEl)).toBe(true)
    })

    it('nastaví domElement na position:absolute', () => {
      const domEl = makeDomEl()
      const container = makeContainer(0, 0)

      compositor.registerOverlay({ pixiContainer: container, domElement: domEl })

      expect(domEl.style.position).toBe('absolute')
    })

    it('default: pointer-events none (non-interactive)', () => {
      const domEl = makeDomEl()
      const container = makeContainer(0, 0)

      compositor.registerOverlay({ pixiContainer: container, domElement: domEl })

      expect(domEl.style.pointerEvents).toBe('none')
    })

    it('interactive:true → pointer-events auto', () => {
      const domEl = makeDomEl()
      const container = makeContainer(0, 0)

      compositor.registerOverlay({ pixiContainer: container, domElement: domEl, interactive: true })

      expect(domEl.style.pointerEvents).toBe('auto')
    })

    it('aplikuje CSS transform okamžitě po registraci (pre-tick sync)', () => {
      const domEl = makeDomEl()
      const container = makeContainer(100, 200)

      compositor.registerOverlay({ pixiContainer: container, domElement: domEl })

      // DPR=1, container.x=100, y=200, worldOffset=(0,0) → cssX=100, cssY=200
      expect(domEl.style.transform).toBe('translate(100px, 200px)')
    })
  })

  describe('ticker sync', () => {
    it('sync při ticker tick přepočítá transform', () => {
      const domEl = makeDomEl()
      const container = makeContainer(50, 75)

      compositor.registerOverlay({ pixiContainer: container, domElement: domEl })

      // Změníme pozici containeru a spustíme tick
      container.x = 200
      container.y = 300
      mockApp.tick()

      expect(domEl.style.transform).toBe('translate(200px, 300px)')
    })

    it('on a HiDPI screen the position is not divided by devicePixelRatio', () => {
      // toGlobal() with autoDensity already answers in CSS (logical) px, so the
      // transform takes it as is. Dividing by the DPR, as the compositor once
      // did, put every overlay at half its position on a 2x screen.
      const original = Object.getOwnPropertyDescriptor(window, 'devicePixelRatio')
      Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 2 })
      try {
        const mockApp2 = makeApp()
        const overlayRoot2 = makeOverlayRoot()
        const compositor2 = new OverlayCompositor(mockApp2.app, overlayRoot2)
        const domEl = makeDomEl()

        compositor2.registerOverlay({ pixiContainer: makeContainer(200, 400), domElement: domEl })

        expect(domEl.style.transform).toBe('translate(200px, 400px)')
        compositor2.destroy()
        document.body.removeChild(overlayRoot2)
      } finally {
        if (original) Object.defineProperty(window, 'devicePixelRatio', original)
        else delete (window as { devicePixelRatio?: number }).devicePixelRatio
      }
    })

    it('worldOffset je přidán k container souřadnicím', () => {
      const domEl = makeDomEl()
      const container = makeContainer(100, 100)

      compositor.registerOverlay({
        pixiContainer: container,
        domElement: domEl,
        worldOffset: { x: 10, y: 20 },
      })

      // toGlobal({x:10, y:20}) → {x: 100+10, y: 100+20} = {110, 120}
      expect(domEl.style.transform).toBe('translate(110px, 120px)')
    })
  })

  describe('handle.update()', () => {
    it('update interactive přepne pointer-events', () => {
      const domEl = makeDomEl()
      const container = makeContainer(0, 0)
      const handle = compositor.registerOverlay({ pixiContainer: container, domElement: domEl })

      handle.update({ interactive: true })
      expect(domEl.style.pointerEvents).toBe('auto')

      handle.update({ interactive: false })
      expect(domEl.style.pointerEvents).toBe('none')
    })

    it('update worldOffset změní pozici po dalším ticku', () => {
      const domEl = makeDomEl()
      const container = makeContainer(50, 50)
      const handle = compositor.registerOverlay({ pixiContainer: container, domElement: domEl })

      handle.update({ worldOffset: { x: 30, y: 40 } })
      mockApp.tick()

      // toGlobal({x:30, y:40}) → {50+30, 50+40} = {80, 90}
      expect(domEl.style.transform).toBe('translate(80px, 90px)')
    })

    it('update pixiContainer změní sledovaný container', () => {
      const domEl = makeDomEl()
      const container1 = makeContainer(10, 20)
      const container2 = makeContainer(300, 400)
      const handle = compositor.registerOverlay({ pixiContainer: container1, domElement: domEl })

      handle.update({ pixiContainer: container2 })
      mockApp.tick()

      expect(domEl.style.transform).toBe('translate(300px, 400px)')
    })

    it('update po destroy je no-op', () => {
      const domEl = makeDomEl()
      const container = makeContainer(0, 0)
      const handle = compositor.registerOverlay({ pixiContainer: container, domElement: domEl })

      handle.destroy()
      // Nesmí hodit error
      expect(() => handle.update({ interactive: true })).not.toThrow()
    })
  })

  describe('handle.setInteractive()', () => {
    it('true → pointer-events auto', () => {
      const domEl = makeDomEl()
      const container = makeContainer(0, 0)
      const handle = compositor.registerOverlay({ pixiContainer: container, domElement: domEl })

      handle.setInteractive(true)
      expect(domEl.style.pointerEvents).toBe('auto')
    })

    it('false → pointer-events none', () => {
      const domEl = makeDomEl()
      const container = makeContainer(0, 0)
      const handle = compositor.registerOverlay({
        pixiContainer: container,
        domElement: domEl,
        interactive: true,
      })

      handle.setInteractive(false)
      expect(domEl.style.pointerEvents).toBe('none')
    })

    it('setInteractive po destroy je no-op', () => {
      const domEl = makeDomEl()
      const container = makeContainer(0, 0)
      const handle = compositor.registerOverlay({ pixiContainer: container, domElement: domEl })

      handle.destroy()
      expect(() => handle.setInteractive(true)).not.toThrow()
    })
  })

  describe('handle.destroy()', () => {
    it('odstraní domElement z overlayRoot', () => {
      const domEl = makeDomEl()
      const container = makeContainer(0, 0)
      const handle = compositor.registerOverlay({ pixiContainer: container, domElement: domEl })

      expect(overlayRoot.contains(domEl)).toBe(true)
      handle.destroy()
      expect(overlayRoot.contains(domEl)).toBe(false)
    })

    it('po destroy element není synchován v ticker', () => {
      const domEl = makeDomEl()
      const container = makeContainer(50, 50)
      const handle = compositor.registerOverlay({ pixiContainer: container, domElement: domEl })

      handle.destroy()
      const transformBefore = domEl.style.transform

      container.x = 999
      container.y = 999
      mockApp.tick()

      // Transform se nesmí změnit — handle je destroyed
      expect(domEl.style.transform).toBe(transformBefore)
    })

    it('dvojité destroy je no-op', () => {
      const domEl = makeDomEl()
      const container = makeContainer(0, 0)
      const handle = compositor.registerOverlay({ pixiContainer: container, domElement: domEl })

      handle.destroy()
      expect(() => handle.destroy()).not.toThrow()
    })
  })

  describe('compositor.destroy()', () => {
    it('unsubscribes from scheduler', () => {
      compositor.destroy()
      expect(mockApp.scheduler.unsubscribed.count).toBe(1)
      // Prevent double destroy v afterEach
      compositor = new OverlayCompositor(mockApp.app, overlayRoot)
      mockApp.scheduler._wire(compositor)
    })

    it('odstraní všechny overlay elementy z DOM', () => {
      const el1 = makeDomEl()
      const el2 = makeDomEl()
      const container = makeContainer(0, 0)

      compositor.registerOverlay({ pixiContainer: container, domElement: el1 })
      compositor.registerOverlay({ pixiContainer: container, domElement: el2 })

      compositor.destroy()

      expect(overlayRoot.contains(el1)).toBe(false)
      expect(overlayRoot.contains(el2)).toBe(false)

      // Prevent double destroy v afterEach
      compositor = new OverlayCompositor(mockApp.app, overlayRoot)
    })

    it('více overlayů — každý je synchován per tick', () => {
      const el1 = makeDomEl()
      const el2 = makeDomEl()
      const c1 = makeContainer(10, 20)
      const c2 = makeContainer(300, 400)

      compositor.registerOverlay({ pixiContainer: c1, domElement: el1 })
      compositor.registerOverlay({ pixiContainer: c2, domElement: el2 })

      mockApp.tick()

      expect(el1.style.transform).toBe('translate(10px, 20px)')
      expect(el2.style.transform).toBe('translate(300px, 400px)')
    })
  })
})
