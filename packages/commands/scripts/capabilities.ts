/**
 * Regenerate (or, with --check, verify) the committed capability manifest:
 *   packages/commands/capabilities.json
 *   docs/capabilities.md
 *
 * Usage: pnpm --filter @narrative/commands capabilities [--check]
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { capabilityFiles } from './capabilityFiles.js'

const check = process.argv.includes('--check')
let stale = false
for (const file of await capabilityFiles()) {
  let current: string | null = null
  try {
    current = readFileSync(file.path, 'utf8')
  } catch {
    current = null
  }
  if (current === file.content) continue
  if (check) {
    console.error(`stale: ${file.path}`)
    stale = true
  } else {
    writeFileSync(file.path, file.content)
    console.log(`wrote ${file.path}`)
  }
}
if (stale) {
  console.error('Run `pnpm --filter @narrative/commands capabilities` and commit the result.')
  process.exit(1)
}
