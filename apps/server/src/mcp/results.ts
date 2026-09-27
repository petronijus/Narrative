/**
 * mcp/results.ts — how a ServerHost outcome becomes an MCP tool result.
 *
 * Success: `structuredContent` is the command's output (validated against
 * its output schema by the runner) and the first text block is the same
 * value serialised as JSON — the MCP spec asks for that, and it is what
 * most clients hand to the model. Writes get a second, one-line text block
 * naming the run, so the model knows what `agent_revert` would undo.
 *
 * Failure: `isError: true` (a tool execution error, not a JSON-RPC protocol
 * error), so the model sees the CommandError code, the message and the
 * per-field issues and can correct its call. `structuredContent.error`
 * carries the same fields for clients that read structure.
 *
 * No `outputSchema` is declared on the tools: two command outputs are
 * unions (not a single object), and a client validating structured content
 * against an imprecise schema would turn a successful write into an error.
 */

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { toolNameForCommand, type CommandErrorCode, type CommandIssue } from '@narrative/commands'
import type { HostResult } from '../agent/serverHost.js'

export interface ToolErrorBody {
  code: CommandErrorCode
  message: string
  issues?: readonly CommandIssue[]
  opIndex?: number
  /**
   * `confirmation_required` from the out-of-band path (mcp/confirm.ts): the
   * page the user approves on, and the id to pass back as `confirmationId`.
   */
  confirmation?: { confirmationId: string; url: string; expiresAt: string }
}

function issuePath(path: ReadonlyArray<PropertyKey>): string {
  return path.length === 0 ? '(input)' : path.map((p) => String(p)).join('.')
}

export function errorResult(
  error: ToolErrorBody,
  extra: { runId?: string | null } = {},
): CallToolResult {
  const lines = [`Error (${error.code}): ${error.message}`]
  for (const issue of error.issues ?? []) lines.push(`- ${issuePath(issue.path)}: ${issue.message}`)
  return {
    isError: true,
    content: [{ type: 'text', text: lines.join('\n') }],
    structuredContent: {
      error: {
        code: error.code,
        message: error.message,
        issues: (error.issues ?? []).map((i) => ({
          path: i.path.map((p) => (typeof p === 'number' ? p : String(p))),
          message: i.message,
        })),
        ...(error.opIndex === undefined ? {} : { opIndex: error.opIndex }),
        ...(error.confirmation === undefined ? {} : { confirmation: error.confirmation }),
      },
      ...(extra.runId ? { runId: extra.runId } : {}),
    },
  }
}

function asStructured(value: unknown): Record<string, unknown> {
  // Structured content must be a JSON object; every command output is one
  // today, but a scalar or array output would be wrapped rather than lost.
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : { result: value }
}

export function hostResultToToolResult(
  outcome: HostResult,
  opts: { write: boolean },
): CallToolResult {
  if (!outcome.ok) return errorResult(outcome.error, { runId: outcome.runId })
  const content: CallToolResult['content'] = [
    { type: 'text', text: JSON.stringify(outcome.result ?? null) },
  ]
  if (opts.write && outcome.runId !== null) {
    content.push({
      type: 'text',
      text:
        `Applied in run ${outcome.runId}` +
        (outcome.seq === null ? '' : ` (step ${outcome.seq})`) +
        `. ${toolNameForCommand('agent.revert')} undoes the run or its last steps.`,
    })
  }
  return { content, structuredContent: asStructured(outcome.result) }
}
