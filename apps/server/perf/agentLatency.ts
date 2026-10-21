/**
 * perf/agentLatency.ts — what an agent's command costs on the real stack,
 * phase by phase (docs/plans/performance.md → G7). No LLM: the probe is the
 * client. Where `just perf-commands` (perf/commands.ts) drives the
 * ServerHost in its own process, this one talks HTTP to a running server —
 * the command API (`POST /commands`) and MCP (streamable HTTP, `/mcp`, the
 * SDK's own client) — with a personal access token it makes for the run and
 * revokes at the end, so authentication, body parsing, the MCP transport and
 * response serialisation are in the numbers.
 *
 *   just perf-agent [--sizes 10,100] [--surfaces api,mcp] [--runs 15] [--warmup 3] [--cold 8]
 *                   [--render-runs 6] [--render-cold 4] [--sessions 6] [--no-render]
 *                   [--only <bench id substring>] [--no-store] [--json out.json]
 *
 * The decks are SCENES.deck10 / deck100 (packages/perf scenes.ts → deckOps:
 * 6 texts, 4 rectangles and 2 of the six harness photos per slide), seeded
 * once per size through the command API as a synthetic person
 * (`narrative_dev_as=dev-perf-agent`, BYPASS_AUTH), and copied with
 * deck.duplicate: a copy is a stored row nobody has loaded, which is what a
 * cold call needs. Every deck and the token are deleted at the end, also on
 * Ctrl-C.
 *
 * The fixed set (catalog/server.ts → AGENT_COMMANDS), interleaved per round
 * across surfaces and commands so a drift of the machine lands on all:
 *   query.deck, query.slide {index k}, object.update (x of rectangle s<k>-r0),
 *   object.create (a rectangle), ops.apply (10 object.update), query.render
 * on slides 1… (never the first: a change there redraws the deck's card in
 * the background, services/deckThumbnails.ts).
 *   warm  N runs after W warm-ups on one deck per surface and size;
 *   cold  one call on a fresh copy (query.deck, object.update, query.render);
 *         a cold write is then followed until the deck's next snapshot row is
 *         in Postgres (`durable`: the sync server's 2 s debounce plus the
 *         store), and the copy is deleted before its card would be drawn.
 * Before the warm runs each warm deck gets one write and the render queue is
 * waited on until quiet, so their card pictures are drawn before, not during.
 *
 * Per call: the client's wall time, the server's phases (the request asks
 * for them with `x-narrative-timing: 1`; observability/phases.ts — the
 * command API answers them in `Server-Timing`, MCP in the tool result's
 * `_meta`) — for query.render also the job's queue wait, the worker's time
 * and the worker's own steps. Results go to the perf harness's
 * store (~/.cache/narrative-perf/<machine>/results.jsonl, one bench per
 * surface × command × temperature × size, fingerprinted) and are compared
 * with this machine's baseline when there is one (`just perf-accept <id…>`
 * makes one); a details file keeps the response sizes and every sample.
 * PERF_VERBOSE=1 prints every call's phases as it is recorded.
 *
 * Token hygiene: the run's token is revoked however the run ends (signals,
 * a crash; a second signal during cleanup is ignored), and a run revokes the
 * `perf-agent …` tokens an earlier one left behind. PERF_API must be on this
 * machine (localhost) unless `--allow-remote`.
 *
 * Environment: PERF_API (default http://localhost:3001), PERF_ORIGIN (the
 * origin the API admits, default http://localhost:5173), MEDIA_REDIS_URL
 * (default redis://127.0.0.1:6380), POSTGRES_URL (from .env, read-only
 * polling of deck_updates), SERVER_TIMING_KEY (sent as `x-narrative-timing`
 * when set; else `1`). The server must time requests: a non-production one
 * without a key does; with SERVER_TIMING_KEY set, only requests carrying it.
 *
 * Excluded from the build (tsconfig.build.json).
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { parseArgs } from 'node:util'
import { Queue, QueueEvents } from 'bullmq'
import { Redis as IORedis } from 'ioredis'
import pg from 'pg'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { toolNameForCommand } from '@narrative/commands'
import { RENDER_QUEUE, type RenderJobData } from '@narrative/shared'
import {
  AGENT_BENCHES,
  AGENT_COMMANDS,
  API_LAPS,
  HOST_SPANS,
  MCP_LAPS,
  MCP_SESSION_BENCH_ID,
  RENDER_SPANS,
  agentBenchId,
  comparability,
  compareResults,
  deckOps,
  fmt,
  formatComparisons,
  formatFingerprint,
  resultFrom,
  type AgentCommand,
  type AgentSurface,
  type BenchDef,
  type BenchResult,
} from '@narrative/perf'
import { collectFingerprint, machineName, openResultStore, photoFiles } from '@narrative/perf/node'
import {
  MCP_TIMING_META_KEY,
  TIMING_REQUEST_HEADER,
  parseServerTiming,
} from '../src/observability/phases.js'

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

const { values: args } = parseArgs({
  options: {
    sizes: { type: 'string', default: '10,100' },
    surfaces: { type: 'string', default: 'api,mcp' },
    runs: { type: 'string', default: '15' },
    warmup: { type: 'string', default: '3' },
    cold: { type: 'string', default: '8' },
    'render-runs': { type: 'string', default: '6' },
    'render-cold': { type: 'string', default: '4' },
    sessions: { type: 'string', default: '6' },
    'no-render': { type: 'boolean', default: false },
    only: { type: 'string' },
    'no-store': { type: 'boolean', default: false },
    'allow-remote': { type: 'boolean', default: false },
    json: { type: 'string' },
  },
})

const API = process.env['PERF_API'] ?? 'http://localhost:3001'
/**
 * What the probe sends in `x-narrative-timing`: the server's
 * SERVER_TIMING_KEY when one is configured (the same .env), else `1` — what a
 * server without a key accepts outside production (observability/phases.ts).
 */
