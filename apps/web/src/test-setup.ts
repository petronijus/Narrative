/**
 * test-setup.ts
 *
 * Vitest setup soubor. Spouští se před každým test suite.
 *
 * @testing-library/jest-dom volá expect.extend() při importu.
 * globals:false → expect není globální, musíme ho injektovat ručně.
 *
 * afterEach(cleanup) zajistí, že RTL vyčistí DOM po každém testu —
 * bez toho by se DOM akumuloval napříč testy v jednom souboru.
 */
import { expect, afterEach } from 'vitest'
import * as matchers from '@testing-library/jest-dom/matchers'
import { cleanup } from '@testing-library/react'

expect.extend(matchers)
afterEach(cleanup)

// jsdom doesn't implement HTMLCanvasElement.getContext. Pixi v8.16+
// probes canvas blend modes at import time via `DOMAdapter.get().createCanvas()`
// → `canvas.getContext('2d')`. Without a stub, the null return cascades
// into allocation-heavy fallback paths that OOM the test worker. Provide
// a minimal 2d context mock so Pixi's detection resolves quickly.
if (typeof HTMLCanvasElement !== 'undefined') {
  const _origGetContext = HTMLCanvasElement.prototype.getContext
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const noop = (() => {}) as any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stub2d: any = {
    fillStyle: '',
    fillRect: noop,
    drawImage: noop,
    getImageData: () => ({ data: new Uint8ClampedArray([0, 0, 0, 0]) }),
    globalCompositeOperation: '',
    clearRect: noop,
    canvas: null as unknown,
    save: noop,
    restore: noop,
    scale: noop,
    translate: noop,
    transform: noop,
    setTransform: noop,
    createLinearGradient: () => ({ addColorStop: noop }),
    createRadialGradient: () => ({ addColorStop: noop }),
    createPattern: noop,
    beginPath: noop,
    closePath: noop,
    moveTo: noop,
    lineTo: noop,
    arc: noop,
    arcTo: noop,
    rect: noop,
    fill: noop,
    stroke: noop,
    clip: noop,
    measureText: () => ({ width: 0 }),
    putImageData: noop,
    createImageData: () => ({ data: new Uint8ClampedArray(4) }),
    imageSmoothingEnabled: true,
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(HTMLCanvasElement.prototype as any).getContext = function (
    this: HTMLCanvasElement,
    type: string,
  ) {
    if (type === '2d') {
      stub2d.canvas = this
      return stub2d
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (_origGetContext as any).call(this, type)
  }
}

// jsdom's HTMLImageElement does not implement Image.prototype.decode (a
// browser-only API used by ResourceManager / imageRenderer to wait for an
// img to finish decoding before treating it as a texture source). Tests
// don't actually need decoded pixels — stub it to resolve immediately so
// the await chain proceeds.
if (
  typeof HTMLImageElement !== 'undefined' &&
  !(HTMLImageElement.prototype as { decode?: unknown }).decode
) {
  Object.defineProperty(HTMLImageElement.prototype, 'decode', {
    value: function decode(this: HTMLImageElement): Promise<void> {
      return Promise.resolve()
    },
    configurable: true,
    writable: true,
  })
}
