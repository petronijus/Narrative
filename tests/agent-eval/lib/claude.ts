/**
 * tests/agent-eval/lib/claude.ts — drives headless Claude Code as the agent.
 *
 * One `claude -p` process per scenario, fed through `--input-format
 * stream-json`, so a multi-step scenario ("do X" … "undo what you just
 * did") is ONE conversation and ONE MCP session — exactly what a person in
 * Claude Code has — without persisting a session to resume.
 *
 * Isolation (measured 2026-09-27: a bare `claude -p` on a developer machine
 * loads the user's plugins, skills, hooks, CLAUDE.md, claude.ai connectors
 * and MCP servers — 208 tools and ~208k context tokens before the first
 * word; user hooks such as a git autosync would run per scenario):
 *   --strict-mcp-config --mcp-config <file>   only the Narrative server
 *   --setting-sources project                 no user settings, plugins, hooks, CLAUDE.md
 *   --disable-slash-commands                  no skills
 *   --tools ListMcpResourcesTool,ReadMcpResourceTool,ToolSearch
 *                                             no built-ins but resource reads (the
 *                                             server's instructions point at
 *                                             narrative://playbooks/basics) and
 *                                             ToolSearch — with it Claude Code defers
 *                                             MCP tools (names only, a schema loaded on
 *                                             demand) exactly as in a user's session,
 *                                             so the eval sees Narrative the way
 *                                             people do and does not pay the whole
 *                                             tool list on every request (measured
 *                                             2026-09-28, probes/listChanged.ts)
 *   ENABLE_CLAUDEAI_MCP_SERVERS=false         no claude.ai connectors
 *   --no-session-persistence                  nothing written to ~/.claude/projects
 * The MCP config names the token as `${NARRATIVE_EVAL_TOKEN}`, which Claude
 * Code expands from the environment, so the secret never touches disk.
 * (docs/mcp.md registers with `claude mcp add --scope local`; that writes
 * the token into ~/.claude.json and leaves the user's other servers loaded,
 * so the eval uses the equivalent `--mcp-config` instead.)
 */

import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { MCP_SERVER_NAME } from './mcpNames.js'
import { TranscriptBuilder, type InitInfo } from './transcript.js'
import type { Transcript, Usage } from './types.js'

export const DEFAULT_STEP_TIMEOUT_MS = 8 * 60_000
const KILL_GRACE_MS = 5_000
const STDERR_TAIL = 4000

export interface AgentRunOptions {
  mcpUrl: string
  /** The `mcp`-scoped access token (passed through the environment only). */
  mcpToken: string
  model: string
  maxTurns: number
  steps: readonly string[]
  stepTimeoutMs: number
  maxBudgetUsd?: number
  /** Called after step `index` finished and before the next one is sent. */
  betweenSteps?: (index: number) => Promise<void>
  /** Echo each tool call as it happens. */
  onToolCall?: (line: string) => void
}

export interface AgentRunResult {
  transcript: Transcript
  init: InitInfo | null
  turns: number
  toolCalls: number
  /** As Claude Code reports it (list-price equivalent on a subscription). */
  costUsd: number | null
  usage: Usage
  durationMs: number
  exitCode: number | null
  stderrTail: string
  permissionDenials: unknown[]
  warnings: string[]
  /** The MCP server failed to connect at start (the stack was down or restarting). */
  mcpUnavailable: boolean
}

export async function claudeVersion(): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn('claude', ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    p.stdout.on('data', (d: Buffer) => (out += d.toString()))
    p.on('error', reject)
    p.on('exit', (code) =>
      code === 0 ? resolve(out.trim()) : reject(new Error(`claude --version exited ${code}`)),
    )
  })
}

