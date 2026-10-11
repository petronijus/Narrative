/**
 * scripts/version.test.ts
 *
 * The desktop app carries the repository's version (AGENTS.md → Versions:
 * git tag = every package version), which the update feed and the About box
 * report. `just bump` sets it with every other package; this catches a
 * package that missed a bump, as apps/desktop did when main released 0.10.25
 * while it lived on its branch.
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = path.dirname(fileURLToPath(import.meta.url))
const version = (file: string): string =>
  (JSON.parse(readFileSync(file, 'utf8')) as { version: string }).version

describe('desktop version', () => {
  it('equals the repository version', () => {
    expect(version(path.join(here, '../package.json'))).toBe(
      version(path.join(here, '../../../package.json')),
    )
  })
})