const TIMING_VALUE = process.env['SERVER_TIMING_KEY'] || '1'
/** The name prefix of the probe's tokens: a run's leftover is revoked by the next. */
const TOKEN_PREFIX = 'perf-agent '

// The probe makes a personal access token and writes decks as a synthetic
// person: only against this machine's own server unless asked for.
{
  const host = new URL(API).hostname
  const loopback = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(host)
  if (!loopback && !args['allow-remote']) {
    console.error(
      `PERF_API is ${API}: the probe runs against a server on this machine (localhost) ` +
        'unless --allow-remote is given',
    )
    process.exit(2)
  }
}
const ORIGIN = process.env['PERF_ORIGIN'] ?? 'http://localhost:5173'
const REDIS_URL = process.env['MEDIA_REDIS_URL'] ?? 'redis://127.0.0.1:6380'
const PERSON = 'dev-perf-agent'
const SIZES = args.sizes.split(',').map((s) => Number.parseInt(s, 10))
const SURFACES = args.surfaces.split(',') as AgentSurface[]
const RUNS = Number.parseInt(args.runs, 10)
const WARMUP = Number.parseInt(args.warmup, 10)
const COLD = Number.parseInt(args.cold, 10)
const RENDER_RUNS = Number.parseInt(args['render-runs'], 10)
const RENDER_COLD = Number.parseInt(args['render-cold'], 10)
const SESSIONS = Number.parseInt(args.sessions, 10)
const RENDER = !args['no-render']
/** PERF_VERBOSE=1: every call's phases as it is recorded. */
const VERBOSE = process.env['PERF_VERBOSE'] === '1'
/** ops.apply takes at most 500 ops per call. */
const OPS_PER_BATCH = 400
/** How long the render queue must be quiet before the warm runs start. */
const QUIET_MS = 4_000

for (const s of SIZES)
  if (s !== 10 && s !== 100) throw new Error(`--sizes: 10 and/or 100, not ${s}`)
