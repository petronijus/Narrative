/**
 * catalog/server.ts — layer S benches of the agent surface, run by
 * `just perf-agent` (apps/server/perf/agentLatency.ts; docs/plans/
 * performance.md → G7): a fixed set of commands sent over real HTTP to a
 * running server, through the command API (`POST /api/commands`) and MCP
 * (streamable HTTP, `/api/mcp`), with a personal access token made for the
 * run, on the seeded decks of SCENES.deck10 / deck100.
 *
 * Ids: `command.<surface>.<command>.<temperature>.<slides>`, e.g.
 * `command.mcp.objectUpdate.cold.100`:
 *   - warm: the deck is loaded and the session has its run (the steady state
 *     of an agent at work);
 *   - cold: the first call on a deck nobody has loaded (a copy of the
 *     scene, never opened) — the document is read from Postgres;
 *   - `queryRender` cold is the first look at a deck (a new render session),
 *     warm the next looks at it.
 * `command.mcp.session.open` is what a new MCP session costs before its first
 * tool call (initialize, tools/list).
 *
 * Metrics: `total` (what the client waited), `server` (the server's laps,
 * observability/phases.ts), `transport` (total − server: the client, the
 * network stack and, over MCP, the SDK's serialisation and SSE framing), each
 * lap and each span inside them. A phase a call never entered is 0.
 */

import { defineBench, type BenchDef, type MetricSpec } from '../defineBench.js'
import { SCENES } from './interaction.js'

const ms: MetricSpec = { unit: 'ms', better: 'lower', kind: 'time' }

/** Laps of a command API call (they add up to `server`). */
export const API_LAPS = [
  // Everything before the route handler, as one opaque slice (observability/phases.ts).
  'http.pre',
  'http.parse',
  'host',
  'http.serialize',
] as const

/** Laps of an MCP tool call (they add up to `server`). */
export const MCP_LAPS = [
  'http.pre',
  'mcp.dispatch',
  'mcp.args',
  'mcp.confirm',
  'host',
  'mcp.result',
] as const

/** Spans of the ServerHost inside the `host` lap (agent/serverHost.ts). */
export const HOST_SPANS = [
  'host.admit',
  'host.confirm',
  'host.run',
  'host.context',
  'host.load',
  'host.validate',
  'host.apply',
  'host.execute',
  'host.settle',
  'host.audit',
] as const

/**
 * Spans of a look (services/render.ts) inside `host.execute`, and the job's
 * split the probe reads off the render queue: waiting for the worker, and
 * the worker's own time, then the worker's steps inside it.
 */
export const RENDER_SPANS = [
  'render.live',
  'render.job',
  'render.read',
  'render.queueWait',
  'render.worker',
  // The worker's steps (RenderJobResult.timings): its page until the app is
  // ready, the page's own steps (apps/web pages/renderTimings.ts), the upload.
  'render.worker.page',
  'render.page.sync',
  'render.page.ready',
  'render.page.settle',
  'render.page.extract',
  'render.page.encode',
  'render.page.compose',
  'render.worker.upload',
] as const

export type AgentSurface = 'api' | 'mcp'
export type Temperature = 'warm' | 'cold'

/** A command of the fixed set: its bench name and whether it is measured cold too. */
export interface AgentCommand {
  /** The bench id segment (`objectUpdate`). */
  name: string
  /** The registry command id (`object.update`). */
  command: string
  cold: boolean
  /** Stored after the call: `durable` (response → the deck's next snapshot row) is measured cold. */
  write: boolean
  render?: true
}

export const AGENT_COMMANDS: readonly AgentCommand[] = [
  { name: 'queryDeck', command: 'query.deck', cold: true, write: false },
  { name: 'querySlide', command: 'query.slide', cold: false, write: false },
  { name: 'objectUpdate', command: 'object.update', cold: true, write: true },
  { name: 'objectCreate', command: 'object.create', cold: false, write: true },
  { name: 'opsApply', command: 'ops.apply', cold: false, write: true },
  { name: 'queryRender', command: 'query.render', cold: true, write: false, render: true },
]

export const AGENT_SURFACES: readonly AgentSurface[] = ['api', 'mcp']
export const AGENT_SIZES = [10, 100] as const

export function agentBenchId(
  surface: AgentSurface,
  command: string,
  temperature: Temperature,
  slides: number,
): string {
  return `command.${surface}.${command}.${temperature}.${slides}`
}

export const MCP_SESSION_BENCH_ID = 'command.mcp.session.open'

function unbound(id: string) {
  return (): never => {
    throw new Error(`${id} runs from \`just perf-agent\` (apps/server/perf/agentLatency.ts)`)
  }
}

/** Every metric of a bench of `surface` for `command`, cold or warm. */
export function agentMetrics(
  surface: AgentSurface,
  command: AgentCommand,
  temperature: Temperature,
): Record<string, MetricSpec> {
  const names = [
    'total',
    'server',
    'transport',
    ...(surface === 'api' ? API_LAPS : MCP_LAPS),
    ...HOST_SPANS,
    ...(command.render === true ? RENDER_SPANS : []),
    ...(temperature === 'cold' && command.write ? ['durable'] : []),
  ]
  return Object.fromEntries(names.map((n) => [n, ms]))
}

function agentBenches(): Array<BenchDef<never>> {
  const out: Array<BenchDef<never>> = []
  for (const surface of AGENT_SURFACES)
    for (const command of AGENT_COMMANDS)
      for (const temperature of command.cold ? (['warm', 'cold'] as const) : (['warm'] as const))
        for (const slides of AGENT_SIZES) {
          const id = agentBenchId(surface, command.name, temperature, slides)
          out.push(
            defineBench<never>({
              id,
              area: 'command',
              layer: 'S',
              commands: [command.command],
              scene: slides === 10 ? SCENES.deck10 : SCENES.deck100,
              run: unbound(id),
              metrics: agentMetrics(surface, command, temperature),
              // Sub-millisecond phases on a shared dev database move by more than 5 %.
              threshold: 0.1,
            }),
          )
        }
  out.push(
    defineBench<never>({
      id: MCP_SESSION_BENCH_ID,
      area: 'command',
      layer: 'S',
      run: unbound(MCP_SESSION_BENCH_ID),
      metrics: { initialize: ms, toolsList: ms, toolsListBytes: { ...ms, unit: 'bytes' } },
      threshold: 0.1,
    }),
  )
  return out
}

export const AGENT_BENCHES: ReadonlyArray<BenchDef<never>> = agentBenches()
