// @vitest-environment node
/**
 * oneDoor.test.ts — keeps the "one door" exemption list honest.
 *
 * `ONE_DOOR_PENDING` (apps/web/eslint.one-door.js) exempts files the A2
 * extraction has not migrated to commands yet. The list must only shrink:
 * an entry whose file no longer breaks the rule has been migrated and must
 * leave the list, or the exemption would silently re-open the door for the
 * next change to that file.
 */

import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ESLint } from 'eslint'
import tsparser from '@typescript-eslint/parser'
import { ONE_DOOR_PENDING, ONE_DOOR_RULES, SLIDE_MODEL_WRITERS } from '../eslint.one-door.js'

const repoRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..')

/** Lint with ONLY the one-door rules, ignoring the exemption list. */
function oneDoorLinter(): ESLint {
  return new ESLint({
    cwd: repoRoot,
    overrideConfigFile: true,
    overrideConfig: [
      {
        files: ['**/*.{ts,tsx}'],
        languageOptions: {
          parser: tsparser,
          parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
        },
        rules: ONE_DOOR_RULES,
      },
    ],
  })
}

describe('one-door lint rule', () => {
  it('bans every slide-model writer', () => {
    expect(SLIDE_MODEL_WRITERS.length).toBeGreaterThan(50)
    expect(SLIDE_MODEL_WRITERS).toContain('updateObject')
  })

  it('catches a writer import and a direct transaction', async () => {
    const [result] = await oneDoorLinter().lintText(
      "import { updateObject, listSlides } from '@narrative/slide-model'\n" +
        'export const f = (doc: { transact(fn: () => void): void }) => doc.transact(() => updateObject)\n',
      { filePath: resolve(repoRoot, 'apps/web/src/ui/Probe.tsx') },
    )
    const rules = result?.messages.map((m) => m.ruleId).sort()
    expect(rules).toEqual(['no-restricted-imports', 'no-restricted-syntax'])
  })

  it('lists each pending file once', () => {
    const files = ONE_DOOR_PENDING.map((p) => p.file)
    expect(new Set(files).size).toBe(files.length)
  })

  it.each(ONE_DOOR_PENDING.map((p) => [p.file, p.step] as const))(
    '%s (%s) still exists and still needs its exemption',
    async (file) => {
      const path = resolve(repoRoot, file)
      expect(existsSync(path), `${file} is gone: remove it from ONE_DOOR_PENDING`).toBe(true)
      const [result] = await oneDoorLinter().lintFiles([path])
      expect(
        result?.messages.length ?? 0,
        `${file} no longer breaks the one-door rule: remove it from ONE_DOOR_PENDING`,
      ).toBeGreaterThan(0)
    },
  )
})
