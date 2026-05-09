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
