/**
 * main/menuRouting.ts
 *
 * A click on one of the editor's menu items (docs/plans/desktop-d0-spec.md
 * §3.7). It always goes to the main window — never the focused one, which
 * may be the presenter popup — as `menuAction`, and the page answers whether
 * it handled it. Unhandled with a native edit (Undo in a text field): the
 * shell runs that edit, as the real key would have. No answer within a
 * second: nothing more happens — a busy page that answers late has run the
 * action itself, and the native edit as well would run it twice.
 */

import type { WebContents } from 'electron'
import { DESKTOP_IPC, type DesktopNativeEdit } from '@narrative/shared'
import type { Logger } from './log.js'
import type { WebMenuItem } from './menu.js'

export const MENU_ANSWER_TIMEOUT_MS = 1_000

export class MenuRouter {
  private seq = 0
  private readonly waiting = new Map<number, (handled: boolean) => void>()

  constructor(private readonly log: Logger) {}

  /** Send `item` to the page of `contents`; run its native edit if the page leaves it. */
  dispatch(contents: WebContents, item: WebMenuItem): void {
    const seq = ++this.seq
    const timer = setTimeout(() => {
      if (this.waiting.delete(seq)) this.log.warn('menu action unanswered', { action: item.action })
    }, MENU_ANSWER_TIMEOUT_MS)
    this.waiting.set(seq, (handled) => {
      clearTimeout(timer)
      if (!handled && item.nativeFallback !== undefined && !contents.isDestroyed()) {
        runNativeEdit(contents, item.nativeFallback)
      }
    })
    contents.send(DESKTOP_IPC.menuAction, {
      seq,
      action: item.action,
      // A shown key or an unshown chord: the page presses it either way.
      ...((item.accelerator ?? item.chord) !== undefined
        ? { accelerator: item.accelerator ?? item.chord }
        : {}),
    })
  }

  /** The page's answer (`menuActionResult`). */
  answer(seq: number, handled: boolean): void {
    const resolve = this.waiting.get(seq)
    if (resolve === undefined) return
    this.waiting.delete(seq)
    resolve(handled)
  }
}

function runNativeEdit(contents: WebContents, edit: DesktopNativeEdit): void {
  switch (edit) {
    case 'undo':
      return contents.undo()
    case 'redo':
      return contents.redo()
    case 'cut':
      return contents.cut()
    case 'copy':
      return contents.copy()
    case 'paste':
      return contents.paste()
    case 'delete':
      return contents.delete()
    case 'selectAll':
      return contents.selectAll()
  }
}
