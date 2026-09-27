/**
 * tests/agent-eval/probes/listChanged.ts — does a real MCP client pick up a
 * tool that appears mid-session (`notifications/tools/list_changed`), and
 * what does a Narrative-sized tool list cost it in context?
 *
 *   pnpm agent:probe:list-changed                 # the full matrix (~12 runs)
 *   pnpm agent:probe:list-changed --model sonnet  # default: haiku (client behaviour, not model quality)
 *   pnpm agent:probe:list-changed --only "no-toolsearch" --repeat 3
 *
 * It answers the question the A1 handoff left open before A2 ("defer the
 * table tools and announce them with list_changed?"). Findings from the first
 * run are in docs/handoff/A1-mcp-and-server-host.md, "Known TODO".
 *
 * How: an in-process MCP server with Narrative's transport shape (stateful
 * Streamable HTTP, one session per client) exposes `probe_ping` and
 * `probe_enable_tables`. Calling the latter adds `table_probe`, which returns a
 * code word, and sends `tools/list_changed` either on the session's standalone
 * GET stream or on the tools/call response stream. Headless Claude Code is
 * driven turn by turn (the next prompt goes in only after the previous turn's
 * `result`), isolated like the eval (lib/claude.ts), in two tool setups:
 *   - `no-toolsearch`: `--tools ""` — no built-in tools, as the eval runs;
 *   - `toolsearch`:    Claude Code's default tools, as a user's session has
 *     them — MCP tools are then deferred behind ToolSearch.
 * `--fillers N` pads the list with N ≈ 1.7 KB tools (86 ≈ Narrative's 148 KB).
 *
 * Costs subscription usage (a few cents per run on haiku). Needs the `claude`
 * CLI; does not need the dev stack.
 */

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

type Route = 'standalone' | 'related'
type ToolSetup = 'toolsearch' | 'no-toolsearch'

const CODE_WORD = 'PELICAN-42'
const SERVER = 'probe'
const TABLE_TOOL = `mcp__${SERVER}__table_probe`
const ENABLE_TOOL = `mcp__${SERVER}__probe_enable_tables`

// ── The probe server ─────────────────────────────────────────────────────────

interface ServerEvents {
  listCalls: string[][]
  calls: string[]
  getStreams: number
}

const objectSchema = (properties: Record<string, unknown> = {}) => ({
  type: 'object' as const,
  properties,
  additionalProperties: false,
})

function fillerTools(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    name: `filler_${i}`,
    description: `Filler tool ${i}. ` + 'Adjusts a property of an object on a slide. '.repeat(14),
    inputSchema: objectSchema(
      Object.fromEntries(
        Array.from({ length: 12 }, (_, k) => [
          `field_${k}`,
          { type: 'string', description: `Field ${k} of filler ${i}, a short value.` },
        ]),
      ),
    ),
  }))
}

function createProbeServer(route: Route, fillers: number, events: ServerEvents): Server {
  let tablesEnabled = false
  const server = new Server(
    { name: 'list-changed-probe', version: '1.0.0' },
    { capabilities: { tools: { listChanged: true } } },
  )
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = [
      { name: 'probe_ping', description: 'Returns pong.', inputSchema: objectSchema() },
      {
        name: 'probe_enable_tables',
        description:
          'Enables the table tools. After calling it, a new tool named table_probe becomes available.',
        inputSchema: objectSchema(),
      },
      ...fillerTools(fillers),
      ...(tablesEnabled
        ? [
            {
              name: 'table_probe',
              description: 'Returns the table code word.',
              inputSchema: objectSchema(),
            },
          ]
        : []),
    ]
    events.listCalls.push(tools.map((t) => t.name).filter((n) => !n.startsWith('filler_')))
    return { tools }
  })
  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    const name = req.params.name
    events.calls.push(name)
    if (name === 'probe_ping') return { content: [{ type: 'text', text: 'pong' }] }
    if (name === 'probe_enable_tables') {
      tablesEnabled = true
      const notification = { method: 'notifications/tools/list_changed' as const }
      if (route === 'related') await extra.sendNotification(notification)
      else await server.notification(notification)
      return {
        content: [{ type: 'text', text: 'Table tools enabled: table_probe is now available.' }],
      }
    }
    if (name === 'table_probe' && tablesEnabled) {
      return { content: [{ type: 'text', text: `code word: ${CODE_WORD}` }] }
    }
    return { isError: true, content: [{ type: 'text', text: `unavailable tool ${name}` }] }
  })
  return server
}

