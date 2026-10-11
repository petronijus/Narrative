/**
 * state/useShortcuts.ts
 *
 * P9: Centralised keyboard shortcut registry.
 *
 * Architecture
 * ─────────────
 * A single `document.keydown` listener (installed lazily on first mount,
 * removed when the last consumer unmounts) dispatches to all currently-
 * registered handlers. Registration/unregistration is handled by the
 * `useShortcuts` hook — mount → register, unmount → unregister.
 *
 * Scope detection
 * ───────────────
 * Each binding declares a `scope`:
 *   'global'      — fires from anywhere (unless an input/textarea/
 *                   contenteditable has focus).
 *   'canvas'      — fires only when the event target is inside an element
 *                   with `data-shortcut-scope="canvas"`.
 *   'slidePanel'  — fires only inside `data-shortcut-scope="slidePanel"`.
 *   'timeline'    — fires only inside `data-shortcut-scope="timeline"`.
 *
 * Key format
 * ──────────
 * Keys follow the pattern  [Mod+][Ctrl+][Alt+][Shift+]<key>
 *   • `Mod`   → ⌘ on macOS, Ctrl elsewhere (navigator.platform detection).
 *   • `<key>` → the KeyboardEvent.key value (case-insensitive for letters).
 * Examples:  'Delete'  'Mod+z'  'Mod+Shift+z'  'Mod+/'  'ArrowLeft'
 *
 * Stable-ref pattern
 * ──────────────────
 * Handlers close over the latest React state via a ref updated on every
 * render. This means the document listener is installed once per
 * registration (not re-installed on every state change), avoiding the
 * subtle bug where the old closure captures stale state.
 *
 * Cheatsheet
 * ──────────
 * A stable read-only snapshot of all currently-registered bindings is
 * exposed via `getRegisteredShortcuts()` — used by ShortcutsCheatsheet to
 * enumerate shortcuts at render time without subscribing to a store.
 */

import { useEffect, useRef, type MutableRefObject } from 'react'
import type { ActionId } from '../actions/catalog.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ShortcutScope = 'global' | 'canvas' | 'slidePanel' | 'timeline'

export interface ShortcutBinding {
  /** Key combo string or array of alternatives, e.g. 'Mod+z' or ['Delete', 'Backspace'] */
  keys: string | string[]
  scope: ShortcutScope
  handler: (e: KeyboardEvent) => void
  /** Human-readable description for the cheatsheet. */
  description?: string
  /**
   * What the shortcut does, from the action catalog (actions/catalog.ts):
   * the commands an agent reaches the same outcome with, or why it is an
   * editor-only action.
   */
  action: ActionId
  /** Call e.preventDefault() when this binding fires. Default: false. */
  preventDefault?: boolean
  /**
   * Optional gate. When provided and returning false, the binding is
   * skipped — `preventDefault` is NOT applied and (for sticky pointer
   * scopes) the scope chain falls through to the next scope. Use this
   * when a scoped shortcut should yield to a fallback scope under some
   * runtime condition (e.g. slide-panel Mod+V yielding to canvas paste
   * when the slide clipboard is empty).
   */
  canHandle?: () => boolean
}

interface ParsedKey {
  mod: boolean // Cmd on macOS, Ctrl elsewhere
  ctrl: boolean
  alt: boolean
  shift: boolean
  key: string // normalised to lower-case for letter keys
}

interface RegisteredShortcut {
  id: string
  bindings: ShortcutBinding
  /** Stable ref to the latest handler — updated by useShortcuts on every render. */
  handlerRef: MutableRefObject<(e: KeyboardEvent) => void>
  parsedKeys: ParsedKey[]
  scope: ShortcutScope
  description: string | undefined
}

// ---------------------------------------------------------------------------
// Platform detection
// ---------------------------------------------------------------------------

const IS_MAC =
  typeof navigator !== 'undefined' &&
  (/Mac|iPhone|iPad|iPod/.test(navigator.platform) ||
    (navigator.userAgent !== undefined && /Mac/.test(navigator.userAgent)))

/** Whether the platform's `Mod` key (⌘ on macOS, Ctrl elsewhere) is down. */
export function isModHeld(e: { readonly ctrlKey: boolean; readonly metaKey: boolean }): boolean {
  return IS_MAC ? e.metaKey : e.ctrlKey
}

// ---------------------------------------------------------------------------
// Global registry
// ---------------------------------------------------------------------------

/** All currently-registered shortcuts, keyed by a stable id. */
const registry = new Map<string, RegisteredShortcut>()

let listenerInstalled = false
let idCounter = 0

