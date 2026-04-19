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
