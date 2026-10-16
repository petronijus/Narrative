/**
 * tests/agent-eval/lib/report.ts — the console table and the JSON report
 * (tests/agent-eval/results/<timestamp>.json, gitignored), plus recordings
 * (tests/agent-eval/recordings/<id>.json, committed) for the smoke replay.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { maskCredentials } from '../../../packages/shared/src/credentialPatterns.js'
import type { Check, Transcript, Usage } from './types.js'

export type Status = 'pass' | 'fail' | 'error' | 'skipped'

export interface ScenarioOutcome {
  id: string
  title: string
  status: Status
  /** Why it was skipped or errored. */
  reason?: string
  checks: Check[]
  turns: number
  toolCalls: number
  durationMs: number
  costUsd: number | null
  usage: Usage | null
  model: string | null
  attempts: number
  fixture?: unknown
  transcript?: Transcript
  /** Tool calls in order, compact (`slide_duplicate`, `text_set!` for errors). */
  toolSequence?: string[]
  stderrTail?: string
  warnings?: string[]
  permissionDenials?: unknown[]
}

export interface SuiteReport {
  startedAt: string
  finishedAt: string
  tag: string
  model: string
  claudeVersion: string
  apiUrl: string
  git: string
  scenarios: ScenarioOutcome[]
  totals: {
    pass: number
    fail: number
    error: number
    skipped: number
    turns: number
    toolCalls: number
    costUsd: number
    durationMs: number
  }
  cleanup: string[]
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length)
}

function padStart(s: string, n: number): string {
  return s.length >= n ? s : ' '.repeat(n - s.length) + s
}

export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000)
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`
}

function formatCost(usd: number | null): string {
  return usd === null ? '-' : `$${usd.toFixed(2)}`
}

export function totalsOf(outcomes: ScenarioOutcome[]): SuiteReport['totals'] {
  return {
    pass: outcomes.filter((o) => o.status === 'pass').length,
    fail: outcomes.filter((o) => o.status === 'fail').length,
    error: outcomes.filter((o) => o.status === 'error').length,
    skipped: outcomes.filter((o) => o.status === 'skipped').length,
    turns: outcomes.reduce((n, o) => n + o.turns, 0),
    toolCalls: outcomes.reduce((n, o) => n + o.toolCalls, 0),
    costUsd: outcomes.reduce((n, o) => n + (o.costUsd ?? 0), 0),
    durationMs: outcomes.reduce((n, o) => n + o.durationMs, 0),
  }
}

export function renderTable(outcomes: ScenarioOutcome[]): string {
  const idWidth = Math.max(8, ...outcomes.map((o) => o.id.length))
  const header = `${pad('Scenario', idWidth)}  ${pad('Result', 7)}  ${padStart('Turns', 5)}  ${padStart('Tools', 5)}  ${padStart('Time', 7)}  ${padStart('Cost', 7)}`
  const lines = [header, '-'.repeat(header.length)]
  for (const o of outcomes) {
    lines.push(
      `${pad(o.id, idWidth)}  ${pad(o.status.toUpperCase(), 7)}  ${padStart(String(o.turns), 5)}  ${padStart(String(o.toolCalls), 5)}  ${padStart(formatDuration(o.durationMs), 7)}  ${padStart(formatCost(o.costUsd), 7)}`,
    )
  }
  const t = totalsOf(outcomes)
  lines.push('-'.repeat(header.length))
  lines.push(
    `${pad(`${t.pass} pass, ${t.fail} fail, ${t.error} error, ${t.skipped} skipped`, idWidth + 9)}  ${padStart(String(t.turns), 5)}  ${padStart(String(t.toolCalls), 5)}  ${padStart(formatDuration(t.durationMs), 7)}  ${padStart(formatCost(t.costUsd), 7)}`,
  )
  return lines.join('\n')
}

/** Failed checks plus the end of the transcript: enough to see why without opening the JSON. */
export function renderFailure(o: ScenarioOutcome): string {
  const lines = [`\n--- ${o.id}: ${o.status.toUpperCase()}${o.reason ? ` (${o.reason})` : ''}`]
  for (const c of o.checks.filter((x) => !x.pass))
    lines.push(`  x ${c.name}${c.detail ? `\n      ${c.detail}` : ''}`)
  if (o.toolSequence && o.toolSequence.length > 0)
    lines.push(`  tools: ${o.toolSequence.join(' > ')}`)
  const steps = o.transcript?.steps ?? []
  steps.forEach((s, i) => {
    const errors = s.calls.filter((c) => c.isError)
    for (const e of errors.slice(-3))
      lines.push(`  step ${i + 1} error in ${e.tool}: ${e.text.slice(0, 300).replace(/\s+/g, ' ')}`)
    if (s.stopReason !== 'success') lines.push(`  step ${i + 1} ended: ${s.stopReason}`)
    lines.push(
      `  step ${i + 1} answer: ${s.finalText.slice(0, 600).replace(/\s+/g, ' ') || '(none)'}`,
    )
  })
  if (o.status === 'error' && o.stderrTail)
    lines.push(`  stderr: ${o.stderrTail.slice(-600).replace(/\s+/g, ' ')}`)
  return lines.join('\n')
}

export async function writeReport(dir: string, report: SuiteReport): Promise<string> {
  await mkdir(dir, { recursive: true })
  const file = path.join(dir, `${report.startedAt.replace(/[:.]/g, '-')}.json`)
  await writeFile(file, `${JSON.stringify(scrubSecrets(report), null, 2)}\n`)
  return file
}

// ---------------------------------------------------------------------------
// Recordings
// ---------------------------------------------------------------------------

export interface Recording {
  scenario: string
  /** The live run's tag: the memory world reuses it so titles and prompts match. */
  tag: string
  recordedAt: string
  model: string
  claudeVersion: string
  /** The live fixture (ids as the live server created them). */
  fixture: unknown
  transcript: Transcript
}

/**
 * Signed URLs (S3 presigned exports, share links) and Narrative credentials
 * (an upload session's token, a personal access token an agent echoed) must
 * not land in the repo (recordings) nor stay on disk (reports).
 */
export function scrubSecrets(value: unknown): unknown {
  if (typeof value === 'string') {
    return maskCredentials(
      value.replace(
        /(https?:\/\/[^\s"?]+)\?[^\s"]*(X-Amz-Signature|token|sig)=[^\s"]*/gi,
        '$1?<redacted>',
      ),
      '<redacted>',
    )
  }
  if (Array.isArray(value)) return value.map(scrubSecrets)
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrubSecrets(v)]))
  }
  return value
}

export async function writeRecording(dir: string, recording: Recording): Promise<string> {
  await mkdir(dir, { recursive: true })
  const file = path.join(dir, `${recording.scenario}.json`)
  await writeFile(file, `${JSON.stringify(scrubSecrets(recording), null, 2)}\n`)
  return file
}
