/**
 * packages/animation/src/inputBridge.ts
 *
 * InputBridge implementace pro browser prostředí.
 *
 * createClickInputBridge — připojí click/tap listener na element.
 * PresentLayout (M6 fáze 2) zavolá:
 *   createClickInputBridge(document.body)
 * aby klik kdekoli v present modu advancoval onClick triggery.
 */

import type { InputBridge } from './types.js'

/**
 * Vytvoří InputBridge napojený na click eventy HTML elementu.
 *
 * POZOR: listener se přidá okamžitě — caller zodpovídá za lifecycle.
 * Zavolej destroy() na AnimationRuntime pro cleanup.
 */
export function createClickInputBridge(element: HTMLElement): InputBridge {
  let currentListener: (() => void) | null = null

  const handler = () => {
    currentListener?.()
  }

  element.addEventListener('click', handler)

  const bridge: InputBridge = {
    onAdvance(cb: () => void): () => void {
      currentListener = cb
      return () => {
        if (currentListener === cb) {
          currentListener = null
        }
      }
    },
  }

  // Přidáme metodu pro uklidění event listeneru
  // Caller (createAnimationRuntime) toto volá z dispose()
  ;(bridge as InputBridge & { _destroy(): void })._destroy = () => {
    element.removeEventListener('click', handler)
    currentListener = null
  }

  return bridge
}

/**
 * Vytvoří InputBridge pro testovací prostředí nebo custom integrace.
 * Caller manuálně volá `trigger()` k simulaci user advance.
 */
export function createManualInputBridge(): InputBridge & { trigger(): void } {
  let currentListener: (() => void) | null = null

  return {
    onAdvance(cb: () => void): () => void {
      currentListener = cb
      return () => {
        if (currentListener === cb) {
          currentListener = null
        }
      }
    },
    trigger(): void {
      currentListener?.()
    },
  }
}
