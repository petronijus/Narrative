/**
 * renderer/constants.ts
 *
 * Shared renderer constants.
 *
 * M5: SLIDE_WIDTH / SLIDE_HEIGHT definují kanonický "world size" slide plochy
 * v CSS logical pixels (1:1 s Pixi world coords). Použito v PresentLayout
 * pro scale-to-fit výpočet a v editoru jako referenční rozměr.
 *
 * Hodnota 1920×1080 odpovídá 16:9 Full HD — standard pro prezentace.
 * Deck-level aspect ratio override přijde v M20 (themes).
 */

export const SLIDE_WIDTH = 1920
export const SLIDE_HEIGHT = 1080
