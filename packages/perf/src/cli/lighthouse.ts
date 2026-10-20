/**
 * cli/lighthouse.ts — `just lighthouse` (docs/plans/performance.md → G2).
 *
 * It used to build without NODE_ENV=production, serve the build without a
 * backend and audit `/` — the login page — and upload the report to Google's
 * temporary public storage. Now: a production build (node/webBuild.ts) served
 * by `vite preview` in front of the dev backend, a deck seeded through the
 * command API (scenes.ts, ten slides with pictures), Lighthouse's desktop
 * preset on its `/deck/:id`, N runs (default 5) as the bench
 * `deck.open.lighthouse`, stored and compared with this machine's baseline.
 * A regression beyond the bench's threshold exits 1; `just perf-accept
 * deck.open.lighthouse` takes the latest run as the new baseline. Reports
 * stay local (`~/.cache/narrative-perf/<machine>/details/`).
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { comparability } from '../fingerprint.js'
import { formatComparisons, formatFingerprint } from '../report.js'
import { compareResults, runBench } from '../result.js'
import { deckOps } from '../scenes.js'
import { LIGHTHOUSE_BENCH_ID, SYSTEM_BENCHES } from '../catalog/system.js'
import { repoRoot } from '../node/budgetFiles.js'
import { collectFingerprint, machineName } from '../node/fingerprint.js'
import { photoFiles } from '../node/photos.js'
import { openResultStore } from '../node/store.js'
import { buildWeb, builtVersion, reachable, startPreview } from '../node/webBuild.js'

const API = process.env['NARRATIVE_API_URL'] ?? 'http://localhost:3001'
const WEB_ORIGIN = process.env['NARRATIVE_WEB_URL'] ?? 'http://localhost:5173'

async function api<T>(route: string, body: unknown): Promise<T> {
  const res = await fetch(`${API}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Origin: WEB_ORIGIN },
    body: JSON.stringify(body),
  })
  const json = (await res.json()) as T & { ok?: boolean; error?: { message: string } }
  if (!res.ok || json.ok === false)
    throw new Error(`${route}: ${res.status} ${json.error?.message ?? JSON.stringify(json)}`)
  return json
}

async function command<T>(deckId: string, name: string, input: unknown): Promise<T> {
  const r = await api<{ result: T }>('/commands', { target: { deckId }, command: name, input })
  return r.result
}

/** A ten-slide deck with pictures, as the deck scenarios seed it. */
async function seedDeck(): Promise<string> {
  const { id } = await api<{ id: string }>('/decks', { title: 'perf lighthouse' })
  const assets: string[] = []
  for (const file of photoFiles()) {
    const r = await command<{ assetId: string }>(id, 'media.upload', {
      file: { base64: readFileSync(file).toString('base64'), filename: path.basename(file) },
    })
    assets.push(r.assetId)
  }
  const { ops } = deckOps(10, assets)
  for (let i = 0; i < ops.length; i += 400)
    await command(id, 'ops.apply', { ops: ops.slice(i, i + 400) })
  return id
}

async function deleteDeck(id: string): Promise<void> {
  await fetch(`${API}/decks/${id}`, { method: 'DELETE', headers: { Origin: WEB_ORIGIN } }).catch(
    () => undefined,
  )
}

interface Lhr {
  lighthouseVersion: string
  environment: { hostUserAgent: string }
  categories: { performance: { score: number | null } }
  audits: Record<string, { numericValue?: number }>
}

function lighthouseOnce(root: string, url: string, out: string): Promise<Lhr> {
  return new Promise((resolve, reject) => {
    const bin = path.join(root, 'node_modules', '.bin', 'lighthouse')
    const child = spawn(
      bin,
      [
        url,
        '--preset=desktop',
        '--only-categories=performance',
        '--output=json',
        `--output-path=${out}`,
        '--quiet',
        '--chrome-flags=--headless=new --no-first-run --window-size=1440,900',
        // The editor never goes network-idle for long (the sync socket).
        '--max-wait-for-load=60000',
      ],
      { cwd: root, stdio: ['ignore', 'ignore', 'pipe'], env: process.env },
    )
    let err = ''
    child.stderr.on('data', (b: Buffer) => (err += b.toString()))
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`lighthouse exited ${code}: ${err.slice(-2000)}`))
      resolve(JSON.parse(readFileSync(out, 'utf8')) as Lhr)
    })
  })
}

