/**
 * tests/agent-eval/lib/transcript.ts — turns Claude Code's
 * `--output-format stream-json --verbose` event stream into a Transcript:
 * per user message, the tool calls (with their parsed Narrative results),
 * the final answer, turns, and the run's cost and token usage.
 *
 * Event shapes relied on (Claude Code 2.1.x):
 *   { type: 'system', subtype: 'init', model, tools, mcp_servers }
 *   { type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input } | { type: 'text' }] } }
 *   { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id, content, is_error }] } }
 *   { type: 'result', subtype, is_error, num_turns, result, total_cost_usd, usage, duration_ms }
 * `total_cost_usd` is cumulative over the process; `usage` is per message.
 */

import { narrativeToolName, commandIdFromTool } from './mcpNames.js'
import type { ToolCall, TranscriptStep, Usage } from './types.js'

const TEXT_LIMIT = 4000

interface PendingCall {
  qualified: string
  input: Record<string, unknown>
}

export interface InitInfo {
  model: string
  tools: string[]
  mcpServers: Array<{ name: string; status: string }>
}

export interface StepResultEvent {
  step: TranscriptStep
  /** Cumulative cost of the process so far, as Claude Code reports it. */
  totalCostUsd: number | null
  durationMs: number
  permissionDenials: unknown[]
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function toolResultText(content: unknown): string[] {
  if (typeof content === 'string') return [content]
  if (!Array.isArray(content)) return []
  return content
    .filter(isRecord)
    .filter((b) => b['type'] === 'text' && typeof b['text'] === 'string')
    .map((b) => b['text'] as string)
}

const ERROR_PREFIX = /^Error \(([a-z_]+)\)/

/** Parse one tool result the way the model saw it. */
export function parseToolResult(
  qualified: string,
  input: Record<string, unknown>,
  content: unknown,
  isErrorFlag: boolean,
  server?: string,
): ToolCall {
  const texts = toolResultText(content)
  const text = texts.join('\n')
  const tool = narrativeToolName(qualified, server)
  const errorMatch = ERROR_PREFIX.exec(texts[0] ?? '')
  const isError = isErrorFlag || errorMatch !== null
  let result: unknown = null
  if (tool !== null && !isError && texts[0] !== undefined) {
    try {
      result = JSON.parse(texts[0])
    } catch {
      result = null
    }
  }
  return {
    tool: tool ?? qualified,
    command: tool === null ? null : commandIdFromTool(tool),
    input,
    isError,
    errorCode: errorMatch?.[1] ?? null,
    result,
    text: text.length > TEXT_LIMIT ? `${text.slice(0, TEXT_LIMIT)}…` : text,
  }
}

function emptyUsage(): Usage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }
}

/** Incrementally builds the transcript from stream-json events. */
export class TranscriptBuilder {
  init: InitInfo | null = null
  readonly usage: Usage = emptyUsage()
  totalCostUsd: number | null = null
  readonly steps: TranscriptStep[] = []
  /** Unparseable lines and other oddities, for the report. */
  readonly warnings: string[] = []

  private readonly pending = new Map<string, PendingCall>()
  private calls: ToolCall[] = []
  private prompt = ''

  /**
   * @param server  the MCP server name the Narrative tools are registered under
   * @param onCall  called for every finished tool call, as it happens (live progress)
   */
  constructor(
    private readonly server?: string,
    private readonly onCall?: (call: ToolCall) => void,
  ) {}

  /** A new user message is about to be sent. */
  beginStep(prompt: string): void {
    this.prompt = prompt
    this.calls = []
  }

  /** Feed one parsed stream-json event; returns the finished step on a `result` event. */
  push(event: unknown): StepResultEvent | null {
    if (!isRecord(event)) return null
    const type = event['type']
    if (type === 'system' && event['subtype'] === 'init') {
      this.init = {
        model: String(event['model'] ?? ''),
        tools: Array.isArray(event['tools']) ? (event['tools'] as string[]) : [],
        mcpServers: Array.isArray(event['mcp_servers'])
          ? (event['mcp_servers'] as Array<{ name: string; status: string }>)
          : [],
      }
      return null
    }
    if (type === 'assistant' && isRecord(event['message'])) {
      const content = event['message']['content']
      if (Array.isArray(content)) {
        for (const block of content) {
          if (!isRecord(block) || block['type'] !== 'tool_use') continue
          this.pending.set(String(block['id']), {
            qualified: String(block['name']),
            input: isRecord(block['input']) ? block['input'] : {},
          })
        }
      }
      return null
    }
    if (type === 'user' && isRecord(event['message'])) {
      const content = event['message']['content']
      if (Array.isArray(content)) {
        for (const block of content) {
          if (!isRecord(block) || block['type'] !== 'tool_result') continue
          const id = String(block['tool_use_id'])
          const call = this.pending.get(id)
          if (call === undefined) {
            this.warnings.push(`tool_result for unknown tool_use ${id}`)
            continue
          }
          this.pending.delete(id)
          const parsed = parseToolResult(
            call.qualified,
            call.input,
            block['content'],
            block['is_error'] === true,
            this.server,
          )
          this.calls.push(parsed)
          this.onCall?.(parsed)
        }
      }
      return null
    }
    if (type === 'result') {
      const usage = isRecord(event['usage']) ? event['usage'] : {}
      const n = (k: string): number => (typeof usage[k] === 'number' ? (usage[k] as number) : 0)
      this.usage.inputTokens += n('input_tokens')
      this.usage.outputTokens += n('output_tokens')
      this.usage.cacheReadTokens += n('cache_read_input_tokens')
      this.usage.cacheCreationTokens += n('cache_creation_input_tokens')
      if (typeof event['total_cost_usd'] === 'number') this.totalCostUsd = event['total_cost_usd']
      // Calls whose result never arrived (the process stopped mid-turn).
      for (const [, call] of this.pending) {
        this.calls.push(
          parseToolResult(call.qualified, call.input, 'no result (interrupted)', true, this.server),
        )
      }
      this.pending.clear()
      const step: TranscriptStep = {
        prompt: this.prompt,
        calls: this.calls,
        finalText: typeof event['result'] === 'string' ? event['result'] : '',
        turns: typeof event['num_turns'] === 'number' ? event['num_turns'] : 0,
        isError: event['is_error'] === true,
        stopReason: String(event['subtype'] ?? 'unknown'),
      }
      this.steps.push(step)
      this.calls = []
      return {
        step,
        totalCostUsd: this.totalCostUsd,
        durationMs: typeof event['duration_ms'] === 'number' ? event['duration_ms'] : 0,
        permissionDenials: Array.isArray(event['permission_denials'])
          ? (event['permission_denials'] as unknown[])
          : [],
      }
    }
    return null
  }

  /** Close a step that never got its `result` event (timeout, crash). */
  abortStep(reason: string): TranscriptStep {
    for (const [, call] of this.pending) {
      this.calls.push(
        parseToolResult(call.qualified, call.input, 'no result (interrupted)', true, this.server),
      )
    }
    this.pending.clear()
    const step: TranscriptStep = {
      prompt: this.prompt,
      calls: this.calls,
      finalText: '',
      turns: 0,
      isError: true,
      stopReason: reason,
    }
    this.steps.push(step)
    this.calls = []
    return step
  }
}