for (const s of SURFACES)
  if (s !== 'api' && s !== 'mcp') throw new Error(`--surfaces: api and/or mcp, not ${s}`)

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------------------
// The person's own API (seeding, copies, cleanup): BYPASS_AUTH's synthetic people
// ---------------------------------------------------------------------------

async function asPerson<T>(method: string, route: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API}${route}`, {
    method,
    headers: {
      Origin: ORIGIN,
      Cookie: `narrative_dev_as=${PERSON}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`${method} ${route}: ${res.status} ${text.slice(0, 300)}`)
  return (text === '' ? undefined : JSON.parse(text)) as T
}

async function personCommand<T>(deckId: string, command: string, input: unknown): Promise<T> {
  const body = await asPerson<{ ok: boolean; result: T; error?: { message: string } }>(
    'POST',
    '/commands',
    { target: { deckId }, command, input },
  )
  if (!body.ok) throw new Error(`${command}: ${body.error?.message}`)
  return body.result
}

const decksToDelete = new Set<string>()

async function deleteDeck(deckId: string): Promise<void> {
  decksToDelete.delete(deckId)
  await asPerson('DELETE', `/decks/${deckId}`).catch((err: unknown) =>
    console.error(`  could not delete deck ${deckId}: ${String(err)}`),
  )
}

/** The scene's deck: created, the six photos uploaded, deckOps applied. */
async function seedScene(slides: number): Promise<string> {
  const { id } = await asPerson<{ id: string }>('POST', '/decks', {
    title: `perf agent ${slides} slides`,
  })
  decksToDelete.add(id)
  const assets: string[] = []
  for (const file of photoFiles()) {
    const r = await personCommand<{ assetId: string }>(id, 'media.upload', {
      file: { base64: readFileSync(file).toString('base64'), filename: path.basename(file) },
    })
    assets.push(r.assetId)
  }
  const { ops } = deckOps(slides, assets)
  for (let i = 0; i < ops.length; i += OPS_PER_BATCH)
    await personCommand(id, 'ops.apply', { ops: ops.slice(i, i + OPS_PER_BATCH) })
  return id
}

/** A copy of the scene nobody has loaded (deck.duplicate writes its first row and loads nothing). */
async function copyOf(sceneId: string, label: string): Promise<string> {
  const copy = await personCommand<{ id: string }>(sceneId, 'deck.duplicate', {
    title: `perf agent ${label}`,
  })
  decksToDelete.add(copy.id)
  return copy.id
}

// ---------------------------------------------------------------------------
// The personal access token of the run
// ---------------------------------------------------------------------------

interface RunToken {
  id: string
  secret: string
}

/** Revoke the tokens an earlier run left behind (it was killed before its cleanup). */
async function revokeLeftoverTokens(): Promise<number> {
  const { tokens } = await asPerson<{ tokens: Array<{ id: string; name: string }> }>(
    'GET',
    '/access-tokens',
  )
  const leftovers = tokens.filter((t) => t.name.startsWith(TOKEN_PREFIX))
  for (const t of leftovers) await asPerson('DELETE', `/access-tokens/${t.id}`)
  return leftovers.length
}

async function createToken(): Promise<RunToken> {
  const r = await asPerson<{ token: string; accessToken: { id: string } }>(
    'POST',
    '/access-tokens',
    {
      name: `${TOKEN_PREFIX}${new Date().toISOString()}`,
      scopes: ['api', 'mcp'],
      expiresInDays: 30,
    },
  )
  return { id: r.accessToken.id, secret: r.token }
}

// ---------------------------------------------------------------------------
// One call, either surface
// ---------------------------------------------------------------------------

interface CallSample {
  /** Client wall time, ms. */
  total: number
  /** The server's phases (laps and spans). */
  phases: Record<string, number>
  /** Bytes of the response body (API) or of the tool result's JSON (MCP). */
  bytes: number
}

