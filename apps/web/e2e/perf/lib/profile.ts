/**
 * e2e/perf/lib/profile.ts — a CPU profile (Chromium, CDP) around a measured
 * run, summarised as self time per function and per category (Pixi, React,
 * Yjs, Tiptap, the app's own code, GC, …). Taken from the crowded-slide
 * probe (perf-heavy-slide.spec.ts); `just perf-profile <id>` writes the
 * `.cpuprofile` next to the results (open it in Chrome DevTools → Performance).
 */

import type { CDPSession, Page } from '@playwright/test'

interface ProfileNode {
  id: number
  callFrame: { functionName: string; url: string; lineNumber: number }
}
export interface CpuProfile {
  nodes: ProfileNode[]
  samples: number[]
  timeDeltas: number[]
}

export interface ProfileSummary {
  totalMs: number
  byCategory: Record<string, number>
  top: Array<{ fn: string; ms: number; cat: string }>
}

export function category(url: string, name: string): string {
  if (name === '(idle)') return 'idle'
  if (name === '(garbage collector)') return 'gc'
  if (name === '(program)') return 'program'
  if (url === '') return 'native'
  if (/pixi/i.test(url)) return 'pixi'
  if (/react/i.test(url)) return 'react'
  if (/yjs|lib0|y-protocols|hocuspocus/i.test(url)) return 'yjs'
  if (/tiptap|prosemirror/i.test(url)) return 'tiptap'
  if (/\/src\/|@narrative|packages\//.test(url)) return 'app'
  // A production build: the app's own chunks are index-*/the route chunks.
  if (/\/assets\/(?!vendor-)/.test(url)) return 'app'
  return 'other'
}

export function summariseProfile(profile: CpuProfile, topN = 20): ProfileSummary {
  const nodeById = new Map(profile.nodes.map((n) => [n.id, n]))
  const self = new Map<number, number>()
  profile.samples.forEach((id, i) => {
    self.set(id, (self.get(id) ?? 0) + (profile.timeDeltas[i] ?? 0))
  })
  const byCategory: Record<string, number> = {}
  const byFn = new Map<string, { ms: number; cat: string }>()
  let totalMs = 0
  for (const [id, us] of self) {
    const node = nodeById.get(id)
    if (node === undefined) continue
    const { functionName, url, lineNumber } = node.callFrame
    const cat = category(url, functionName)
    const ms = us / 1000
    byCategory[cat] = (byCategory[cat] ?? 0) + ms
    if (cat === 'idle' || cat === 'program') continue
    totalMs += ms
    const file = url.split('/').pop()?.split('?')[0] ?? ''
    const key = `${functionName || '(anon)'} ${file}:${lineNumber + 1}`
    const prev = byFn.get(key)
    byFn.set(key, { ms: (prev?.ms ?? 0) + ms, cat })
  }
  const top = [...byFn.entries()]
    .map(([fn, v]) => ({ fn, ms: v.ms, cat: v.cat }))
    .sort((a, b) => b.ms - a.ms)
    .slice(0, topN)
  return { totalMs, byCategory, top }
}

export interface Profiler {
  start(): Promise<void>
  stop(): Promise<CpuProfile>
}

export async function cdpProfiler(page: Page): Promise<Profiler> {
  const cdp: CDPSession = await page.context().newCDPSession(page)
  await cdp.send('Profiler.enable')
  // 250 µs sampling: fine enough for per-frame work, light enough not to
  // become the work (100 µs doubled a drag's wall time).
  await cdp.send('Profiler.setSamplingInterval', { interval: 250 })
  return {
    start: async () => void (await cdp.send('Profiler.start')),
    stop: async () =>
      ((await cdp.send('Profiler.stop')) as unknown as { profile: CpuProfile }).profile,
  }
}
