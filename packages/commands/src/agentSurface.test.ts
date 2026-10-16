import { describe, expect, it } from 'vitest'
import { createDefaultRegistry } from './catalog.js'
import {
  TOOL_NAME_MAX,
  commandFetchesUrls,
  commandIdForToolName,
  danglingCommandMentions,
  findCommandMentions,
  rewriteCommandMentionsAsToolNames,
  toolNameForCommand,
} from './agentSurface.js'

const registry = createDefaultRegistry()
const commands = registry.list()

describe('tool names', () => {
  it('are valid for Claude (^[a-zA-Z0-9_-]{1,64}$), short enough for a server prefix, and reversible', () => {
    for (const c of commands) {
      const name = toolNameForCommand(c.id)
      expect(name, c.id).toMatch(/^[a-zA-Z0-9_-]{1,64}$/)
      expect(name.length, c.id).toBeLessThanOrEqual(TOOL_NAME_MAX)
      expect(commandIdForToolName(name)).toBe(c.id)
    }
  })

  it('are unique', () => {
    const names = commands.map((c) => toolNameForCommand(c.id))
    expect(new Set(names).size).toBe(names.length)
  })

  it('reject names that cannot come from a command id', () => {
    for (const bad of [
      'object',
      'object.move',
      'Object_move',
      'object__move',
      'object_move_',
      '',
      'a_b_c_d_e',
    ])
      expect(commandIdForToolName(bad), bad).toBeNull()
  })
})

describe('command mentions', () => {
  it('recognise the planned marker after a code span and across a line break', () => {
    const [m] = findCommandMentions(
      'Use `component.refreshThumbnail` (planned, not\n  available yet) later.',
    )
    expect(m).toMatchObject({ id: 'component.refreshThumbnail', planned: true, wildcard: false })
    expect(
      danglingCommandMentions(
        'Use `component.refreshThumbnail` (planned, not\n  available yet).',
        registry,
      ),
    ).toEqual([])
    expect(danglingCommandMentions('Use component.refreshThumbnail now.', registry)).toHaveLength(1)
    expect(
      danglingCommandMentions('Use slide.add (planned, not available yet).', registry),
    ).toEqual(['slide.add is registered but marked planned'])
  })

  it('rewrite ids and wildcards into tool names', () => {
    expect(
      rewriteCommandMentionsAsToolNames('Call `query.deck`, then table.style.* or ops.apply.'),
    ).toBe('Call `query_deck`, then table_style_* or ops_apply.')
  })
})

describe('commandFetchesUrls', () => {
  it('flags exactly the commands whose input takes a file by URL', () => {
    const fetching = commands.filter((c) => commandFetchesUrls(c)).map((c) => c.id)
    expect(fetching).toEqual(
      expect.arrayContaining([
        'media.upload',
        'folder.fonts.upload',
        'deck.importPptx',
        'deck.insertFrom',
      ]),
    )
    expect(fetching).not.toContain('object.update')
    expect(fetching).not.toContain('text.set')
  })
})
