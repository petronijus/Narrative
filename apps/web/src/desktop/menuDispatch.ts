/**
 * desktop/menuDispatch.ts
 *
 * A click in the desktop app's menu, in the page: an item with a key presses
 * that key on the focused element (the same scope chain, the same text-field
 * rules, ProseMirror's own keymaps), one without runs its action's binding.
 * The answer tells the shell whether to run its native edit instead.
 */

import { USER_ACTIONS, type ActionId } from '../actions/catalog.js'
import { runAction, runChord } from '../state/useShortcuts.js'

function isActionId(action: string): action is ActionId {
  return Object.hasOwn(USER_ACTIONS, action)
}

export function dispatchMenuAction(action: string, accelerator: string | undefined): boolean {
  if (!isActionId(action)) return false
  return accelerator !== undefined ? runChord(accelerator) : runAction(action)
}
