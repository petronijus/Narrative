import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { skillFiles } from './skillFiles.js'

const files = await skillFiles()

describe('committed narrative skill (claude-plugin/narrative)', () => {
  for (const [file, content] of files) {
    it(`${file.split('/').slice(-2).join('/')} is up to date (run pnpm --filter @narrative/commands skill)`, () => {
      const current = existsSync(file) ? readFileSync(file, 'utf8') : ''
      expect(current === content).toBe(true)
    })
  }
})
