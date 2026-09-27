/**
 * tests/agent-eval/lib/mcpNames.ts — how an MCP tool call maps onto a
 * Narrative command invocation, per docs/mcp.md "Tools":
 *
 *   - tool name = command id with `.` → `_` (ids never contain `_`, so the
 *     mapping is reversible);
 *   - `deckId` / `componentId` / `folderId` arguments name the target;
 *   - `runId` attaches the call to a run — except for commands whose own
 *     input has a `runId` (agent.revert), where it is input (the general
 *     rule below: a key the command's input schema has is input);
 *   - `confirmationId` is the server-issued id of an out-of-band
 *     confirmation the user approved on Narrative's confirm page (clients
 *     that cannot show a confirmation question); a model can never confirm
 *     an irreversible command by itself.
 *
 * Kept independent of apps/server/src/mcp/tools.ts on purpose: the eval
 * checks the documented contract from the outside.
 */

import type { EvalTarget } from './types.js'

/** The server name the harness registers; tools arrive as `mcp__narrative-eval__<tool>`. */
export const MCP_SERVER_NAME = 'narrative-eval'

export function commandIdFromTool(tool: string): string {
  return tool.replace(/_/g, '.')
}

export function toolFromCommandId(command: string): string {
  return command.replace(/\./g, '_')
}

/**
 * Split a fully qualified Claude Code tool name into the MCP server's tool
 * name, or null when it is not one of the Narrative server's tools.
 */
export function narrativeToolName(qualified: string, server = MCP_SERVER_NAME): string | null {
  const prefix = `mcp__${server}__`
  return qualified.startsWith(prefix) ? qualified.slice(prefix.length) : null
}

export interface SplitInvocation {
  command: string
  target: EvalTarget
  input: Record<string, unknown>
  /** The run the call asked to attach to (not a command input). */
  runId: string | undefined
  /** Out-of-band confirmation id the call carries, if any. */
  confirmationId: string | undefined
}

const TARGET_KEYS = ['deckId', 'componentId', 'folderId'] as const

/**
 * Split a tool call's arguments into target, input and transport fields.
 * `inputKeys` names the top-level keys of the command's own input schema:
 * an id argument the command itself takes is input, not target
 * (`component.stamp` names the component to stamp with `componentId` while
 * its target is `deckId`; `component.get` targets `folderId`).
 */
export function splitToolArguments(
  tool: string,
  args: Record<string, unknown>,
  inputKeys: ReadonlySet<string>,
): SplitInvocation {
  const command = commandIdFromTool(tool)
  const target: EvalTarget = {}
  const input: Record<string, unknown> = {}
  let attach: string | undefined
  let confirmationId: string | undefined
  for (const [key, value] of Object.entries(args)) {
    if (inputKeys.has(key)) {
      input[key] = value
    } else if ((TARGET_KEYS as readonly string[]).includes(key) && typeof value === 'string') {
      target[key as (typeof TARGET_KEYS)[number]] = value
    } else if (key === 'runId' && typeof value === 'string') {
      attach = value
    } else if (key === 'confirmationId' && typeof value === 'string') {
      confirmationId = value
    } else {
      // Unknown keys stay in the input, so the command's validation rejects
      // them exactly as the server would.
      input[key] = value
    }
  }
  if (command === 'ops.apply' && Array.isArray(input['ops'])) {
    input['ops'] = (input['ops'] as Array<Record<string, unknown>>).map((op) =>
      typeof op['command'] === 'string' ? { ...op, command: commandIdFromTool(op['command']) } : op,
    )
  }
  return { command, target, input, runId: attach, confirmationId }
}
