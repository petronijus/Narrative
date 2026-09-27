/**
 * The tool list is loaded into the model's context at the start of every MCP
 * session and re-read on every turn, so its size is a cost paid by every
 * user on every request. It was ≈ 235 KB (≈ 60k tokens) before the
 * compaction in tools.ts / schemaCompact.ts brought it to ≈ 150 KB, and
 * ≈ 129 KB after the shared field vocabulary (vocabulary.ts), examples only
 * where they add something, and the confirmation procedure said once in the
 * instructions (2026-09-28); this test keeps it from creeping back
 * unnoticed. (Claude Code with its default tools defers MCP tools behind
 * ToolSearch, so there the size barely matters; clients that load the
 * whole list — the agent eval, possibly claude.ai — pay all of it. See
 * tests/agent-eval/probes/listChanged.ts.)
 *
 * When it fails: a new command legitimately adds 1–2 KB. Look at what grew
 * (the failure lists the largest tools) before raising the budget — a long
 * repeated sentence belongs in the server instructions or the `basics`
 * playbook, not on every tool.
 */

import { describe, expect, it } from 'vitest'
import { createDefaultRegistry } from '@narrative/commands'
import { ToolCatalog, type ConfirmationMode } from './tools.js'

/** Bytes of `JSON.stringify({ tools })` for the largest variant (clients that confirm by link). */
export const TOOL_LIST_BUDGET_BYTES = 132_000
/** No single tool may carry more than this (object_create, the largest, is ≈ 14 KB). */
export const TOOL_BUDGET_BYTES = 16_000

const catalog = new ToolCatalog(createDefaultRegistry())
const MODES: ConfirmationMode[] = ['form', 'url', 'link']

describe('tools/list size budget', () => {
  it.each(MODES)('stays within %s-mode budget', (mode) => {
    const tools = catalog.list(mode)
    const bytes = Buffer.byteLength(JSON.stringify({ tools }))
    const largest = tools
      .map((t) => `${t.name} ${JSON.stringify(t).length}`)
      .sort((a, b) => Number(b.split(' ')[1]) - Number(a.split(' ')[1]))
      .slice(0, 5)
    expect(
      bytes,
      `tools/list is ${bytes} bytes; largest: ${largest.join(', ')}`,
    ).toBeLessThanOrEqual(TOOL_LIST_BUDGET_BYTES)
  })

  it('keeps every single tool within its budget', () => {
    for (const tool of catalog.list('link'))
      expect(JSON.stringify(tool).length, tool.name).toBeLessThanOrEqual(TOOL_BUDGET_BYTES)
  })

  it('keeps every schema self-contained ($refs only to its own $defs)', () => {
    for (const tool of catalog.list('link')) {
      const json = JSON.stringify(tool.inputSchema)
      const defs = Object.keys(
        ((tool.inputSchema as Record<string, unknown>)['$defs'] ?? {}) as object,
      )
      for (const [, name] of json.matchAll(/"\$ref":"#\/\$defs\/([^"]+)"/g))
        expect(defs, `${tool.name} → ${name}`).toContain(decodeURIComponent(name!))
    }
  })
})
