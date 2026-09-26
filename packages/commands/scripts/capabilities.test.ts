import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { capabilityFiles } from './capabilityFiles.js'

const files = await capabilityFiles()

describe('committed capability manifest', () => {
  for (const file of files) {
    it(`${file.path.split('/').slice(-2).join('/')} is up to date (run pnpm --filter @narrative/commands capabilities)`, () => {
      let current = ''
      try {
        current = readFileSync(file.path, 'utf8')
      } catch {
        current = ''
      }
      expect(current === file.content).toBe(true)
    })
  }
})
