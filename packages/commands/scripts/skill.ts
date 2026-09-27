/**
 * Generate the `narrative` Claude Code skill from the playbooks
 * (packages/commands/playbooks/*.md) — the same files the MCP server serves
 * as prompts, so the skill and the prompts never drift apart
 * (docs/plans/agentic-layer.md §4.4). Never edit the generated skill by hand.
 *
 * Usage:
 *   pnpm --filter @narrative/commands skill [-- --out <skill dir>] [--api-url <url>] [--check]
 *
 *   --out      the skill directory; default: the plugin in this repo,
 *              claude-plugin/narrative/skills/narrative
 *   --api-url  the public API base the setup section points at
 *              (default https://narrative.bastla.com/api)
 *   --check    write nothing; exit 1 when the directory is stale
 *
 * Output:
 *   SKILL.md               frontmatter (name, description written so Claude
 *                          Code picks the skill for Narrative work), setup,
 *                          the basics playbook, an index of the others
 *   references/<name>.md   every other playbook, placeholders shown as <arg>
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { DEFAULT_API_URL, DEFAULT_SKILL_DIR, skillFiles } from './skillFiles.js'

function args(argv: string[]): { out: string; apiUrl: string; check: boolean } {
  const rest = argv.filter((a) => a !== '--')
  const value = (flag: string): string | undefined => {
    const i = rest.indexOf(flag)
    return i >= 0 ? rest[i + 1] : undefined
  }
  const out = value('--out')
  if (out !== undefined && out.startsWith('--')) {
    console.error(
      'usage: pnpm --filter @narrative/commands skill [-- --out <skill dir>] [--api-url <url>] [--check]',
    )
    process.exit(2)
  }
  return {
    out: path.resolve(out ?? DEFAULT_SKILL_DIR),
    apiUrl: (value('--api-url') ?? DEFAULT_API_URL).replace(/\/+$/, ''),
    check: rest.includes('--check'),
  }
}

const { out, apiUrl, check } = args(process.argv.slice(2))
const files = await skillFiles(out, apiUrl)
const referencesDir = path.join(out, 'references')
const orphans = existsSync(referencesDir)
  ? readdirSync(referencesDir)
      .map((f) => path.join(referencesDir, f))
      .filter((f) => !files.has(f))
  : []

let stale = false
for (const [file, content] of files) {
  const current = existsSync(file) ? readFileSync(file, 'utf8') : null
  if (current === content) continue
  if (check) {
    console.error(`stale: ${file}`)
    stale = true
    continue
  }
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, content)
  console.log(`wrote ${file}`)
}
for (const orphan of orphans) {
  // A playbook was removed or renamed. Never delete here: say so, and let a
  // person move the file to the trash.
  console.error(`no longer generated (remove it): ${orphan}`)
  stale = true
}
if (check && stale) {
  console.error('The narrative skill is stale: run `pnpm --filter @narrative/commands skill`.')
  process.exit(1)
}
if (!check && orphans.length > 0) process.exit(1)