export async function runAgent(opts: AgentRunOptions): Promise<AgentRunResult> {
  const dir = await mkdtemp(path.join(tmpdir(), 'narrative-agent-eval-'))
  const mcpConfig = path.join(dir, 'mcp.json')
  await writeFile(
    mcpConfig,
    JSON.stringify({
      mcpServers: {
        [MCP_SERVER_NAME]: {
          type: 'http',
          url: opts.mcpUrl,
          headers: { Authorization: 'Bearer ${NARRATIVE_EVAL_TOKEN}' },
        },
      },
    }),
    { mode: 0o600 },
  )
  const builtInTools = 'ListMcpResourcesTool,ReadMcpResourceTool,ToolSearch'
  const args = [
    '-p',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--model',
    opts.model,
    '--max-turns',
    String(opts.maxTurns),
    '--strict-mcp-config',
    '--mcp-config',
    mcpConfig,
    '--setting-sources',
    'project',
    '--disable-slash-commands',
    '--no-session-persistence',
    '--tools',
    builtInTools,
    '--allowedTools',
    `mcp__${MCP_SERVER_NAME}__*,${builtInTools}`,
    ...(opts.maxBudgetUsd !== undefined ? ['--max-budget-usd', String(opts.maxBudgetUsd)] : []),
  ]
  const started = Date.now()
  const builder = new TranscriptBuilder(MCP_SERVER_NAME, (call) =>
    opts.onToolCall?.(`${call.tool}${call.isError ? ` -> error ${call.errorCode ?? ''}` : ''}`),
  )
  const child = spawn('claude', args, {
    cwd: dir,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      NARRATIVE_EVAL_TOKEN: opts.mcpToken,
      ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
    },
  })
  let stderr = ''
  child.stderr.on('data', (d: Buffer) => {
    stderr = (stderr + d.toString()).slice(-STDERR_TAIL)
  })
  const permissionDenials: unknown[] = []
  let stepIndex = 0
  let stepTimer: NodeJS.Timeout | null = null
  let finished = false

  const exited = new Promise<number | null>((resolve) => {
    child.on('exit', (code) => resolve(code))
    child.on('error', (err) => {
      stderr += `\nspawn error: ${err.message}`
      resolve(null)
    })
  })

  const kill = (): void => {
    child.kill('SIGTERM')
    setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS).unref()
  }

  const send = (index: number): void => {
    const prompt = opts.steps[index]!
    builder.beginStep(prompt)
    if (stepTimer !== null) clearTimeout(stepTimer)
    stepTimer = setTimeout(() => {
      builder.abortStep(`timeout after ${Math.round(opts.stepTimeoutMs / 1000)} s`)
      finished = true
      kill()
    }, opts.stepTimeoutMs)
    child.stdin.write(
      `${JSON.stringify({ type: 'user', message: { role: 'user', content: prompt } })}\n`,
    )
  }

  const onResult = async (): Promise<void> => {
    if (stepTimer !== null) clearTimeout(stepTimer)
    const done = stepIndex
    stepIndex++
    if (stepIndex >= opts.steps.length) {
      finished = true
      child.stdin.end()
      return
    }
    try {
      await opts.betweenSteps?.(done)
    } catch (err) {
      builder.warnings.push(`between steps ${done} and ${done + 1}: ${(err as Error).message}`)
    }
    send(stepIndex)
  }

  let buffer = ''
  child.stdout.on('data', (d: Buffer) => {
    buffer += d.toString()
    let nl: number
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim()
      buffer = buffer.slice(nl + 1)
      if (line.length === 0) continue
      let event: unknown
      try {
        event = JSON.parse(line)
      } catch {
        builder.warnings.push(`unparseable output line: ${line.slice(0, 200)}`)
        continue
      }
      const before = builder.steps.length
      const result = builder.push(event)
      if (result !== null && builder.steps.length > before) {
        permissionDenials.push(...result.permissionDenials)
        void onResult()
      }
    }
  })

  send(0)
  const exitCode = await exited
  if (stepTimer !== null) clearTimeout(stepTimer)
  if (!finished) builder.abortStep(`claude exited (code ${exitCode}) before answering`)
  // Steps never sent (the process died early) are recorded as not run.
  while (builder.steps.length < opts.steps.length) {
    builder.beginStep(opts.steps[builder.steps.length]!)
    builder.abortStep('not sent (an earlier step failed)')
  }
  await rm(dir, { recursive: true, force: true })

  const steps = builder.steps
  const server = builder.init?.mcpServers.find((s) => s.name === MCP_SERVER_NAME)
  return {
    transcript: { steps },
    init: builder.init,
    turns: steps.reduce((n, s) => n + s.turns, 0),
    toolCalls: steps.reduce((n, s) => n + s.calls.length, 0),
    costUsd: builder.totalCostUsd,
    usage: builder.usage,
    durationMs: Date.now() - started,
    exitCode,
    stderrTail: stderr,
    permissionDenials,
    warnings: builder.warnings,
    mcpUnavailable:
      builder.init !== null &&
      (server === undefined || server.status === 'failed' || server.status === 'needs-auth'),
  }
}
