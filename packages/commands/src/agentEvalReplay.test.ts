/**
 * The free smoke subset of the agent eval suite (tests/agent-eval,
 * docs/plans/agentic-layer.md §9.3), run by `pnpm -r test` with no model:
 *
 *   - every replayable scenario builds its fixture in the memory world
 *     (the real registry on in-memory Yjs docs), and its grader FAILS on
 *     that untouched fixture — a grader that passes without the agent
 *     doing anything tests nothing;
 *   - every recording in tests/agent-eval/recordings (tool calls captured
 *     from a real `pnpm agent:eval --record` run) replays against the
 *     commands with the same outcome per call, and the grader then PASSES.
 *
 * Lives here because this package's vitest run already resolves the
 * @narrative/* sources the memory world needs; the suite itself stays in
 * tests/agent-eval.
 */

import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { MemoryWorld } from '../../../tests/agent-eval/lib/memoryWorld.js'
import { replayRecording } from '../../../tests/agent-eval/lib/replay.js'
import type { Recording } from '../../../tests/agent-eval/lib/report.js'
import { SCENARIOS, scenarioById } from '../../../tests/agent-eval/scenarios/index.js'

const RECORDINGS = path.resolve(__dirname, '../../../tests/agent-eval/recordings')

function loadRecordings(): Recording[] {
  let files: string[] = []
  try {
    files = readdirSync(RECORDINGS).filter((f) => f.endsWith('.json'))
  } catch {
    return []
  }
  return files
    .sort()
    .map((f) => JSON.parse(readFileSync(path.join(RECORDINGS, f), 'utf8')) as Recording)
}

const replayable = SCENARIOS.filter((s) => s.replay === true)
const recordings = loadRecordings()

describe('agent eval: graders reject the untouched fixture', () => {
  it.each(replayable.map((s) => [s.id, s] as const))('%s', async (_id, scenario) => {
    const world = new MemoryWorld({ tag: 'evsmoke' })
    const fixture = await scenario.setup(world)
    const notes = {}
    await scenario.prepare?.(world, fixture, notes)
    const steps = scenario.steps(fixture).map((prompt) => ({
      prompt,
      calls: [],
      finalText: '',
      turns: 0,
      isError: false,
      stopReason: 'success',
    }))
    const grade = await scenario.grade({ world, fixture, transcript: { steps }, notes })
    expect(grade.checks.length).toBeGreaterThan(0)
    expect(grade.pass).toBe(false)
  })
})

describe('agent eval: recorded transcripts replay and pass', () => {
  it('has a recording for every replayable scenario', () => {
    const recorded = new Set(recordings.map((r) => r.scenario))
    const missing = replayable.map((s) => s.id).filter((id) => !recorded.has(id))
    expect(missing, 'record them with pnpm agent:eval --filter <id> --record').toEqual([])
  })

  it.each(recordings.map((r) => [r.scenario, r] as const))('%s', async (id, recording) => {
    const scenario = scenarioById(id)
    expect(scenario, `recording for unknown scenario ${id}`).toBeDefined()
    const result = await replayRecording(scenario!, recording)
    expect(result.replayedCalls).toBeGreaterThan(0)
    expect(result.mismatches).toEqual([])
    expect(result.baseline.pass).toBe(false)
    expect(result.grade.checks.filter((c) => !c.pass)).toEqual([])
    expect(result.grade.pass).toBe(true)
  })
})
