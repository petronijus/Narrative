/**
 * mcp/results.test.ts — a command outcome as an MCP tool result: the output
 * as JSON text and structured content, a write's run line, and an output's
 * image (query.render) as image content the model looks at, not as text.
 */

import { describe, expect, it } from 'vitest'
import { hostResultToToolResult } from './results.js'

describe('hostResultToToolResult', () => {
  it('gives the output as JSON text and structured content', () => {
    const out = hostResultToToolResult(
      { ok: true, command: 'query.slide', result: { id: 's1' }, runId: null, seq: null },
      { write: false },
    )
    expect(out.content).toEqual([{ type: 'text', text: '{"id":"s1"}' }])
    expect(out.structuredContent).toEqual({ id: 's1' })
  })

  it("hands an output's image over as image content, and keeps its base64 out of the text", () => {
    const base64 = 'iVBORw0KGgo' + 'A'.repeat(1_000)
    const out = hostResultToToolResult(
      {
        ok: true,
        command: 'query.render',
        result: {
          mode: 'slide',
          width: 1430,
          height: 804,
          image: { mimeType: 'image/png', base64 },
        },
        runId: null,
        seq: null,
      },
      { write: false },
    )
    expect(out.content).toHaveLength(2)
    expect(out.content[1]).toEqual({ type: 'image', data: base64, mimeType: 'image/png' })
    const text = (out.content[0] as { text: string }).text
    expect(text).not.toContain(base64)
    expect(JSON.parse(text)).toMatchObject({ mode: 'slide', image: { mimeType: 'image/png' } })
    expect(JSON.stringify(out.structuredContent)).not.toContain(base64)
  })

  it('leaves an output alone whose `image` is not a picture it can show', () => {
    const result = { image: { mimeType: 'text/html', base64: 'PGI+' } }
    const out = hostResultToToolResult(
      { ok: true, command: 'x', result, runId: null, seq: null },
      { write: false },
    )
    expect(out.content).toHaveLength(1)
    expect(out.structuredContent).toEqual(result)
  })
})