/** The input of `command.name` for call `i` on a deck of `slides` slides. */
function inputFor(command: AgentCommand, i: number, slides: number): unknown {
  // Never slide 0 (see the file header).
  const k = 1 + (i % (slides - 1))
  const slide = { index: k }
  switch (command.name) {
    case 'queryDeck':
      return {}
    case 'querySlide':
      return { slide }
    case 'objectUpdate':
      return { slide, object: `s${k}-r0`, patch: { x: 80 + (i % 40) } }
    case 'objectCreate':
      return {
        slide,
        object: { type: 'rectangle', x: 40 + (i % 30) * 10, y: 40, width: 60, height: 60 },
      }
    case 'opsApply':
      return {
        ops: Array.from({ length: 10 }, (_, j) => {
          const s = 1 + ((i * 10 + j) % (slides - 1))
          return {
            command: 'object.update',
            input: { slide: { index: s }, object: `s${s}-r1`, patch: { y: 700 + ((i + j) % 90) } },
          }
        }),
      }
    case 'queryRender':
      return { slide }
    default:
      throw new Error(`no input for ${command.name}`)
  }
}

interface Caller {
  call(deckId: string, command: string, input: unknown): Promise<CallSample>
  close(): Promise<void>
}

function apiCaller(token: RunToken): Caller {
  return {
    async call(deckId, command, input) {
      const body = JSON.stringify({ target: { deckId }, command, input, client: 'perf-agent' })
      const t0 = performance.now()
      const res = await fetch(`${API}/commands`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token.secret}`,
          'content-type': 'application/json',
          [TIMING_REQUEST_HEADER]: TIMING_VALUE,
        },
        body,
      })
      const text = await res.text()
      const total = performance.now() - t0
      const parsed = JSON.parse(text) as { ok: boolean; error?: { code: string; message: string } }
      if (!parsed.ok)
        throw new Error(
          `api ${command}: ${res.status} ${parsed.error?.code} ${parsed.error?.message}`,
        )
      const phases = parseServerTiming(res.headers.get('server-timing'))
      if (Object.keys(phases).length === 0)
        throw new Error(
          'the server answered without Server-Timing: it does not time requests (production without SERVER_TIMING_KEY, or a key other than the one in this .env?)',
        )
      return { total, phases, bytes: Buffer.byteLength(text) }
    },
    async close() {},
  }
}

interface McpConnection {
  client: Client
  transport: StreamableHTTPClientTransport
}

async function mcpConnect(token: RunToken): Promise<McpConnection & { initialize: number }> {
  const transport = new StreamableHTTPClientTransport(new URL(`${API}/mcp`), {
    requestInit: {
      headers: { authorization: `Bearer ${token.secret}`, [TIMING_REQUEST_HEADER]: TIMING_VALUE },
    },
  })
  const client = new Client({ name: 'narrative-perf', version: '1' }, { capabilities: {} })
  const t0 = performance.now()
  // The SDK's transport declares optional members without `| undefined` (see mcp/sessions.ts).
  await client.connect(transport as unknown as Transport)
  return { client, transport, initialize: performance.now() - t0 }
}

async function mcpClose(c: McpConnection): Promise<void> {
  await c.transport.terminateSession().catch(() => undefined)
  await c.client.close().catch(() => undefined)
}

async function mcpCaller(token: RunToken): Promise<Caller> {
  const connection = await mcpConnect(token)
  await connection.client.listTools()
  return {
    async call(deckId, command, input) {
      const t0 = performance.now()
      const result = await connection.client.callTool({
        name: toolNameForCommand(command),
        arguments: { deckId, ...(input as Record<string, unknown>) },
      })
      const total = performance.now() - t0
      if (result.isError === true)
        throw new Error(`mcp ${command}: ${JSON.stringify(result.content).slice(0, 300)}`)
      const meta = (result._meta ?? {}) as Record<string, unknown>
      const phases = (meta[MCP_TIMING_META_KEY] ?? null) as Record<string, number> | null
      if (phases === null)
        throw new Error(
          'the tool result carries no server timing: the server does not time requests (production without SERVER_TIMING_KEY, or a key other than the one in this .env?)',
        )
      return { total, phases, bytes: Buffer.byteLength(JSON.stringify(result)) }
    },
    close: () => mcpClose(connection),
  }
}

// ---------------------------------------------------------------------------
// The render queue, watched (as apps/render-worker/perf/render.ts does)
// ---------------------------------------------------------------------------

/**
 * The render queue (media Redis), for one thing: waiting until it is quiet
 * before the warm runs, so background card pictures are drawn before, not
 * during, a measurement. A look's queue wait and worker time come from the
 * server (render/queue.ts records them as phases of a timed request).
 */
class RenderWatch {
  private readonly connection = new IORedis(REDIS_URL, { maxRetriesPerRequest: null })
  private readonly eventsConnection = new IORedis(REDIS_URL, { maxRetriesPerRequest: null })
  private readonly queue = new Queue<RenderJobData>(RENDER_QUEUE, { connection: this.connection })
  private readonly events = new QueueEvents(RENDER_QUEUE, { connection: this.eventsConnection })
  private lastEvent = Date.now()

  constructor() {
    for (const event of ['added', 'waiting', 'active', 'completed', 'failed'] as const)
      this.events.on(event, () => {
        this.lastEvent = Date.now()
      })
  }

  async ready(): Promise<void> {
    await this.events.waitUntilReady()
  }

  /** Until nothing has been added, started or finished for QUIET_MS and nothing runs. */
  async untilQuiet(timeoutMs = 120_000): Promise<void> {
    const stop = Date.now() + timeoutMs
    for (;;) {
      const busy = await this.queue.getJobCountByTypes('active', 'waiting', 'prioritized')
      if (busy === 0 && Date.now() - this.lastEvent >= QUIET_MS) return
      if (Date.now() > stop) throw new Error('the render queue did not go quiet')
      await sleep(250)
    }
  }

  async close(): Promise<void> {
    await this.events.close().catch(() => undefined)
    await this.queue.close().catch(() => undefined)
    this.connection.disconnect()
    this.eventsConnection.disconnect()
  }
}

// ---------------------------------------------------------------------------
// Durability: the deck's next snapshot row
// ---------------------------------------------------------------------------

const db = new pg.Pool({ connectionString: process.env['POSTGRES_URL'], max: 2 })

async function lastRowId(deckId: string): Promise<number> {
  const r = await db.query<{ id: number | null }>(
    'select max(id) as id from deck_updates where deck_id = $1',
    [deckId],
  )
  return r.rows[0]?.id ?? 0
}

/** ms from `since` (performance.now()) until a row newer than `after` is stored. */
async function durableAfter(deckId: string, after: number, since: number): Promise<number> {
  const stop = performance.now() + 30_000
  for (;;) {
    if ((await lastRowId(deckId)) > after) return performance.now() - since
    if (performance.now() > stop) throw new Error(`deck ${deckId} was not stored within 30 s`)
    await sleep(20)
  }
}

// ---------------------------------------------------------------------------
// Samples → metric values
// ---------------------------------------------------------------------------

const lapsOf = (surface: AgentSurface): readonly string[] =>
  surface === 'api' ? API_LAPS : MCP_LAPS

/** One run's values for every metric the bench declares (absent phases are 0). */
function valuesOf(
  def: BenchDef<never>,
  surface: AgentSurface,
  sample: CallSample,
  extra: Record<string, number> = {},
): Record<string, number> {
  const server = lapsOf(surface).reduce((sum, lap) => sum + (sample.phases[lap] ?? 0), 0)
  const unknown = Object.keys(sample.phases).filter(
    (p) =>
      !lapsOf(surface).includes(p) &&
      !(HOST_SPANS as readonly string[]).includes(p) &&
      !(RENDER_SPANS as readonly string[]).includes(p),
  )
  if (unknown.length > 0) unknownPhases.add(`${surface}: ${unknown.join(', ')}`)
  if (VERBOSE)
    console.log(
      `  ${def.id}  total ${fmt(sample.total)}  ` +
        Object.entries({ ...sample.phases, ...extra })
          .map(([p, v]) => `${p} ${fmt(v)}`)
          .join(', '),
    )
  const all: Record<string, number> = {
    ...sample.phases,
    ...extra,
    total: sample.total,
    server,
    transport: sample.total - server,
  }
  return Object.fromEntries(Object.keys(def.metrics).map((m) => [m, all[m] ?? 0]))
}

const unknownPhases = new Set<string>()

class Recorder {
  readonly samples = new Map<string, Record<string, number[]>>()
  readonly bytes = new Map<string, number[]>()

  push(def: BenchDef<never>, values: Record<string, number>, bytes?: number): void {
    let s = this.samples.get(def.id)
    if (s === undefined) {
      s = Object.fromEntries(Object.keys(def.metrics).map((m) => [m, [] as number[]]))
      this.samples.set(def.id, s)
    }
    for (const [m, v] of Object.entries(values)) s[m]!.push(v)
    if (bytes !== undefined) this.bytes.set(def.id, [...(this.bytes.get(def.id) ?? []), bytes])
  }
}

const benchById = new Map(AGENT_BENCHES.map((b) => [b.id, b]))

function bench(id: string): BenchDef<never> {
  const def = benchById.get(id)
  if (def === undefined) throw new Error(`no bench ${id} in catalog/server.ts`)
  return def
}

const wanted = (id: string): boolean => args.only === undefined || id.includes(args.only)

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  const recorder = new Recorder()
  const health = await fetch(`${API}/health`).catch(() => null)
  if (health === null) throw new Error(`no server at ${API} (just dev)`)

  const watch = RENDER ? new RenderWatch() : null
  await watch?.ready()

  let token: RunToken | null = null
  const callers = new Map<AgentSurface, Caller>()
  let cleaned: Promise<void> | null = null
  const cleanup = (): Promise<void> =>
    (cleaned ??= (async () => {
      for (const c of callers.values()) await c.close().catch(() => undefined)
      if (token !== null)
        await asPerson('DELETE', `/access-tokens/${token.id}`).catch((err: unknown) =>
          console.error(`  could not revoke the run's token: ${String(err)}`),
        )
      for (const id of [...decksToDelete]) await deleteDeck(id)
      await watch?.close()
      await db.end().catch(() => undefined)
    })())
  // However the run ends — a signal, a crash — the token is revoked and the
  // decks deleted; a further signal while that runs is ignored, not fatal.
  const stop = (code: number, why: string) => {
    if (cleaned !== null) {
      console.error(`${why}: still cleaning up (the token, the decks), please wait`)
      return
    }
    console.error(`${why}: cleaning up`)
    void cleanup().finally(() => process.exit(code))
  }
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const)
    process.on(signal, () => stop(130, signal))
  process.on('uncaughtException', (err) => {
    console.error(err)
    stop(1, 'uncaught exception')
  })
  process.on('unhandledRejection', (err) => {
    console.error(err)
    stop(1, 'unhandled rejection')
  })

  const startedAt = new Date()
  try {
    const leftovers = await revokeLeftoverTokens()
    if (leftovers > 0) console.log(`revoked ${leftovers} token(s) an earlier run left behind`)
    token = await createToken()
    for (const surface of SURFACES)
      callers.set(surface, surface === 'api' ? apiCaller(token) : await mcpCaller(token))

    // --- MCP session cost ------------------------------------------------
    if (SURFACES.includes('mcp') && wanted(MCP_SESSION_BENCH_ID)) {
      const def = bench(MCP_SESSION_BENCH_ID)
      for (let i = 0; i < SESSIONS + 1; i++) {
        const c = await mcpConnect(token)
        const t0 = performance.now()
        const list = await c.client.listTools()
        const toolsList = performance.now() - t0
        await mcpClose(c)
        // The first session of the probe warms the client; it is not a sample.
        if (i > 0)
          recorder.push(def, {
            initialize: c.initialize,
            toolsList,
            toolsListBytes: Buffer.byteLength(JSON.stringify(list)),
          })
      }
    }

    for (const slides of SIZES) {
      console.log(`seeding the ${slides}-slide scene…`)
      const scene = await seedScene(slides)
      const commands = AGENT_COMMANDS.filter((c) => RENDER || c.render !== true)

      // --- Warm ----------------------------------------------------------
      const warmDecks = new Map<AgentSurface, string>()
      for (const surface of SURFACES)
        warmDecks.set(surface, await copyOf(scene, `${surface} warm ${slides}`))
      // One write per warm deck, then its card is drawn before any measurement.
      for (const [surface, deckId] of warmDecks)
        await callers.get(surface)!.call(deckId, 'object.update', {
          slide: { index: 1 },
          object: 's1-r2',
          patch: { opacity: 0.9 },
        })
      await sleep(2_500)
      await watch?.untilQuiet()

      console.log(`warm: ${slides} slides, ${WARMUP} + ${RUNS} rounds`)
      for (let round = 0; round < WARMUP + RUNS; round++) {
        for (const command of commands) {
          if (command.render === true && round >= WARMUP + RENDER_RUNS) continue
          for (const surface of SURFACES) {
            const id = agentBenchId(surface, command.name, 'warm', slides)
            if (!wanted(id)) continue
            const deckId = warmDecks.get(surface)!
            const sample = await callers
              .get(surface)!
              .call(deckId, command.command, inputFor(command, round, slides))
            if (round < WARMUP) continue
            recorder.push(bench(id), valuesOf(bench(id), surface, sample), sample.bytes)
          }
        }
      }

      // --- Cold ----------------------------------------------------------
      console.log(`cold: ${slides} slides, ${COLD} per command (${RENDER_COLD} renders)`)
      for (let i = 0; i < Math.max(COLD, RENDER ? RENDER_COLD : 0); i++) {
        for (const command of commands.filter((c) => c.cold)) {
          if (command.render === true ? i >= RENDER_COLD : i >= COLD) continue
          for (const surface of SURFACES) {
            const id = agentBenchId(surface, command.name, 'cold', slides)
            if (!wanted(id)) continue
            const deckId = await copyOf(scene, `${surface} cold ${slides}`)
            const before = command.write ? await lastRowId(deckId) : 0
            const sample = await callers
              .get(surface)!
              .call(deckId, command.command, inputFor(command, i, slides))
            const answered = performance.now()
            const extra: Record<string, number> = {}
            if (command.write) extra['durable'] = await durableAfter(deckId, before, answered)
            recorder.push(bench(id), valuesOf(bench(id), surface, sample, extra), sample.bytes)
            // Gone before the card scheduler's quiet window (10 s) ends.
            await deleteDeck(deckId)
          }
        }
      }
      for (const deckId of warmDecks.values()) await deleteDeck(deckId)
      await deleteDeck(scene)
    }
  } finally {
    await cleanup()
  }

  if (unknownPhases.size > 0)
    console.log(
      `phases the catalog does not declare (not stored): ${[...unknownPhases].join('; ')}`,
    )
  return report(recorder, startedAt)
}