/**
 * Last scope the user interacted with via pointer (mousedown / pointerdown).
 * Browser focus is unreliable here — clicking a slide thumbnail or a canvas
 * object doesn't necessarily move document.activeElement into the scoped
 * container (Pixi canvas isn't focusable, custom thumbnails don't tabindex).
 * We instead track a "sticky" pointer-based active scope that wins when the
 * keydown's event.target has no scope ancestor.
 */
let pointerActiveScope: string | null = null

function handlePointerDown(e: PointerEvent | MouseEvent): void {
  const scope = detectScope(e.target)
  if (scope !== null) pointerActiveScope = scope
}

function nextId(): string {
  idCounter += 1
  return `sc-${idCounter}`
}

// ---------------------------------------------------------------------------
// Key parsing
// ---------------------------------------------------------------------------

function parseKey(combo: string): ParsedKey {
  // Special-case combos whose key character IS '+'. Naive
  // `combo.split('+')` mangles them into empty strings — `'+'` →
  // `['', '']`, `'Mod++'` → `['Mod', '', '']`. Detect the standalone
  // or trailing literal plus before the modifier-split.
  let mod = false
  let ctrl = false
  let alt = false
  let shift = false
  let key = ''

  if (combo === '+' || combo.endsWith('++')) {
    key = '+'
    const prefix = combo.endsWith('++') ? combo.slice(0, -2) : ''
    if (prefix.length > 0) {
      for (const part of prefix.split('+')) {
        if (part === 'Mod') mod = true
        else if (part === 'Ctrl') ctrl = true
        else if (part === 'Alt') alt = true
        else if (part === 'Shift') shift = true
      }
    }
    return { mod, ctrl, alt, shift, key }
  }

  const parts = combo.split('+')

  for (const part of parts) {
    switch (part) {
      case 'Mod':
        mod = true
        break
      case 'Ctrl':
        ctrl = true
        break
      case 'Alt':
        alt = true
        break
      case 'Shift':
        shift = true
        break
      default:
        key = part
    }
  }

  // Normalise single-character keys to lower-case so 'z' matches 'Z'.
  if (key.length === 1) key = key.toLowerCase()

  return { mod, ctrl, alt, shift, key }
}

function parseKeys(keys: string | string[]): ParsedKey[] {
  const arr = Array.isArray(keys) ? keys : [keys]
  return arr.map(parseKey)
}

// ---------------------------------------------------------------------------
// Event matching
// ---------------------------------------------------------------------------

function modMatches(parsed: ParsedKey, e: KeyboardEvent): boolean {
  // `Mod` expands to metaKey on macOS, ctrlKey elsewhere.
  const modHeld = isModHeld(e)
  if (parsed.mod && !modHeld) return false
  if (!parsed.mod && parsed.ctrl && !e.ctrlKey) return false
  // If Mod is set we already checked mod — don't double-require ctrlKey on macOS.
  if (!parsed.mod && !parsed.ctrl && modHeld) return false

  if (parsed.alt !== e.altKey) return false
  if (parsed.shift !== e.shiftKey) {
    // A bare single-letter binding tolerates a held Shift: Shift+R is still
    // "R", and no binding in the registry distinguishes the two (every Shift
    // combo also carries Mod). Requiring an exact match meant tools could not
    // be armed while Shift was down — including mid-gesture, where Shift is
    // the constrain-proportions modifier.
    const bareLetter =
      parsed.key.length === 1 && !parsed.mod && !parsed.ctrl && !parsed.alt && !parsed.shift
    if (!(bareLetter && e.shiftKey)) return false
  }
  return true
}

function keyMatches(parsed: ParsedKey, e: KeyboardEvent): boolean {
  if (!modMatches(parsed, e)) return false
  const evKey = e.key.length === 1 ? e.key.toLowerCase() : e.key
  return evKey === parsed.key
}

function eventMatchesParsed(parsedKeys: ParsedKey[], e: KeyboardEvent): boolean {
  return parsedKeys.some((pk) => keyMatches(pk, e))
}

// ---------------------------------------------------------------------------
// Scope detection
// ---------------------------------------------------------------------------

/** Returns the data-shortcut-scope value of the innermost scoped ancestor of `el`. */
function detectScope(el: EventTarget | null): string | null {
  if (!(el instanceof Element)) return null
  const scoped = el.closest('[data-shortcut-scope]')
  if (scoped === null) return null
  return scoped.getAttribute('data-shortcut-scope')
}

function isInputElement(el: EventTarget | null): boolean {
  if (!(el instanceof Element)) return false
  const tag = (el as HTMLElement).tagName?.toLowerCase()
  return tag === 'input' || tag === 'textarea' || (el as HTMLElement).isContentEditable === true
}

