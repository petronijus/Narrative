/**
 * @narrative/commands/playbooks — the playbook loader (Node only).
 *
 * Playbooks are Narrative's own instructions for an AI agent, one Markdown
 * file per playbook in `packages/commands/playbooks/` (format:
 * playbooks/README.md). Two surfaces are generated from the same files, so
 * they never drift apart (docs/plans/agentic-layer.md §4.4):
 *   - the MCP server serves each playbook as an MCP prompt, with `basics`
 *     prepended to every other one (apps/server/src/mcp/prompts.ts);
 *   - the `narrative` Claude Code skill (scripts/skill.ts).
 *
 * A subpath export, not part of the main entry: it reads the filesystem,
 * and the main entry is also bundled into the browser editor.
 *
 * Location at runtime: the Markdown files sit next to this package's `src/`
 * directory. In development that is the source tree; in the production
 * image the compiled `src/playbooks/index.js` replaces this file at the same
 * relative position and the Dockerfile copies `playbooks/` alongside, so
 * `../../playbooks/` resolves in both.
 */

import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'
import { z } from 'zod'

/** Directory of the playbook Markdown files. */
export const PLAYBOOKS_DIR = fileURLToPath(new URL('../../playbooks/', import.meta.url))

/** The playbook every other one builds on; prepended to every other prompt. */
export const BASICS_PLAYBOOK = 'basics'

const NAME = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/
const ARGUMENT_NAME = /^[a-z][a-zA-Z0-9]*$/
const PLACEHOLDER = /\{\{\s*([^{}\s]+)\s*\}\}/g

const ArgumentSchema = z.strictObject({
  name: z.string().regex(ARGUMENT_NAME, 'argument names are lower camelCase'),
  description: z.string().min(10).max(300),
  required: z.boolean().default(false),
  /** Substituted when an optional argument is not given. */
  default: z.string().min(1).max(200).optional(),
})

const FrontmatterSchema = z
  .strictObject({
    name: z.string().regex(NAME, 'playbook names are lower-kebab-case'),
    title: z.string().min(3).max(80),
    description: z.string().min(20).max(300),
    arguments: z.array(ArgumentSchema).max(10).default([]),
  })
  .superRefine((fm, ctx) => {
    const seen = new Set<string>()
    for (const [i, arg] of fm.arguments.entries()) {
      if (seen.has(arg.name))
        ctx.addIssue({
          code: 'custom',
          path: ['arguments', i, 'name'],
          message: `duplicate ${arg.name}`,
        })
      seen.add(arg.name)
      if (arg.required && arg.default !== undefined)
        ctx.addIssue({
          code: 'custom',
          path: ['arguments', i, 'default'],
          message: 'a required argument has no default',
        })
    }
  })

export type PlaybookArgument = z.output<typeof ArgumentSchema>

export interface Playbook {
  name: string
  title: string
  description: string
  arguments: PlaybookArgument[]
  /** The Markdown body after the frontmatter, trimmed. */
  body: string
  /** Absolute path of the source file. */
  file: string
}

export class PlaybookError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PlaybookError'
  }
}

/** Parse one playbook file. Throws `PlaybookError` naming the file and the problem. */
export function parsePlaybook(source: string, file: string): Playbook {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(source)
  if (match === null) throw new PlaybookError(`${file}: missing YAML frontmatter (--- … ---)`)
  let raw: unknown
  try {
    raw = parseYaml(match[1]!)
  } catch (e) {
    throw new PlaybookError(`${file}: frontmatter is not valid YAML: ${(e as Error).message}`)
  }
  const parsed = FrontmatterSchema.safeParse(raw)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    throw new PlaybookError(`${file}: invalid frontmatter — ${issues.join('; ')}`)
  }
  const body = match[2]!.trim()
  if (body.length === 0) throw new PlaybookError(`${file}: empty body`)
  const declared = new Set(parsed.data.arguments.map((a) => a.name))
  const used = new Set([...body.matchAll(PLACEHOLDER)].map((m) => m[1]!))
  const undeclared = [...used].filter((u) => !declared.has(u))
  if (undeclared.length > 0)
    throw new PlaybookError(`${file}: placeholders without an argument: ${undeclared.join(', ')}`)
  const unused = [...declared].filter((d) => !used.has(d))
  if (unused.length > 0)
    throw new PlaybookError(`${file}: arguments never used in the body: ${unused.join(', ')}`)
  const expectedName = path.basename(file, '.md')
  if (parsed.data.name !== expectedName)
    throw new PlaybookError(`${file}: name '${parsed.data.name}' must match the file name`)
  return { ...parsed.data, body, file }
}

/**
 * Load every playbook in `dir` (default: the package's playbooks), sorted
 * with `basics` first and the rest by name. Throws on any invalid file:
 * a broken playbook must fail loudly, not disappear from the prompt list.
 */
export function loadPlaybooks(dir: string = PLAYBOOKS_DIR): Playbook[] {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.md') && f !== 'README.md')
    .sort()
  const playbooks = files.map((f) => {
    const file = path.join(dir, f)
    return parsePlaybook(readFileSync(file, 'utf8'), file)
  })
  if (!playbooks.some((p) => p.name === BASICS_PLAYBOOK))
    throw new PlaybookError(`${dir}: no ${BASICS_PLAYBOOK}.md`)
  const basics = playbooks.find((p) => p.name === BASICS_PLAYBOOK)!
  if (basics.arguments.length > 0)
    throw new PlaybookError(`${basics.file}: basics takes no arguments`)
  return [basics, ...playbooks.filter((p) => p.name !== BASICS_PLAYBOOK)]
}

/** What an optional argument reads as when it was not given and has no default. */
export const NOT_GIVEN = '(not given)'

/**
 * Resolve the arguments of one prompt invocation: every required one given
 * and non-empty, no unknown ones; optional ones fall back to their default
 * or {@link NOT_GIVEN}. Throws `PlaybookError`.
 */
export function resolvePlaybookArguments(
  playbook: Playbook,
  given: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const known = new Set(playbook.arguments.map((a) => a.name))
  const unknown = Object.keys(given).filter((k) => !known.has(k))
  if (unknown.length > 0)
    throw new PlaybookError(`unknown argument(s) for '${playbook.name}': ${unknown.join(', ')}`)
  const out: Record<string, string> = {}
  for (const arg of playbook.arguments) {
    const value = given[arg.name]?.trim()
    if (value !== undefined && value !== '') out[arg.name] = value
    else if (arg.required)
      throw new PlaybookError(`'${playbook.name}' needs the argument '${arg.name}'`)
    else out[arg.name] = arg.default ?? NOT_GIVEN
  }
  return out
}

/** Replace `{{arg}}` placeholders. `values` must hold every argument (see resolvePlaybookArguments). */
export function substitutePlaceholders(
  body: string,
  values: Readonly<Record<string, string>>,
): string {
  return body.replace(PLACEHOLDER, (whole, name: string) => values[name] ?? whole)
}
