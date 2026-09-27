/**
 * tests/agent-eval/run.ts — `pnpm agent:eval`: the agent eval suite
 * (docs/plans/agentic-layer.md §9.3) against the LOCAL dev stack.
 *
 *   pnpm agent:eval [--filter <id>[,<id>…]] [--keep] [--model <alias>] [--record]
 *                   [--retries <n>] [--max-budget-usd <n>] [--verbose] [--list]
 *
 * For each scenario: build a fresh fixture through the command API, run
 * headless Claude Code with only the Narrative MCP server, grade the
 * resulting document deterministically, clean up. Real runs spend the
 * developer's Claude subscription — see README.md.
 *
 * Exit code: 0 when every selected scenario passed (skips allowed), 1 on any
 * failure or error, 2 on a setup problem (stack down, no token).
 */

import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runAgent, claudeVersion, DEFAULT_STEP_TIMEOUT_MS } from './lib/claude.js'
import {
  DEFAULT_API_URL,
  DEFAULT_WEB_URL,
  InfraError,
  LiveWorld,
  isBypassAuth,
  mintToken,
  revokeToken,
  waitForHealth,
  type MintedToken,
} from './lib/liveWorld.js'
import {
  renderFailure,
  renderTable,
  totalsOf,
  writeRecording,
  writeReport,
  type ScenarioOutcome,
  type SuiteReport,
} from './lib/report.js'
import { SkipScenario, type AnyScenario, type Notes, type Requirement } from './lib/types.js'
import { SCENARIOS } from './scenarios/index.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const RESULTS_DIR = path.join(HERE, 'results')
const RECORDINGS_DIR = path.join(HERE, 'recordings')
const RESTART_WAIT_MS = 90_000
const HEALTH_POLL_MS = 2_000

interface Options {
  filter: string[]
  keep: boolean
  model: string
  record: boolean
  retries: number
  maxBudgetUsd: number | undefined
  verbose: boolean
  list: boolean
  apiUrl: string
  webUrl: string
}

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    filter: [],
    keep: false,
    model: process.env['NARRATIVE_EVAL_MODEL'] ?? 'opus',
    record: false,
    retries: 1,
    maxBudgetUsd: undefined,
    verbose: false,
    list: false,
    apiUrl: process.env['NARRATIVE_API_URL'] ?? DEFAULT_API_URL,
    webUrl: process.env['NARRATIVE_WEB_URL'] ?? DEFAULT_WEB_URL,
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    const value = (): string => {
      const v = argv[++i]
      if (v === undefined) throw new Error(`${arg} needs a value`)
      return v
    }
    switch (arg) {
      case '--':
        break
      case '--filter':
        opts.filter.push(
          ...value()
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
        )
        break
      case '--keep':
        opts.keep = true
        break
      case '--model':
        opts.model = value()
        break
      case '--record':
        opts.record = true
        break
      case '--retries':
        opts.retries = Number(value())
        break
      case '--max-budget-usd':
        opts.maxBudgetUsd = Number(value())
        break
      case '--verbose':
        opts.verbose = true
        break
      case '--list':
        opts.list = true
        break
      case '--api-url':
        opts.apiUrl = value()
        break
      case '--web-url':
        opts.webUrl = value()
        break
      default:
        throw new Error(`unknown argument ${arg}`)
    }
  }
  return opts
}

function select(filter: string[]): AnyScenario[] {
  if (filter.length === 0) return [...SCENARIOS]
  const picked = SCENARIOS.filter((s) => filter.some((f) => s.id === f || s.id.includes(f)))
  if (picked.length === 0)
    throw new Error(`--filter ${filter.join(',')} matches no scenario (see --list)`)
  return picked
}

function gitDescribe(): string {
  try {
    const head = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim()
    const dirty =
      execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim().length > 0
    return dirty ? `${head}+dirty` : head
  } catch {
    return 'unknown'
  }
}

async function reachable(url: string): Promise<boolean> {
  try {
    const res = await fetch(url)
    return res.status < 500
  } catch {
    return false
  }
}

/** Polls /health while a scenario runs: a restart in the middle makes the result meaningless. */
function watchHealth(apiUrl: string): { stop(): boolean } {
  let disrupted = false
  const timer = setInterval(() => {
    fetch(`${apiUrl}/health`)
      .then((r) => {
        if (!r.ok) disrupted = true
      })
      .catch(() => {
        disrupted = true
      })
  }, HEALTH_POLL_MS)
  return {
    stop() {
      clearInterval(timer)
      return disrupted
    },
  }
}

interface Env {
  opts: Options
  world: LiveWorld
  mcpToken: string
  capabilities: Set<Requirement>
  claudeVersion: string
}