async function startProbeServer(route: Route, fillers: number) {
  const events: ServerEvents = { listCalls: [], calls: [], getStreams: 0 }
  const sessions = new Map<string, StreamableHTTPServerTransport>()
  const httpServer = http.createServer((req, res) => {
    void (async () => {
      const sessionId = req.headers['mcp-session-id']
      let body: unknown
      if (req.method === 'POST') {
        const chunks: Buffer[] = []
        for await (const chunk of req) chunks.push(chunk as Buffer)
        body = JSON.parse(Buffer.concat(chunks).toString() || 'null')
      }
      let transport: StreamableHTTPServerTransport | undefined =
        typeof sessionId === 'string' ? sessions.get(sessionId) : undefined
      if (!transport) {
        const isInitialize = (body as { method?: string } | null)?.method === 'initialize'
        if (req.method !== 'POST' || !isInitialize) {
          res.writeHead(404).end()
          return
        }
        const fresh: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id: string): void => {
            sessions.set(id, fresh)
          },
        })
        // The SDK types its transport's optional handlers `| undefined`, which
        // `exactOptionalPropertyTypes` rejects against its own Transport
        // interface; same cast as apps/server/src/mcp/sessions.ts.
        await createProbeServer(route, fillers, events).connect(fresh as unknown as Transport)
        transport = fresh
      }
      if (req.method === 'GET') events.getStreams++
      await transport.handleRequest(req, res, body)
    })().catch((err: unknown) => {
      if (!res.headersSent) res.writeHead(500)
      res.end(String(err))
    })
  })
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve))
  const { port } = httpServer.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    events,
    close: () =>
      new Promise<void>((resolve) => {
        for (const t of sessions.values()) void t.close()
        httpServer.closeAllConnections()
        httpServer.close(() => resolve())
      }),
  }
}

// ── Driving Claude Code turn by turn ─────────────────────────────────────────

interface TurnLog {
  toolCalls: string[]
  toolErrors: string[]
  answers: string[]
  contextTokens: number[]
}

async function driveClaude(
  url: string,
  setup: ToolSetup,
  model: string,
  prompts: string[],
): Promise<TurnLog> {
  const dir = await mkdtemp(path.join(tmpdir(), 'narrative-probe-'))
  const mcpConfig = path.join(dir, 'mcp.json')
  await writeFile(mcpConfig, JSON.stringify({ mcpServers: { [SERVER]: { type: 'http', url } } }))
  const args = [
    '-p',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--model',
    model,
    '--max-turns',
    '8',
    '--strict-mcp-config',
    '--mcp-config',
    mcpConfig,
    '--setting-sources',
    'project',
    '--disable-slash-commands',
    '--no-session-persistence',
    ...(setup === 'no-toolsearch' ? ['--tools', ''] : []),
    '--allowedTools',
    `mcp__${SERVER}__*`,
  ]
  const log: TurnLog = { toolCalls: [], toolErrors: [], answers: [], contextTokens: [] }
  const child = spawn('claude', args, {
    cwd: dir,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ENABLE_CLAUDEAI_MCP_SERVERS: 'false' },
  })
  const send = (text: string) =>
    child.stdin.write(
      JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n',
    )
  let next = 0
  send(prompts[next++]!)
  const timer = setTimeout(() => child.kill('SIGTERM'), 300_000)
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    let ev: Record<string, unknown>
    try {
      ev = JSON.parse(line) as Record<string, unknown>
    } catch {
      return
    }
    const content = (ev['message'] as { content?: unknown[] } | undefined)?.content ?? []
    for (const block of content as Array<Record<string, unknown>>) {
      if (ev['type'] === 'assistant' && block['type'] === 'tool_use')
        log.toolCalls.push(String(block['name']))
      if (ev['type'] === 'user' && block['type'] === 'tool_result' && block['is_error'] === true) {
        log.toolErrors.push(JSON.stringify(block['content']).slice(0, 120))
      }
    }
    if (ev['type'] !== 'result') return
    log.answers.push(String(ev['result'] ?? '').slice(0, 80))
    const usage = (ev['usage'] ?? {}) as Record<string, number>
    log.contextTokens.push(
      (usage['input_tokens'] ?? 0) +
        (usage['cache_creation_input_tokens'] ?? 0) +
        (usage['cache_read_input_tokens'] ?? 0),
    )
    if (next < prompts.length) send(prompts[next++]!)
    else child.stdin.end()
  })
  await new Promise<void>((resolve) => child.on('exit', () => resolve()))
  clearTimeout(timer)
  await rm(dir, { recursive: true, force: true })
  return log
}

