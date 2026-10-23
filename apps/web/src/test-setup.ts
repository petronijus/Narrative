/**
 * test-setup.ts
 *
 * The web suite's setup file: runs before every test file, in whichever
 * environment the file runs (jsdom by default, node where the file says
 * `// @vitest-environment node`; docs/testing-strategy.md → Choosing a
 * test environment).
 *
 * With a DOM: the jest-dom matchers (globals: false, so `expect` is
 * extended by hand) and Testing Library's cleanup after every test — without
 * it, rendered trees would pile up across the tests of a file. Without a DOM
 * neither has anything to act on, and loading them (react-dom with them)
 * would cost every node-environment file their import, so they are only
 * imported where `document` exists.
 */
import { expect, afterEach } from 'vitest'

if (typeof document !== 'undefined') {
  const [jestDom, { cleanup }] = await Promise.all([
    import('@testing-library/jest-dom/matchers'),
    import('@testing-library/react'),
  ])
  // A dynamic import's namespace also carries `default`, which is not a matcher.
  const { default: _namespaceDefault, ...matchers } = jestDom
  expect.extend(matchers)
  afterEach(cleanup)
}

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