export async function lighthouse(args: readonly string[]): Promise<number> {
  const root = repoRoot()
  const runsArg = args.find((a) => a.startsWith('--runs='))
  const runs = runsArg === undefined ? 5 : Number(runsArg.slice('--runs='.length))
  if (!(await reachable(`${API}/health`)))
    throw new Error(`the dev backend (${API}) does not answer: start \`just dev\``)
  // Lighthouse's Chrome: CHROME_PATH, else Playwright's Chromium.
  if (process.env['CHROME_PATH'] === undefined) {
    try {
      const { chromium } = (await import('playwright-core')) as {
        chromium: { executablePath(): string }
      }
      process.env['CHROME_PATH'] = chromium.executablePath()
    } catch {
      /* chrome-launcher looks for an installed Chrome */
    }
  }
  const webDir = path.join(root, 'apps', 'web')
  console.log('PERF lighthouse: building prod')
  const outDir = await buildWeb(webDir, 'prod')
  const preview = await startPreview(webDir, 'prod')
  const deckId = await seedDeck()
  const store = openResultStore({ machine: machineName() })
  const reports = path.join(store.dir, 'details')
  mkdirSync(reports, { recursive: true })
  try {
    const def = SYSTEM_BENCHES.find((b) => b.id === LIGHTHOUSE_BENCH_ID)!
    const url = `${preview.url}/deck/${deckId}`
    console.log(`PERF lighthouse: ${url}, ${runs} runs`)
    let last: Lhr | null = null
    const version = builtVersion(outDir)
    const fp = collectFingerprint({
      build: {
        mode: 'prod',
        source: { kind: 'local', ...(version !== undefined ? { version } : {}) },
      },
      cwd: root,
    })
    let i = 0
    const result = await runBench(
      {
        ...def,
        run: async () => {
          const out = path.join(reports, `lighthouse-${Date.now()}-${++i}.json`)
          const lhr = await lighthouseOnce(root, url, out)
          last = lhr
          const a = (k: string): number => lhr.audits[k]?.numericValue ?? 0
          return {
            'lh.fcp': a('first-contentful-paint'),
            'lh.lcp': a('largest-contentful-paint'),
            'lh.tbt': a('total-blocking-time'),
            'lh.si': a('speed-index'),
            'lh.tti': a('interactive'),
            'lh.cls': a('cumulative-layout-shift'),
            'lh.score': lhr.categories.performance.score ?? 0,
          }
        },
      },
      undefined,
      fp,
      { warmup: 1, runs },
    )
    const ua = (last as Lhr | null)?.environment.hostUserAgent ?? ''
    const chrome = /(?:HeadlessChrome|Chrome)\/([\d.]+)/.exec(ua)?.[1] ?? 'unknown'
    result.fingerprint.browser = {
      name: 'chrome (lighthouse)',
      version: chrome,
      engine: 'chromium',
      shell: 'browser',
    }
    for (const line of formatFingerprint(result.fingerprint)) console.log(line)
    for (const [m, s] of Object.entries(result.summary))
      console.log(
        `PERF ${LIGHTHOUSE_BENCH_ID}  ${m}  median=${s.median.toFixed(m === 'lh.cls' || m === 'lh.score' ? 3 : 0)}  p90=${s.p90.toFixed(3)}  n=${s.n}`,
      )
    store.append(result)
    writeFileSync(
      path.join(reports, `${LIGHTHOUSE_BENCH_ID}-latest.json`),
      JSON.stringify(result, null, 2),
    )
    const base = store.baselineFor(result)
    if (base === undefined) {
      console.log(
        `PERF lighthouse: no baseline on ${store.machine} yet (just perf-accept ${LIGHTHOUSE_BENCH_ID})`,
      )
      return 0
    }
    const ok = comparability(base.result.fingerprint, result.fingerprint)
    if (!ok.ok) {
      console.log(`PERF lighthouse: the baseline is not comparable: ${ok.reasons.join('; ')}`)
      return 0
    }
    const comparisons = compareResults(def, base.result, result)
    for (const line of formatComparisons(LIGHTHOUSE_BENCH_ID, comparisons)) console.log(line)
    return comparisons.some((c) => c.verdict === 'regression') ? 1 : 0
  } finally {
    await deleteDeck(deckId)
    await preview.stop()
  }
}
