/**
 * bootImports.test.ts — module graphs the server's start must not load
 * (performance plan D3).
 *
 * Every static import is loaded before the first line of index.ts runs. jsdom
 * alone was ~1,100 of the ~2,700 modules a production start loaded (with
 * css-tree, parse5, undici and the rest of its graph) — 32 % of the time to
 * the first log line — for SVG uploads only, so media/svgSanitize.ts requires
 * it on first use. This keeps any other server module from importing it (or
 * another graph listed here) statically again; a type-only import is fine.
 */

import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/** Packages only a request path needs, each with why. */
const LAZY_ONLY: Record<string, string> = {
  jsdom: 'SVG sanitising (media/svgSanitize.ts loads it on the first SVG upload)',
}

const SRC = path.dirname(new URL(import.meta.url).pathname)

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      // Scripts and test support never run in the server process.
      if (entry.name === 'scripts' || entry.name === 'test-support') continue
      out.push(...sourceFiles(full))
    } else if (entry.name.endsWith('.ts') && !/\.(test|spec)\.ts$/.test(entry.name)) {
      out.push(full)
    }
  }
  return out
}

/**
 * Static value imports of `pkg` (`import x from 'pkg'`, `import 'pkg'`,
 * `export … from 'pkg'`, subpaths too); `import type` / `export type` pass.
 * Statements are collected line by line (the code has no semicolons): one
 * starts at a line beginning with `import` or a re-export and ends at its
 * `from '…'` (or is a bare `import '…'`).
 */
function staticImportsOf(source: string, pkg: string): string[] {
  const specifier = (stmt: string): string | undefined =>
    /\bfrom\s+['"]([^'"]+)['"]/.exec(stmt)?.[1] ?? /^\s*import\s+['"]([^'"]+)['"]/.exec(stmt)?.[1]
  const statements: string[] = []
  let current: string | null = null
  for (const line of source.split('\n')) {
    // `import …` and re-exports (`export {` / `export *` / `export type {`); not `export const`.
    if (current === null && /^\s*(import\b|export\s*(\{|\*|type\s*\{))/.test(line)) current = ''
    if (current === null) continue
    current += (current === '' ? '' : '\n') + line
    if (specifier(current) !== undefined) {
      statements.push(current)
      current = null
    } else if (current.split('\n').length > 200) {
      current = null // not an import statement after all (`import(` in an expression)
    }
  }
  return statements.filter((stmt) => {
    const spec = specifier(stmt)
    if (spec === undefined || (spec !== pkg && !spec.startsWith(`${pkg}/`))) return false
    return !/^\s*(import|export)\s+type\b/.test(stmt)
  })
}

describe('the server start loads no request-only module graph', () => {
  const files = sourceFiles(SRC)

  it('finds the sources', () => {
    expect(files.length).toBeGreaterThan(100)
    expect(files.some((f) => f.endsWith(path.join('media', 'svgSanitize.ts')))).toBe(true)
  })

  for (const [pkg, why] of Object.entries(LAZY_ONLY)) {
    it(`imports ${pkg} only lazily — ${why}`, () => {
      const offenders = files.flatMap((file) =>
        staticImportsOf(readFileSync(file, 'utf8'), pkg).map(
          (stmt) => `${path.relative(SRC, file)}: ${stmt.trim()}`,
        ),
      )
      expect(offenders).toEqual([])
    })
  }

  it('recognises a static import and lets a type-only one pass', () => {
    expect(staticImportsOf("import { JSDOM } from 'jsdom'\n", 'jsdom')).toHaveLength(1)
    expect(staticImportsOf("import 'jsdom'\n", 'jsdom')).toHaveLength(1)
    expect(staticImportsOf("export { JSDOM } from 'jsdom/lib/api.js'\n", 'jsdom')).toHaveLength(1)
    expect(staticImportsOf("import type { JSDOM } from 'jsdom'\n", 'jsdom')).toHaveLength(0)
    expect(staticImportsOf("import { x } from 'jsdom-extra'\n", 'jsdom')).toHaveLength(0)
    const multiline = "import {\n  JSDOM,\n  VirtualConsole,\n} from 'jsdom'\nconst x = 1\n"
    expect(staticImportsOf(multiline, 'jsdom')).toHaveLength(1)
    const neighbours = "import { a } from 'node:module'\nimport type { JSDOM } from 'jsdom'\n"
    expect(staticImportsOf(neighbours, 'jsdom')).toHaveLength(0)
    const declaration = "export function f() {\n  return 1\n}\nimport type { JSDOM } from 'jsdom'\n"
    expect(staticImportsOf(declaration, 'jsdom')).toHaveLength(0)
    expect(staticImportsOf("const m = await import('jsdom')\n", 'jsdom')).toHaveLength(0)
  })
})
