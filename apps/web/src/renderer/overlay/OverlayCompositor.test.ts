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

// Mock pixi.js
vi.mock('pixi.js', () => {
  class MockPoint {
    x: number
    y: number
    constructor(x = 0, y = 0) {
      this.x = x
      this.y = y
    }
  }

  class MockContainer {
    x = 0
    y = 0
    destroyed = false
    children: MockContainer[] = []
    pivot = { set: vi.fn() }

    addChild(child: MockContainer): MockContainer {
      this.children.push(child)
      return child
    }

    removeChild(child: MockContainer): MockContainer {
      this.children = this.children.filter((c) => c !== child)
      return child
    }

    destroy(): void {
      this.destroyed = true
    }

    // Simuluje toGlobal: vrátí offset od container.x/y v "fyzických" pixelech
    toGlobal(point: MockPoint): MockPoint {
      return new MockPoint(this.x + point.x, this.y + point.y)
    }
  }

  return {
    Container: MockContainer,
    Graphics: vi.fn(),
    Text: vi.fn(),
    TextStyle: vi.fn(),
    Point: MockPoint,
    Application: vi.fn(),
  }
})

import { OverlayCompositor } from './OverlayCompositor'
import { Container } from 'pixi.js'
import type { Application } from 'pixi.js'

/** Výsledek makeApp() — app + tick helper oddělené pro čistý typing */
interface MockApp {
  app: Application
  /** Spustí všechny registrované ticker funkce */
  tick: () => void
  /** Mock spies pro asserce */
  tickerAdd: ReturnType<typeof vi.fn>
  tickerRemove: ReturnType<typeof vi.fn>
}

/** Helper: vytvoří mock Pixi Application s ticker */
function makeApp(): MockApp {
  const tickerFns: Array<() => void> = []
  const tickerAdd = vi.fn((fn: () => void) => {
    tickerFns.push(fn)
  })
  const tickerRemove = vi.fn((fn: () => void) => {
    const idx = tickerFns.indexOf(fn)
    if (idx !== -1) tickerFns.splice(idx, 1)
  })

  const ticker = { add: tickerAdd, remove: tickerRemove }
  const app = { ticker } as unknown as Application

  return {
    app,
    tick: () => tickerFns.forEach((fn) => fn()),
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
  })

  afterEach(() => {
    // Cleanup DOM
    compositor.destroy()
    if (overlayRoot.parentNode) {
      document.body.removeChild(overlayRoot)
    }
  })

  describe('constructor', () => {
    it('registruje ticker subscriber', () => {
      expect(mockApp.tickerAdd).toHaveBeenCalledTimes(1)
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

    it('DPR kompenzace: fyzické px / DPR = CSS logical px', () => {
      // Nastavíme DPR=2 — container.toGlobal vrací fyzické px
      Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 2 })
      const mockApp2 = makeApp()
      const overlayRoot2 = makeOverlayRoot()
      const compositor2 = new OverlayCompositor(mockApp2.app, overlayRoot2)

      const domEl = makeDomEl()
      // Container fyzická pozice = 200px
      const container = makeContainer(200, 400)

      compositor2.registerOverlay({ pixiContainer: container, domElement: domEl })

      // CSS = 200/2 = 100px, 400/2 = 200px
      expect(domEl.style.transform).toBe('translate(100px, 200px)')

      compositor2.destroy()
      document.body.removeChild(overlayRoot2)
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
    it('odebere ticker subscriber', () => {
      compositor.destroy()
      expect(mockApp.tickerRemove).toHaveBeenCalledTimes(1)
      // Prevent double destroy v afterEach
      compositor = new OverlayCompositor(mockApp.app, overlayRoot)
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
