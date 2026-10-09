/**
 * actions/catalog.test.ts — the parity guard over what a person does in the
 * editor (plan §9.1 guard 2, A2.13): every shortcut, menu item and toolbar
 * button names a catalog action (the types force it on shortcuts and menu
 * items; this test on the toolbar's buttons), every action says how an agent
 * reaches the same outcome, and every command it names exists.
 */

import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { createDefaultRegistry } from '@narrative/commands'
import { USER_ACTIONS, type UserAction } from './catalog'

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const actions = Object.entries(USER_ACTIONS) as Array<[string, UserAction]>

/** Every .ts / .tsx source file under src/, tests and the catalog itself excluded. */
function sourceFiles(dir = SRC): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) return sourceFiles(full)
    if (!/\.tsx?$/.test(name) || /\.(test|spec)\.tsx?$/.test(name)) return []
    if (full.endsWith(path.join('actions', 'catalog.ts'))) return []
    return [full]
  })
}

describe('the action catalog', () => {
  const registry = createDefaultRegistry()

  it('names only commands that exist', () => {
    const missing = actions.flatMap(([id, a]) =>
      'commands' in a ? a.commands.filter((c) => !registry.has(c)).map((c) => `${id}: ${c}`) : [],
    )
    expect(missing).toEqual([])
  })

  it('says why an action is editor-only or not built', () => {
    const weak = actions
      .filter(([, a]) => {
        const reason = 'editorOnly' in a ? a.editorOnly : 'planned' in a ? a.planned : null
        return reason !== null && reason.trim().length < 20
      })
      .map(([id]) => id)
    expect(weak).toEqual([])
  })

  it('has no action nothing uses', () => {
    const source = sourceFiles()
      .map((f) => readFileSync(f, 'utf8'))
      .join('\n')
    const unused = actions
      .map(([id]) => id)
      .filter((id) => !source.includes(`'${id}'`) && !source.includes(`"${id}"`))
    expect(unused).toEqual([])
  })
})

// Parses every .tsx file in src with the TypeScript compiler: ~0.3 s alone,
// growing with the code base, so it gets its own budget rather than the 5 s
// of a unit test — on a busy MacBook it crossed that inside `just check`
// (2026-10-07/08).
describe('hand-rolled menu items', { timeout: 60_000 }, () => {
  /** Every element with a menu-item role, in every source file, with its data-action. */
  function menuItems(): Array<{ where: string; action: ts.JsxAttribute | undefined }> {
    const out: Array<{ where: string; action: ts.JsxAttribute | undefined }> = []
    for (const file of sourceFiles().filter((f) => f.endsWith('.tsx'))) {
      const sf = ts.createSourceFile(
        file,
        readFileSync(file, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TSX,
      )
      const visit = (node: ts.Node): void => {
        if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
          const attrs = node.attributes.properties.filter(ts.isJsxAttribute)
          const role = attrs.find((p) => p.name.getText(sf) === 'role')?.initializer
          if (
            role !== undefined &&
            ts.isStringLiteral(role) &&
            /^menuitem(checkbox|radio)?$/.test(role.text)
          ) {
            out.push({
              where: `${path.relative(SRC, file)}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}`,
              action: attrs.find((p) => p.name.getText(sf) === 'data-action'),
            })
          }
        }
        ts.forEachChild(node, visit)
      }
      visit(sf)
    }
    return out
  }

  it('each name a catalog action (Radix items get it from their typed `action` prop)', () => {
    const items = menuItems()
    expect(items.length).toBeGreaterThan(0)
    const without = items.filter((i) => i.action === undefined).map((i) => i.where)
    expect(without).toEqual([])
    const wrong = items.flatMap((i) => {
      const init = i.action?.initializer
      if (init === undefined) return []
      if (ts.isStringLiteral(init))
        return init.text in USER_ACTIONS ? [] : [`${i.where}: ${init.text}`]
      return [] // an expression is typed as ActionId where it is built
    })
    expect(wrong).toEqual([])
  })
})

describe('toolbar buttons', () => {
  const file = path.join(SRC, 'ui', 'Toolbar.tsx')
  const sf = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  )

  /** Every <Button> / <button> in the toolbar, with its data-action attribute. */
  function buttons(): Array<{ line: number; action: ts.JsxAttribute | undefined }> {
    const out: Array<{ line: number; action: ts.JsxAttribute | undefined }> = []
    const visit = (node: ts.Node): void => {
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const tag = node.tagName.getText(sf)
        if (tag === 'Button' || tag === 'button') {
          const action = node.attributes.properties.find(
            (p): p is ts.JsxAttribute =>
              ts.isJsxAttribute(p) && p.name.getText(sf) === 'data-action',
          )
          out.push({ line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, action })
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(sf)
    return out
  }

  it('each name a catalog action', () => {
    const all = buttons()
    expect(all.length).toBeGreaterThan(10)
    const without = all.filter((b) => b.action === undefined).map((b) => `Toolbar.tsx:${b.line}`)
    expect(without).toEqual([])
    // A literal must be a catalog id; an expression must be the typed helper.
    const wrong = all.flatMap((b) => {
      const init = b.action?.initializer
      if (init === undefined) return []
      if (ts.isStringLiteral(init))
        return init.text in USER_ACTIONS ? [] : [`${b.line}: ${init.text}`]
      const expr = ts.isJsxExpression(init) ? init.expression?.getText(sf) : undefined
      return expr?.startsWith('toolAction(') === true ? [] : [`${b.line}: ${String(expr)}`]
    })
    expect(wrong).toEqual([])
  })
})
