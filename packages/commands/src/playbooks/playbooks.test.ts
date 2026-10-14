/**
 * The playbooks are model-facing prose served over MCP (prompts and
 * resources) and baked into the `narrative` Claude Code skill. A broken
 * frontmatter, a placeholder without an argument or a command that does not
 * exist would each reach every agent, so they fail the build here.
 */

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { createDefaultRegistry } from '../catalog.js'
import { danglingCommandMentions } from '../agentSurface.js'
import {
  BASICS_PLAYBOOK,
  NOT_GIVEN,
  PlaybookError,
  loadPlaybooks,
  parsePlaybook,
  resolvePlaybookArguments,
  substitutePlaceholders,
} from './index.js'

const registry = createDefaultRegistry()
const playbooks = loadPlaybooks()

/** A playbook's body at most (build-deck, the longest procedure, is ≈ 4.5 kB). */
const MAX_PLAYBOOK_BYTES = 6_000
/** basics is prepended to every other playbook's prompt: its own, slightly larger, cap. */
const MAX_BASICS_BYTES = 9_000

describe('committed playbooks', () => {
  it('load, with basics first and unique names', () => {
    expect(playbooks[0]!.name).toBe(BASICS_PLAYBOOK)
    const names = playbooks.map((p) => p.name)
    expect(new Set(names).size).toBe(names.length)
    expect(names.length).toBeGreaterThan(1)
  })

  it('stay short: a prompt is basics plus one playbook, in the context of a model (A5.7)', () => {
    const tooLong = playbooks
      .map((p) => ({
        name: p.name,
        bytes: Buffer.byteLength(p.body),
        max: p.name === BASICS_PLAYBOOK ? MAX_BASICS_BYTES : MAX_PLAYBOOK_BYTES,
      }))
      .filter((p) => p.bytes > p.max)
      .map((p) => `${p.name}: ${p.bytes} bytes, at most ${p.max}`)
    expect(tooLong).toEqual([])
  })

  it('only name commands that are registered, or mark them planned', () => {
    const dangling = playbooks.flatMap((p) =>
      danglingCommandMentions(p.body, registry).map((d) => `${p.name}: ${d}`),
    )
    expect(dangling).toEqual([])
  })

  it('substitute every placeholder once arguments are resolved', () => {
    for (const p of playbooks) {
      const given = Object.fromEntries(
        p.arguments.filter((a) => a.required).map((a) => [a.name, `value-of-${a.name}`]),
      )
      const text = substitutePlaceholders(p.body, resolvePlaybookArguments(p, given))
      expect(text, p.name).not.toMatch(/\{\{/)
    }
  })
})

describe('playbook parsing', () => {
  const file = '/playbooks/edit.md'
  const valid = [
    '---',
    'name: edit',
    'title: Targeted edits',
    'description: Make a specific change the user asked for.',
    'arguments:',
    '  - name: request',
    '    description: What the user wants changed.',
    '    required: true',
    '  - name: scope',
    '    description: Deck or a slide reference.',
    '    default: deck',
    '---',
    'Do {{request}} in {{ scope }}.',
  ].join('\n')

  it('parses frontmatter, defaults and body', () => {
    const p = parsePlaybook(valid, file)
    expect(p.arguments).toEqual([
      { name: 'request', description: 'What the user wants changed.', required: true },
      {
        name: 'scope',
        description: 'Deck or a slide reference.',
        required: false,
        default: 'deck',
      },
    ])
    expect(substitutePlaceholders(p.body, resolvePlaybookArguments(p, { request: 'x' }))).toBe(
      'Do x in deck.',
    )
  })

  it('rejects missing required arguments and unknown ones', () => {
    const p = parsePlaybook(valid, file)
    expect(() => resolvePlaybookArguments(p, {})).toThrow(/needs the argument 'request'/)
    expect(() => resolvePlaybookArguments(p, { request: '  ' })).toThrow(PlaybookError)
    expect(() => resolvePlaybookArguments(p, { request: 'x', other: 'y' })).toThrow(/unknown/)
  })

  it('fills an optional argument without a default with a marker', () => {
    const p = parsePlaybook(valid.replace('    default: deck\n', ''), file)
    expect(resolvePlaybookArguments(p, { request: 'x' })['scope']).toBe(NOT_GIVEN)
  })

  it.each([
    ['no frontmatter', 'just text', /missing YAML frontmatter/],
    ['bad yaml', '---\nname: [\n---\nbody', /not valid YAML/],
    ['unknown key', valid.replace('title:', 'colour: red\ntitle:'), /invalid frontmatter/],
    ['undeclared placeholder', valid.replace('{{request}}', '{{request}} {{what}}'), /what/],
    ['unused argument', valid.replace('{{ scope }}', 'the deck'), /never used/],
    ['name/file mismatch', valid.replace('name: edit', 'name: other'), /match the file name/],
    [
      'required with default',
      valid.replace('    required: true', '    required: true\n    default: x'),
      /required argument has no default/,
    ],
  ])('rejects %s', (_label, source, message) => {
    expect(() => parsePlaybook(source, file)).toThrow(message)
  })

  it('requires a basics playbook without arguments', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'playbooks-'))
    writeFileSync(path.join(dir, 'edit.md'), valid)
    expect(() => loadPlaybooks(dir)).toThrow(/no basics\.md/)
  })
})