async function runScenarioOnce(
  env: Env,
  scenario: AnyScenario,
): Promise<ScenarioOutcome & { infra?: boolean }> {
  const base: ScenarioOutcome = {
    id: scenario.id,
    title: scenario.title,
    status: 'error',
    checks: [],
    turns: 0,
    toolCalls: 0,
    durationMs: 0,
    costUsd: null,
    usage: null,
    model: null,
    attempts: 1,
  }
  const missing = (scenario.requires ?? []).filter((r) => !env.capabilities.has(r))
  if (missing.length > 0) {
    return {
      ...base,
      status: 'skipped',
      reason: `needs ${missing.join(', ')} (${capabilityHint(missing)})`,
    }
  }
  const started = Date.now()
  const health = watchHealth(env.opts.apiUrl)
  const notes: Notes = {}
  let outcome: ScenarioOutcome & { infra?: boolean } = base
  try {
    const fixture = await scenario.setup(env.world)
    outcome = { ...outcome, fixture }
    await scenario.prepare?.(env.world, fixture, notes)
    const steps = scenario.steps(fixture)
    const agent = await runAgent({
      mcpUrl: `${env.opts.apiUrl}/mcp`,
      mcpToken: env.mcpToken,
      model: env.opts.model,
      maxTurns: scenario.maxTurns,
      steps,
      stepTimeoutMs: scenario.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS,
      ...(env.opts.maxBudgetUsd !== undefined ? { maxBudgetUsd: env.opts.maxBudgetUsd } : {}),
      betweenSteps: async (index) => scenario.afterStep?.(env.world, fixture, index, notes),
      ...(env.opts.verbose
        ? { onToolCall: (line: string) => console.log(`    ${scenario.id}: ${line}`) }
        : {}),
    })
    outcome = {
      ...outcome,
      turns: agent.turns,
      toolCalls: agent.toolCalls,
      costUsd: agent.costUsd,
      usage: agent.usage,
      model: agent.init?.model ?? null,
      transcript: agent.transcript,
      toolSequence: agent.transcript.steps.flatMap((s) =>
        s.calls.map((c) => `${c.tool}${c.isError ? '!' : ''}`),
      ),
      stderrTail: agent.stderrTail,
      warnings: agent.warnings,
      permissionDenials: agent.permissionDenials,
    }
    if (agent.mcpUnavailable) throw new InfraError('the Narrative MCP server did not connect')
    if (agent.init === null) {
      throw new Error(
        `claude produced no session (exit ${agent.exitCode}): ${agent.stderrTail.slice(-400)}`,
      )
    }
    const grade = await scenario.grade({
      world: env.world,
      fixture,
      transcript: agent.transcript,
      notes,
    })
    outcome = { ...outcome, status: grade.pass ? 'pass' : 'fail', checks: grade.checks }
    if (env.opts.record && grade.pass && scenario.replay === true) {
      const file = await writeRecording(RECORDINGS_DIR, {
        scenario: scenario.id,
        tag: env.world.tag,
        recordedAt: new Date().toISOString(),
        model: agent.init.model,
        claudeVersion: env.claudeVersion,
        fixture,
        transcript: agent.transcript,
      })
      console.log(`    recorded ${path.relative(process.cwd(), file)}`)
    }
  } catch (err) {
    if (err instanceof SkipScenario) {
      outcome = { ...outcome, status: 'skipped', reason: err.reason }
    } else {
      outcome = {
        ...outcome,
        status: 'error',
        reason: (err as Error).message,
        infra: err instanceof InfraError,
      }
    }
  } finally {
    await env.world.endScenario()
  }
  const disrupted = health.stop()
  outcome.durationMs = Date.now() - started
  if (disrupted && outcome.status !== 'skipped') {
    return {
      ...outcome,
      status: 'error',
      reason: `the API restarted or went down during the scenario${outcome.reason ? `; ${outcome.reason}` : ''}`,
      infra: true,
    }
  }
  return outcome
}

function capabilityHint(missing: Requirement[]): string {
  const hints: Record<Requirement, string> = {
    browser: 'the BYPASS_AUTH dev web app on :5173 and a Playwright Chromium',
    componentRoute: 'the BYPASS_AUTH dev stack; component.create arrives in A4',
    binaryFetch: 'fetching export links',
  }
  return missing.map((m) => hints[m]).join('; ')
}