// ---------------------------------------------------------------------------
// Global document listener
// ---------------------------------------------------------------------------

/**
 * The scopes a key on `target` tries, in order, for non-global bindings.
 *
 * When the target has no `data-shortcut-scope` ancestor (typical case:
 * focus on <body> after the user clicked the canvas to select an object —
 * Pixi canvas isn't focusable, so focus stays on body) canvas is the ambient
 * default; otherwise arrow-key nudge / Delete would silently no-op.
 * slidePanel + timeline still require explicit focus inside their scope
 * containers — they don't claim ambient input.
 *   1. Explicit DOM scope (target inside data-shortcut-scope) → only that scope.
 *   2. Sticky pointer scope (e.g. slidePanel after a thumbnail click) →
 *      try that scope first, then fall through to canvas. This lets
 *      e.g. Mod+V paste objects on canvas when the slide-panel binding
 *      opts out via canHandle (no slide clipboard).
 *   3. Otherwise, canvas as ambient default.
 * Inputs always block scoped bindings — let the user type.
 */
function scopeChainFor(target: EventTarget | null): string[] {
  if (isInputElement(target)) return []
  const rawScope = detectScope(target)
  if (rawScope !== null) return [rawScope]
  if (pointerActiveScope !== null && pointerActiveScope !== 'canvas') {
    return [pointerActiveScope, 'canvas']
  }
  return ['canvas']
}

/** Key events a binding handled (`runChord` reports them, prevented or not). */
const handledEvents = new WeakSet<KeyboardEvent>()

function handleKeyDown(e: KeyboardEvent): void {
  const inputFocused = isInputElement(e.target)
  const scopeChain = scopeChainFor(e.target)

  let scopedFired = false
  for (const tryScope of scopeChain) {
    for (const entry of registry.values()) {
      const { scope, parsedKeys, handlerRef, bindings } = entry
      if (scope === 'global') continue
      if (scope !== tryScope) continue
      if (!eventMatchesParsed(parsedKeys, e)) continue
      if (bindings.canHandle !== undefined && !bindings.canHandle()) continue
      if (bindings.preventDefault === true) e.preventDefault()
      handlerRef.current(e)
      handledEvents.add(e)
      scopedFired = true
    }
    if (scopedFired) break
  }

  if (inputFocused) return
  for (const entry of registry.values()) {
    const { scope, parsedKeys, handlerRef, bindings } = entry
    if (scope !== 'global') continue
    if (!eventMatchesParsed(parsedKeys, e)) continue
    if (bindings.canHandle !== undefined && !bindings.canHandle()) continue
    if (bindings.preventDefault === true) e.preventDefault()
    handlerRef.current(e)
    handledEvents.add(e)
  }
}

// ---------------------------------------------------------------------------
// Running a shortcut without its key (the desktop app's menu)
// ---------------------------------------------------------------------------

/**
 * The keydown init of an Electron accelerator (`CmdOrCtrl+Z`,
 * `Shift+CmdOrCtrl+G`, `Delete`, `=`), with `CmdOrCtrl` as this platform's
 * Mod key. Null for a chord this editor's keys cannot express.
 */
export function chordToInit(accelerator: string): KeyboardEventInit | null {
  const parts = accelerator.split('+')
  const key = parts.pop()
  if (key === undefined || key === '') return null
  const init: KeyboardEventInit = { key: key.length === 1 ? key.toLowerCase() : key }
  for (const part of parts) {
    if (part === 'CmdOrCtrl' || part === 'CommandOrControl') {
      if (IS_MAC) init.metaKey = true
      else init.ctrlKey = true
    } else if (part === 'Shift') init.shiftKey = true
    else if (part === 'Alt' || part === 'Option') init.altKey = true
    else if (part === 'Ctrl' || part === 'Control') init.ctrlKey = true
    else return null
  }
  return init
}

/**
 * Press `accelerator` on the focused element, exactly as the key would: the
 * synthetic keydown bubbles through the element's own listeners (a
 * ProseMirror keymap, the notes editor's undo) and then the document
 * listener with its scope chain. Whether anything handled it — a binding
 * fired, or a listener prevented the default.
 */
export function runChord(accelerator: string): boolean {
  const init = chordToInit(accelerator)
  if (init === null) return false
  const target = document.activeElement ?? document.body
  const e = new KeyboardEvent('keydown', { ...init, bubbles: true, cancelable: true })
  target.dispatchEvent(e)
  return e.defaultPrevented || handledEvents.has(e)
}

/**
 * Run the binding of `action` that the focused element's scope chain
 * reaches (for menu items without a key). False inside a text field, or
 * when no binding of the action is registered or ready.
 */
