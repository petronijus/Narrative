/**
 * tests/agent-eval/lib/replay.ts — replays a recorded agent transcript in
 * the memory world and grades the result with the scenario's own grader.
 *
 * Ids differ between the recording (made by the live server) and the
 * replay (made in memory), so replay rebinds them:
 *   1. the scenario's `setup` builds the fixture in memory; walking the
 *      recorded fixture and the new one side by side maps every recorded id
 *      to its replay counterpart;
 *   2. each recorded tool call's arguments are rewritten through that map
 *      and executed as the agent's MCP call (same tool → command mapping,
 *      same target / runId / confirmation handling as the server);
 *   3. each call's recorded result is walked side by side with the replay
 *      result, which maps the ids the call created (a duplicated slide, a
 *      new run) for the calls after it.
 * A call must fail in the replay exactly when it failed live.
 *
 * Before replaying, the grader runs once on the untouched fixture with an
 * empty transcript and must FAIL — a grader that passes without the agent
 * doing anything tests nothing.
 */

import { CommandError } from '../../../packages/commands/src/index.js'
import { MemoryWorld } from './memoryWorld.js'
import type { Recording } from './report.js'
import type { AnyScenario, Grade, Notes, ToolCall, Transcript, TranscriptStep } from './types.js'

/** Fields whose values legitimately differ and are never ids another call passes back. */
const VOLATILE_KEYS = new Set([
  'createdAt',
  'updatedAt',
  'lastActivityAt',
  'lastActiveAt',
  'expiresAt',
  'url',
  'thumbnailUrl',
])

export interface CallMismatch {
  step: number
  tool: string
  expected: 'ok' | 'error'
  got: string
}

export interface ReplayResult {
  /** The grader on the untouched fixture (must fail). */
  baseline: Grade
  /** The grader after the replay (must pass). */
  grade: Grade
  mismatches: CallMismatch[]
  replayedCalls: number
  idMap: Map<string, string>
}

/** Record `recorded → replayed` for every string that differs at the same place in two JSON values. */
export function alignIds(
  recorded: unknown,
  replayed: unknown,
  map: Map<string, string>,
  key?: string,
): void {
  if (key !== undefined && VOLATILE_KEYS.has(key)) return
  if (typeof recorded === 'string' && typeof replayed === 'string') {
    if (recorded !== replayed && !map.has(recorded)) map.set(recorded, replayed)
    return
  }
  if (Array.isArray(recorded) && Array.isArray(replayed)) {
    for (const [r, p] of pairElements(recorded, replayed)) alignIds(r, p, map)
    return
  }
  if (
    typeof recorded === 'object' &&
    recorded !== null &&
    typeof replayed === 'object' &&
    replayed !== null
  ) {
    const r = replayed as Record<string, unknown>
    for (const [k, v] of Object.entries(recorded)) if (k in r) alignIds(v, r[k], map, k)
  }
}

/** What identifies a listed record apart from its id: its name, type and value. */
function signature(v: unknown): string | undefined {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined
  const r = v as Record<string, unknown>
  if (typeof r['id'] !== 'string') return undefined
  const parts = ['name', 'type', 'value'].map((k) => (typeof r[k] === 'string' ? r[k] : ''))
  return parts.every((p) => p === '') ? undefined : parts.join('\u0000')
}

/**
 * The elements of two lists that are the same record. A list of records
 * (each with an `id`) is a set whose order the live server and the memory
 * world need not share — a folder's colours come back in the order their
 * document holds them — so records are paired by name, type and value
 * first; the rest, and every other list, by position.
 */
function pairElements(recorded: unknown[], replayed: unknown[]): Array<[unknown, unknown]> {
  const pairs: Array<[unknown, unknown]> = []
  const usedR = new Set<number>()
  const usedP = new Set<number>()
  recorded.forEach((r, i) => {
    const sig = signature(r)
    if (sig === undefined) return
    const j = replayed.findIndex((p, k) => !usedP.has(k) && signature(p) === sig)
    if (j === -1) return
    pairs.push([r, replayed[j]])
    usedR.add(i)
    usedP.add(j)
  })
  const restR = recorded.filter((_, i) => !usedR.has(i))
  const restP = replayed.filter((_, k) => !usedP.has(k))
  for (let i = 0; i < Math.min(restR.length, restP.length); i++) pairs.push([restR[i], restP[i]])
  return pairs
}

/** Rewrite every string that is a recorded id into its replay id. */
export function translateIds<T>(value: T, map: ReadonlyMap<string, string>): T {
  if (typeof value === 'string') return (map.get(value) ?? value) as T
  if (Array.isArray(value)) return value.map((v) => translateIds(v, map)) as T
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, translateIds(v, map)])) as T
  }
  return value
}

function emptyTranscript(steps: readonly TranscriptStep[]): Transcript {
  return {
    steps: steps.map((s) => ({ ...s, calls: [], finalText: '', turns: 0 })),
  }
}

export async function replayRecording(
  scenario: AnyScenario,
  recording: Recording,
): Promise<ReplayResult> {
  if (scenario.replay !== true)
    throw new Error(`${scenario.id} is live-only: ${scenario.replay.reason}`)
  const world = new MemoryWorld({ tag: recording.tag })
  const fixture = await scenario.setup(world)
  const idMap = new Map<string, string>()
  alignIds(recording.fixture, fixture, idMap)
  const notes: Notes = {}
  await scenario.prepare?.(world, fixture, notes)

  const baseline = await scenario.grade({
    world,
    fixture,
    transcript: emptyTranscript(recording.transcript.steps),
    notes: { ...notes },
  })

  const mismatches: CallMismatch[] = []
  const steps: TranscriptStep[] = []
  let replayedCalls = 0
  for (const [index, step] of recording.transcript.steps.entries()) {
    const calls: ToolCall[] = []
    for (const call of step.calls) {
      if (call.command === null) {
        calls.push(call) // a resource read: nothing to replay
        continue
      }
      const input = translateIds(call.input, idMap)
      let result: unknown = null
      let errorCode: string | null = null
      try {
        result = await world.agentCall(call.tool, input)
      } catch (err) {
        if (!(err instanceof CommandError)) throw err
        errorCode = err.code
      }
      replayedCalls++
      const failed = errorCode !== null
      if (failed !== call.isError) {
        mismatches.push({
          step: index,
          tool: call.tool,
          expected: call.isError ? 'error' : 'ok',
          got: failed ? `error ${errorCode}` : 'ok',
        })
      }
      if (!failed && !call.isError) alignIds(call.result, result, idMap)
      calls.push({ ...call, input, result, isError: failed, errorCode })
    }
    steps.push({ ...step, calls })
    await scenario.afterStep?.(world, fixture, index, notes, { steps })
  }

  const grade = await scenario.grade({ world, fixture, transcript: { steps }, notes })
  return { baseline, grade, mismatches, replayedCalls, idMap }
}