// ---------------------------------------------------------------------------
// Report and store
// ---------------------------------------------------------------------------

function report(recorder: Recorder, startedAt: Date): number {
  const fingerprint = collectFingerprint({
    build: {
      mode: process.env['NODE_ENV'] === 'production' ? 'prod' : 'dev',
      source: { kind: 'local' },
    },
    cwd: path.resolve(import.meta.dirname, '../../..'),
  })
  for (const line of formatFingerprint(fingerprint)) console.log(line)
  const store = openResultStore({ machine: machineName() })
  const results: BenchResult[] = []
  let regressions = 0

  console.log('')
  console.log('median / p90 ms; server = the laps; transport = total − server')
  const rows: string[][] = []
  for (const [id, samples] of recorder.samples) {
    const def = bench(id)
    const n = samples['total']?.length ?? samples['initialize']?.length ?? 0
    const result = resultFrom(def, samples, fingerprint, id.includes('.cold.') ? 0 : WARMUP, n)
    results.push(result)
    const s = result.summary
    const cell = (m: string): string =>
      s[m] === undefined ? '' : `${fmt(s[m].median)} / ${fmt(s[m].p90)}`
    if (id === MCP_SESSION_BENCH_ID) {
      console.log(
        `${id}: initialize ${cell('initialize')}, tools/list ${cell('toolsList')} ` +
          `(${fmt(s['toolsListBytes']!.median / 1024)} kB), n=${n}`,
      )
      continue
    }
    // The largest phases, so the table says where the time went.
    const phases = Object.keys(def.metrics)
      // `host` is explained by its spans.
      .filter((m) => !['total', 'server', 'transport', 'durable', 'host'].includes(m))
      .map((m) => [m, s[m]!.median] as const)
      .filter(([, v]) => v >= 0.05)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([m, v]) => `${m} ${fmt(v)}`)
      .join(', ')
    const bytes = recorder.bytes.get(id) ?? []
    rows.push([
      id,
      String(n),
      cell('total'),
      cell('server'),
      cell('transport'),
      cell('durable'),
      bytes.length === 0 ? '' : `${fmt(bytes[0]! / 1024)} kB`,
      phases,
    ])
  }
  printTable(
    [
      'bench',
      'n',
      'total',
      'server',
      'transport',
      'durable',
      'response',
      'largest phases (median)',
    ],
    rows,
  )

  if (!args['no-store']) {
    for (const result of results) store.append(result)
    const details = path.join(store.dir, 'details')
    mkdirSync(details, { recursive: true })
    const file = path.join(
      details,
      `perf-agent-${startedAt.toISOString().replace(/[:.]/g, '-')}.json`,
    )
    writeFileSync(
      file,
      JSON.stringify(
        {
          at: startedAt.toISOString(),
          api: API,
          options: args,
          responseBytes: Object.fromEntries(recorder.bytes),
          results,
        },
        null,
        2,
      ),
    )
    console.log(`\nstored ${results.length} results in ${store.dir} (details: ${file})`)
    for (const result of results) {
      const base = store.baselineFor(result)
      if (base === undefined) continue
      const ok = comparability(base.result.fingerprint, result.fingerprint)
      if (!ok.ok) {
        console.log(
          `PERF ${result.benchId}: the baseline is not comparable: ${ok.reasons.join('; ')}`,
        )
        continue
      }
      const def = bench(result.benchId)
      const comparisons = compareResults(def, base.result, result).filter(
        (c) => c.verdict !== 'no-change',
      )
      for (const line of formatComparisons(result.benchId, comparisons)) console.log(line)
      regressions += comparisons.filter((c) => c.verdict === 'regression').length
    }
    if (results.every((r) => store.baselineFor(r) === undefined))
      console.log(`no baselines on ${store.machine} yet (just perf-accept <bench id…>)`)
  }
  if (args.json !== undefined) {
    writeFileSync(
      args.json,
      JSON.stringify({ results, bytes: Object.fromEntries(recorder.bytes) }, null, 2),
    )
    console.log(`written to ${args.json}`)
  }
  return regressions > 0 ? 1 : 0
}

function printTable(header: readonly string[], rows: ReadonlyArray<readonly string[]>): void {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)))
  const line = (cells: readonly string[]): string =>
    cells
      .map((c, i) =>
        i === 0 || i === cells.length - 1 ? c.padEnd(widths[i]!) : c.padStart(widths[i]!),
      )
      .join('  ')
      .trimEnd()
  console.log(line(header))
  console.log(widths.map((w) => '-'.repeat(w)).join('  '))
  for (const r of rows) console.log(line(r))
}

process.exitCode = await main()