async function main(): Promise<number> {
  const opts = parseArgs(process.argv.slice(2))
  const scenarios = select(opts.filter)
  if (opts.list) {
    for (const s of SCENARIOS) {
      const replay = s.replay === true ? 'replayable' : 'live only'
      console.log(`${s.id.padEnd(30)} ${replay.padEnd(10)} ${s.title}`)
    }
    return 0
  }

  if (!(await reachable(`${opts.apiUrl}/health`))) {
    console.error(
      `The API at ${opts.apiUrl} is not reachable. Start the dev stack (pnpm dev) first; the eval never starts or restarts it.`,
    )
    return 2
  }
  const version = await claudeVersion().catch(() => null)
  if (version === null) {
    console.error('The `claude` CLI is not on PATH (Claude Code 2.1+ is required).')
    return 2
  }

  const bypass = await isBypassAuth(opts.apiUrl)
  const tag = `ev${randomBytes(3).toString('hex')}`
  const minted: MintedToken[] = []
  let apiToken = process.env['NARRATIVE_EVAL_API_TOKEN']
  let mcpToken = process.env['NARRATIVE_EVAL_MCP_TOKEN']
  let world: LiveWorld | null = null
  const cleanupNotes: string[] = []
  let cleanedUp = false

  const cleanup = async (): Promise<void> => {
    if (cleanedUp) return
    cleanedUp = true
    if (world !== null) {
      if (opts.keep) {
        cleanupNotes.push(`--keep: left folders ${world.createdFolders.join(', ')} (tag ${tag})`)
      } else {
        try {
          for (const deck of await world.strayDecks()) {
            await world.deleteDeck(deck.id)
            cleanupNotes.push(
              `deleted stray deck "${deck.title}" (${deck.id}) created outside the eval folders`,
            )
          }
        } catch (err) {
          cleanupNotes.push(`stray deck sweep failed: ${(err as Error).message}`)
        }
        cleanupNotes.push(...(await world.cleanup()))
      }
    }
    for (const t of minted) {
      const ok = await revokeToken(opts.apiUrl, t.id).catch(() => false)
      if (!ok)
        cleanupNotes.push(`could not revoke access token ${t.id}: revoke it under Access tokens`)
    }
  }
  const onSignal = (): void => {
    console.error('\nInterrupted: cleaning up…')
    void cleanup().finally(() => process.exit(130))
  }
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)

  const startedAt = new Date().toISOString()
  const outcomes: ScenarioOutcome[] = []
  try {
    if (apiToken === undefined || mcpToken === undefined) {
      const api = await mintToken(opts.apiUrl, `agent-eval ${tag} (harness)`, ['api'])
      minted.push(api)
      const mcp = await mintToken(opts.apiUrl, `agent-eval ${tag} (agent)`, ['mcp'])
      minted.push(mcp)
      apiToken = api.token
      mcpToken = mcp.token
    }
    world = new LiveWorld({ apiUrl: opts.apiUrl, webUrl: opts.webUrl, apiToken, tag, bypass })
    await world.init()

    const capabilities = new Set<Requirement>(['binaryFetch'])
    if (bypass) capabilities.add('componentRoute')
    if (bypass && (await reachable(opts.webUrl))) capabilities.add('browser')

    console.log(
      `Agent eval ${tag}: ${scenarios.length} scenario(s), model ${opts.model}, ${version}, API ${opts.apiUrl}${bypass ? ' (BYPASS_AUTH)' : ''}`,
    )
    const env: Env = { opts, world, mcpToken, capabilities, claudeVersion: version }
    for (const scenario of scenarios) {
      process.stdout.write(`  ${scenario.id} … `)
      if (opts.verbose) process.stdout.write('\n')
      let attempts = 0
      let outcome: ScenarioOutcome & { infra?: boolean }
      for (;;) {
        attempts++
        outcome = await runScenarioOnce(env, scenario)
        if (outcome.status === 'error' && outcome.infra === true && attempts <= opts.retries) {
          process.stdout.write(
            `infrastructure hiccup (${outcome.reason}); waiting for the API and retrying … `,
          )
          if (!(await waitForHealth(opts.apiUrl, RESTART_WAIT_MS))) break
          continue
        }
        break
      }
      const { infra: _infra, ...clean } = outcome
      const final: ScenarioOutcome = { ...clean, attempts }
      outcomes.push(final)
      console.log(
        `${final.status.toUpperCase()}${final.reason && final.status !== 'fail' ? ` (${final.reason})` : ''}`,
      )
    }
  } catch (err) {
    console.error(`\nSetup failed: ${(err as Error).message}`)
    await cleanup()
    return 2
  } finally {
    await cleanup()
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
  }

  const report: SuiteReport = {
    startedAt,
    finishedAt: new Date().toISOString(),
    tag,
    model: opts.model,
    claudeVersion: version,
    apiUrl: opts.apiUrl,
    git: gitDescribe(),
    scenarios: outcomes,
    totals: totalsOf(outcomes),
    cleanup: cleanupNotes,
  }
  console.log(`\n${renderTable(outcomes)}`)
  for (const o of outcomes.filter((x) => x.status === 'fail' || x.status === 'error'))
    console.log(renderFailure(o))
  for (const note of cleanupNotes) console.log(`cleanup: ${note}`)
  const file = await writeReport(RESULTS_DIR, report)
  console.log(`\nReport: ${path.relative(process.cwd(), file)}`)
  console.log(
    'Cost is what Claude Code reports (list-price equivalent); on a subscription it counts against your plan limits.',
  )
  return report.totals.fail + report.totals.error > 0 ? 1 : 0
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err)
    process.exit(2)
  },
)