// ── Scenarios ────────────────────────────────────────────────────────────────

const SAME_TURN = [
  `Call ${ENABLE_TOOL}. Then call ${TABLE_TOOL} (it becomes available after the first call) and reply with the code word it returns. If calling ${TABLE_TOOL} fails, reply NOT_AVAILABLE.`,
]
const NEXT_TURN = [
  `Call ${ENABLE_TOOL} and then stop; reply OK.`,
  `Now call ${TABLE_TOOL} and reply with the code word it returns. If calling it fails, reply NOT_AVAILABLE.`,
]
const PING = [`Call mcp__${SERVER}__probe_ping and reply with its result.`]

interface Row {
  case: string
  refetched: boolean
  newToolWorked: boolean
  errors: string
  contextTokens: string
}

async function runCase(
  label: string,
  route: Route,
  setup: ToolSetup,
  fillers: number,
  prompts: string[],
  model: string,
): Promise<Row> {
  const server = await startProbeServer(route, fillers)
  try {
    const log = await driveClaude(server.url, setup, model, prompts)
    return {
      case: label,
      refetched: server.events.listCalls.some((names) => names.includes('table_probe')),
      newToolWorked:
        server.events.calls.includes('table_probe') &&
        log.answers.some((a) => a.includes(CODE_WORD)),
      errors: log.toolErrors.join(' | ') || '-',
      contextTokens: log.contextTokens.join(' / '),
    }
  } finally {
    await server.close()
  }
}

interface Case {
  label: string
  route: Route
  setup: ToolSetup
  fillers: number
  prompts: string[]
}

function allCases(): Case[] {
  const cases: Case[] = []
  for (const setup of ['no-toolsearch', 'toolsearch'] as const) {
    for (const route of ['standalone', 'related'] as const) {
      cases.push({
        label: `${setup} ${route} same-turn`,
        route,
        setup,
        fillers: 0,
        prompts: SAME_TURN,
      })
      cases.push({
        label: `${setup} ${route} next-turn`,
        route,
        setup,
        fillers: 0,
        prompts: NEXT_TURN,
      })
    }
    cases.push({
      label: `${setup} ping, 0 fillers`,
      route: 'standalone',
      setup,
      fillers: 0,
      prompts: PING,
    })
    cases.push({
      label: `${setup} ping, 86 fillers (≈148 KB)`,
      route: 'standalone',
      setup,
      fillers: 86,
      prompts: PING,
    })
  }
  return cases
}

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i > 0 ? process.argv[i + 1] : undefined
}

async function main() {
  const model = flag('--model') ?? 'haiku'
  const only = flag('--only') // prefix of a case label, e.g. "toolsearch" or "no-toolsearch related"
  const repeat = Number(flag('--repeat') ?? 1)
  const rows: Row[] = []
  for (const c of allCases().filter((c) => only === undefined || c.label.startsWith(only))) {
    for (let run = 1; run <= repeat; run++) {
      const label = repeat > 1 ? `${c.label} #${run}` : c.label
      rows.push(await runCase(label, c.route, c.setup, c.fillers, c.prompts, model))
    }
  }
  console.log(`claude ${model} — list_changed probe`)
  console.table(rows)
}

await main()