export function runAction(action: ActionId): boolean {
  const target = document.activeElement
  if (isInputElement(target)) return false
  for (const scope of [...scopeChainFor(target), 'global']) {
    for (const entry of registry.values()) {
      if (entry.bindings.action !== action || entry.scope !== scope) continue
      if (entry.bindings.canHandle !== undefined && !entry.bindings.canHandle()) continue
      entry.handlerRef.current(new KeyboardEvent('keydown', { cancelable: true }))
      return true
    }
  }
  return false
}

function ensureListener(): void {
  if (listenerInstalled) return
  document.addEventListener('keydown', handleKeyDown)
  document.addEventListener('pointerdown', handlePointerDown, true)
  listenerInstalled = true
}

function removeListener(): void {
  if (registry.size > 0) return
  document.removeEventListener('keydown', handleKeyDown)
  document.removeEventListener('pointerdown', handlePointerDown, true)
  listenerInstalled = false
}

// ---------------------------------------------------------------------------
// Public hook
// ---------------------------------------------------------------------------

/**
 * Register one or more keyboard shortcuts for the lifetime of the calling
 * component. All bindings are unregistered on unmount.
 *
 * @example
 * useShortcuts([
 *   {
 *     keys: ['Delete', 'Backspace'],
 *     scope: 'canvas',
 *     handler: () => deleteSelected(),
 *     description: 'Delete selected object',
 *     preventDefault: true,
 *   },
 *   {
 *     keys: 'Mod+z',
 *     scope: 'global',
 *     handler: () => undo(),
 *     description: 'Undo',
 *     preventDefault: true,
 *   },
 * ])
 */
export function useShortcuts(bindings: ShortcutBinding[]): void {
  // Stable ref to the latest bindings array so we can update handlers
  // without re-registering.
  const bindingsRef = useRef(bindings)
  bindingsRef.current = bindings

  // We create one registered entry per binding in the array and keep their
  // stable ids in a ref so they survive re-renders.
  const idsRef = useRef<string[]>([])

  useEffect(() => {
    ensureListener()

    // Register each binding once (on mount).
    const ids: string[] = bindings.map((binding, idx) => {
      const id = nextId()
      // The handlerRef captures the latest closure by reading from bindingsRef
      // on each invocation — no re-registration needed when state changes.
      const handlerRef: MutableRefObject<(e: KeyboardEvent) => void> = {
        current: (e: KeyboardEvent) => {
          const latestBinding = bindingsRef.current[idx]
          if (latestBinding !== undefined) {
            latestBinding.handler(e)
          }
        },
      }
      registry.set(id, {
        id,
        bindings: binding,
        handlerRef,
        parsedKeys: parseKeys(binding.keys),
        scope: binding.scope,
        description: binding.description,
      })
      return id
    })

    idsRef.current = ids

    return () => {
      for (const id of ids) {
        registry.delete(id)
      }
      removeListener()
    }

    // Intentionally empty deps — we register once and use refs to stay fresh.
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
}

// ---------------------------------------------------------------------------
// Cheatsheet API
// ---------------------------------------------------------------------------

export interface CheatsheetEntry {
  scope: ShortcutScope
  keys: string | string[]
  description: string
}

/**
 * Returns a snapshot of all currently-registered shortcuts that have a
 * description. Intended to be called at cheatsheet render time (not as a
 * reactive subscription — the cheatsheet re-renders when it opens, so
 * stale data is not an issue).
 */
export function getRegisteredShortcuts(): CheatsheetEntry[] {
  const out: CheatsheetEntry[] = []
  for (const entry of registry.values()) {
    if (entry.description === undefined) continue
    out.push({
      scope: entry.scope,
      keys: entry.bindings.keys,
      description: entry.description,
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// Utility — render a key combo string as a human-readable label
// ---------------------------------------------------------------------------

/** Converts a key combo string into a display label, e.g. 'Mod+Shift+z' → '⌘⇧Z' or 'Ctrl+Shift+Z'. */
export function formatKeyCombo(combo: string): string {
  const parts = combo.split('+')
  const labels: string[] = []
  for (const part of parts) {
    switch (part) {
      case 'Mod':
        labels.push(IS_MAC ? '⌘' : 'Ctrl')
        break
      case 'Ctrl':
        labels.push('Ctrl')
        break
      case 'Alt':
        labels.push(IS_MAC ? '⌥' : 'Alt')
        break
      case 'Shift':
        labels.push(IS_MAC ? '⇧' : 'Shift')
        break
      default:
        // Capitalise single-char keys for readability.
        labels.push(part.length === 1 ? part.toUpperCase() : part)
    }
  }
  return labels.join(IS_MAC ? '' : '+')
}
