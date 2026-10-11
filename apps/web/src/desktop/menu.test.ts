/**
 * desktop/menu.test.ts
 *
 * The editor's menu for the desktop app (desktop/menu.ts): every item is a
 * catalog action, its key comes from the table the shell enforces, its key
 * reaches a real binding, and that binding prevents the key's default — on
 * macOS a menu key is a live key equivalent, which would otherwise run the
 * action a second time after the page did.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import {
  DESKTOP_MENU_ACCELERATORS,
  DESKTOP_MENU_LABEL_MAX,
  DESKTOP_MENU_MAX_ITEMS,
  type DesktopMenuItem,
} from '@narrative/shared'
import { USER_ACTIONS } from '../actions/catalog'
import { chordToInit } from '../state/useShortcuts'
import { DESKTOP_MENU } from './menu'

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const items = DESKTOP_MENU.flatMap((s) =>
  s.items.filter((i): i is DesktopMenuItem => i !== 'separator'),
)

function sourceFiles(dir = SRC): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) return sourceFiles(full)
    return /\.tsx?$/.test(name) && !/\.(test|spec)\.tsx?$/.test(name) ? [full] : []
  })
}

/** Every object literal with an `action: '<id>'` and a `keys` property: the shortcut bindings. */
function bindings(): Array<{ where: string; action: string; preventDefault: boolean }> {
  const out: Array<{ where: string; action: string; preventDefault: boolean }> = []
  for (const file of sourceFiles()) {
    const text = readFileSync(file, 'utf8')
    if (!text.includes('keys:')) continue
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
    const visit = (node: ts.Node): void => {
      if (ts.isObjectLiteralExpression(node)) {
        const props = new Map(
          node.properties
            .filter(ts.isPropertyAssignment)
            .map((p) => [p.name.getText(sf), p.initializer] as const),
        )
        const action = props.get('action')
        if (props.has('keys') && props.has('scope') && action && ts.isStringLiteral(action)) {
          const pd = props.get('preventDefault')
          out.push({
            where: `${path.relative(SRC, file)}:${sf.getLineAndCharacterOfPosition(node.pos).line + 1}`,
            action: action.text,
            preventDefault: pd !== undefined && pd.kind === ts.SyntaxKind.TrueKeyword,
          })
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(sf)
  }
  return out
}

describe('the desktop menu', () => {
  it('names catalog actions, with labels the shell accepts', () => {
    for (const item of items) {
      expect(Object.hasOwn(USER_ACTIONS, item.action), item.action).toBe(true)
      expect(item.label.length).toBeLessThanOrEqual(DESKTOP_MENU_LABEL_MAX)
    }
    for (const section of DESKTOP_MENU) {
      expect(section.items.length).toBeLessThanOrEqual(DESKTOP_MENU_MAX_ITEMS)
    }
  })

  it('takes every key and native fallback from the shared table', () => {
    for (const item of items) {
      const keys = DESKTOP_MENU_ACCELERATORS[item.action]
      expect(item.accelerator, item.action).toBe(keys?.accelerator)
      expect(item.nativeFallback, item.action).toBe(keys?.nativeFallback)
    }
  })

  it('has a binding for every item, which prevents the default of a menu key', () => {
    const all = bindings()
    const missing = items
      .filter((i) => !all.some((b) => b.action === i.action))
      .map((i) => i.action)
    expect(missing).toEqual([])
    const keyed = new Set(items.filter((i) => i.accelerator !== undefined).map((i) => i.action))
    const loose = all.filter((b) => keyed.has(b.action) && !b.preventDefault).map((b) => b.where)
    expect(loose).toEqual([])
  })

  it('turns every menu key into a key event', () => {
    for (const { accelerator } of Object.values(DESKTOP_MENU_ACCELERATORS)) {
      const init = chordToInit(accelerator)
      expect(init, accelerator).not.toBeNull()
      expect(init!.metaKey === true || init!.ctrlKey === true, accelerator).toBe(true)
    }
    expect(chordToInit('Shift+CmdOrCtrl+Z')).toMatchObject({ key: 'z', shiftKey: true })
    expect(chordToInit('CmdOrCtrl+Enter')).toMatchObject({ key: 'Enter' })
    expect(chordToInit('Super+Z')).toBeNull()
  })
})
