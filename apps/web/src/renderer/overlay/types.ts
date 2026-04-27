/**
 * renderer/overlay/types.ts
 *
 * Typy pro OverlayCompositor — DOM overlay nad Pixi canvasem.
 *
 * DPR: Pixi v8 s autoDensity:true používá logické pixely ve všech container
 * souřadnicích. container.toGlobal() vrací logické (CSS) px — DPR se nekompenzuje.
 */

import type { Container } from 'pixi.js'

/**
 * Konfigurace registrace overlay elementu.
 */
export interface OverlayOpts {
  /**
   * Pixi Container jehož world pozice určuje anchor overlay elementu.
   * OverlayCompositor každý tick volá container.toGlobal(worldOffset) pro sync.
   */
  pixiContainer: Container

  /**
   * DOM element co se umístí nad canvas.
   * Caller vytvoří a vlastní element — compositor jej jen pozicuje.
   * Element musí být HTMLElement (ne SVGElement), compositor jej přidá do overlayRoot.
   */
  domElement: HTMLElement

  /**
   * World-space offset vůči container.position pro anchor bodu.
   * Default: { x: 0, y: 0 } — levý horní roh container.
   */
  worldOffset?: { x: number; y: number }

  /**
   * Zda je overlay interaktivní (pointer-events: auto).
   * Default: false — pointer eventy propadají na Pixi canvas.
   */
  interactive?: boolean

  /**
   * P8: when true, the compositor also propagates the Pixi container's
   * `rotation` and `alpha` onto the DOM element (CSS rotate + opacity).
   * Default: false — only the translate is synced (legacy behaviour
   * relied on by editor-mode chrome that shouldn't rotate with the
   * underlying object).
   *
   * Used by the present-mode video overlay so a rotated / faded video
   * object on a slide actually renders rotated / faded in DOM.
   */
  applyContainerTransform?: boolean
}

/**
 * Handle vrácený z registerOverlay().
 * Caller jej drží pro update/destroy.
 */
export interface OverlayHandle {
  /**
   * Aktualizuje konfiguraci overlay.
   * Partial update — neuvedené fieldy zůstávají.
   */
  update(opts: Partial<OverlayOpts>): void

  /**
   * Přepne pointer-events na overlay elementu.
   * Ekvivalent update({ interactive: on }) — jako shortcut pro časté přepínání.
   */
  setInteractive(on: boolean): void

  /**
   * Odstraní overlay — DOM element je odebrán z overlayRoot, ticker sync zastaven.
   * Po destroy() je handle neplatný, nevolej žádné metody.
   */
  destroy(): void
}
