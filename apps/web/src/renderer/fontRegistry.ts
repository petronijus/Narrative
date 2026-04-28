/**
 * renderer/fontRegistry.ts
 *
 * P15: tiny, framework-agnostic registry of font families that have
 * finished loading via the FontLoader. Sits in the renderer layer so
 * Pixi-side code (textRenderer) can subscribe without importing
 * React. The FontLoader (state/) calls notifyFontReady when a face
 * finishes loading.
 */

const READY_FAMILIES = new Set<string>()
const READY_LISTENERS = new Set<(family: string) => void>()

/** True iff the given family has finished loading in this session. */
export function isFontReady(family: string): boolean {
  return READY_FAMILIES.has(family)
}

/**
 * Subscribe to "font ready" notifications. Replays already-loaded
 * families to the new subscriber so a late mount catches up. Returns
 * an unsubscribe function.
 */
export function onFontReady(listener: (family: string) => void): () => void {
  READY_LISTENERS.add(listener)
  for (const fam of READY_FAMILIES) listener(fam)
  return () => {
    READY_LISTENERS.delete(listener)
  }
}

/** Called by FontLoader once `face.load()` resolves. */
export function notifyFontReady(family: string): void {
  READY_FAMILIES.add(family)
  for (const fn of READY_LISTENERS) {
    try {
      fn(family)
    } catch (err) {
      console.warn('[fontRegistry] listener threw', err)
    }
  }
}

/** Called by FontLoader when a font is removed and no other entry covers it. */
export function forgetFontReady(family: string): void {
  READY_FAMILIES.delete(family)
}

/** @internal — for tests. */
export function _resetFontRegistry(): void {
  READY_FAMILIES.clear()
  READY_LISTENERS.clear()
}
