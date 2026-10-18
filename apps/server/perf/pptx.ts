/**
 * perf/pptx.ts — how long a PowerPoint import and export take, and how much
 * memory they need, per phase (docs/plans/performance.md, G7 / X1 / X2).
 *
 *   just perf-pptx                         # the synthetic deck, 5 runs
 *   just perf-pptx --runs 9                # more runs
 *   just perf-pptx --deck ~/decks/big.pptx # a real deck instead
 *   just perf-pptx --json out.json         # also write the raw runs (A/B)
 *   just perf-pptx --dump dir/             # each run's normalised model, to diff runs
 *   just perf-pptx --cpu-prof              # one profile per run (node_modules/.cache/perf-pptx/profiles)
 *
 * Each run is its own Node process, so its peak RSS (`maxRSS`) is that run's
 * alone and no garbage of an earlier run counts. A run imports the deck the
 * way the server does (`importDeckFromPptxBytes`: the dev Postgres and MinIO,
 * a user and folder of its own) and exports it back
 * (`exportDeckToPptx`), then deletes everything it created — rows and stored
 * files. Videos are counted instead of queued, so no transcode job reaches a
 * worker of the shared dev stack.
 *
 * Phases come from the importer's and exporter's own marks
 * (src/pptx/phases.ts); a phase's RSS is the highest resident set seen while
 * it ran (sampled every 5 ms, and at its end). The fingerprints hash the
 * imported model and the exported package with ids replaced by ordinals: two
 * revisions that print the same fingerprints produced the same deck.
 *
 * Needs the docker services (`just services`); writes rows into the dev
 * database while it runs.
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { subscribe, unsubscribe } from 'node:diagnostics_channel'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import * as Y from 'yjs'
import JSZip from 'jszip'
import { nanoid } from 'nanoid'
import type { FastifyBaseLogger } from 'fastify'
import { DEFAULT_SPEC, GENERATOR_VERSION, buildSyntheticDeck } from './syntheticDeck.js'
import { median, quantile } from '@narrative/perf/stats'
import { PPTX_PHASE_CHANNEL, type PptxPhaseMark } from '../src/pptx/phases.js'

const HERE = dirname(fileURLToPath(import.meta.url))

// ─── Arguments ────────────────────────────────────────────────────────────

const argv = process.argv.slice(2)
const flag = (name: string): boolean => argv.includes(name)
const option = (name: string): string | undefined => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}

interface PhaseResult {
  op: PptxPhaseMark['op']
  phase: string
  ms: number
  rssMb: number
}

interface RunResult {
  phases: PhaseResult[]
  importMs: number
  exportMs: number
  maxRssMb: number
  slides: number
  objects: number
  mediaRows: number
  videos: number
  exportBytes: number
  warnings: number
  modelFingerprint: string
  exportFingerprint: string
}

const mb = (bytes: number): number => Math.round((bytes / 1024 / 1024) * 10) / 10

// ─── One run (child process) ──────────────────────────────────────────────

async function child(deckPath: string): Promise<void> {
  // Imported here, not at the top: the parent needs neither a database nor
  // the server's environment.
  const { eq } = await import('drizzle-orm')
  const { db, pool } = await import('../src/db/client.js')
  const { deckUpdates, decks, folderPermissions, folders, mediaAssets, users } =
    await import('../src/db/schema.js')
  const { importDeckFromPptxBytes } = await import('../src/pptx/importDeck.js')
  const { exportDeckToPptx } = await import('../src/pptx/exportDeck.js')
  const { purgeDeckBucketPrefix } = await import('../src/media/bucketCleanup.js')
  const { hydrateSlideDoc, listSlides, getSlideNotesDoc } = await import('@narrative/slide-model')

  let warnings = 0
  const log = {
    level: 'warn',
    info: () => undefined,
    debug: () => undefined,
    trace: () => undefined,
    silent: () => undefined,
    warn: (obj: unknown, msg?: string) => {
      warnings++
      if (process.env['PERF_VERBOSE'] === '1') console.error('warn', msg, obj)
    },
    error: (obj: unknown, msg?: string) => console.error('error', msg, obj),
    fatal: (obj: unknown, msg?: string) => console.error('fatal', msg, obj),
    child: () => log,
  }
  // The services take a Fastify logger; this one has every method they call.
  const fastifyLog = log as unknown as FastifyBaseLogger

  const bytes = readFileSync(deckPath)
  const owner = `perf-${nanoid(10)}`
  const folderId = nanoid(12)
  await db.insert(users).values({ sub: owner, email: `${owner}@example.test`, name: 'Perf' })
  await db.insert(folders).values({ id: folderId, ownerUserId: owner, name: 'perf-pptx' })
  await db.insert(folderPermissions).values({ folderId, userId: owner, role: 'owner' })

  // Phase clock: every mark closes the phase that ran since the previous one.
  const phases: PhaseResult[] = []
  let phaseStart = 0
  let phasePeak = 0
  const sampler = setInterval(() => {
    phasePeak = Math.max(phasePeak, process.memoryUsage.rss())
  }, 5)
  const begin = (): void => {
    phaseStart = performance.now()
    phasePeak = process.memoryUsage.rss()
  }
  const onMark = (message: unknown): void => {
    const m = message as PptxPhaseMark
    const now = performance.now()
    const rss = Math.max(phasePeak, process.memoryUsage.rss())
    phases.push({ op: m.op, phase: m.phase, ms: now - phaseStart, rssMb: mb(rss) })
    phaseStart = now
    phasePeak = process.memoryUsage.rss()
  }
  subscribe(PPTX_PHASE_CHANNEL, onMark)

  let deckId: string | undefined
  try {
    let videos = 0
    begin()
    const t0 = performance.now()
    const imported = await importDeckFromPptxBytes({
      bytes,
      folderId,
      ownerUserId: owner,
      filenameForTitle: basename(deckPath),
      db,
      log,
      enqueueVideo: async () => {
        videos++
      },
    })
    const importMs = performance.now() - t0
    if (!imported.ok) throw new Error(`import failed: ${JSON.stringify(imported.error)}`)
    deckId = imported.result.deckId

    begin()
    const t1 = performance.now()
    const exported = await exportDeckToPptx({ db, log: fastifyLog, hocuspocus: () => null }, deckId)
    const exportMs = performance.now() - t1
    if (!exported.ok) throw new Error(`export failed: ${exported.error}`)
    unsubscribe(PPTX_PHASE_CHANNEL, onMark)
    clearInterval(sampler)
    const maxRssMb = mb(process.resourceUsage().maxRSS * 1024)

    // ── Fingerprints: ids → ordinals, assets → what they hold ────────────
    const rows = await db
      .select({
        id: mediaAssets.id,
        name: mediaAssets.originalFilename,
        mime: mediaAssets.mimeType,
        size: mediaAssets.sizeBytes,
        width: mediaAssets.width,
        height: mediaAssets.height,
        kind: mediaAssets.kind,
        family: mediaAssets.fontFamily,
        weight: mediaAssets.fontWeight,
      })
      .from(mediaAssets)
      .where(eq(mediaAssets.deckId, deckId))
    const [update] = await db
      .select({ update: deckUpdates.update })
      .from(deckUpdates)
      .where(eq(deckUpdates.deckId, deckId))
    const doc = new Y.Doc()
    Y.applyUpdate(doc, new Uint8Array(update!.update))
    const handles = hydrateSlideDoc(doc)
    const slides = listSlides(handles)

    const ids = new Map<string, string>()
    for (const r of rows) {
      ids.set(r.id, `asset:${r.kind}:${r.name}:${r.mime}:${r.size}:${r.width}x${r.height}`)
    }
    const ordinal = (id: string, prefix: string): void => {
      if (!ids.has(id)) ids.set(id, `${prefix}${ids.size}`)
    }
    for (const s of slides) {
      ordinal(s.id, 'slide')
      for (const o of s.objects) {
        ordinal(o.id, 'object')
        if (o.groupId !== undefined) ordinal(o.groupId, 'group')
      }
    }
    // Any other id the importer generates (animation steps, table cells, …)
    // becomes an ordinal in traversal order — keys sorted, so stable.
    const normal = (v: unknown, key = ''): unknown => {
      if (v instanceof Y.Text) return { delta: normal(v.toDelta()) }
      if (typeof v === 'string') {
        if (!ids.has(v) && (key === 'id' || key.endsWith('Id'))) ordinal(v, 'id')
        return ids.get(v) ?? v
      }
      if (Array.isArray(v)) return v.map((x) => normal(x, key))
      if (v !== null && typeof v === 'object') {
        const out: Record<string, unknown> = {}
        for (const k of Object.keys(v).sort()) out[k] = normal((v as Record<string, unknown>)[k], k)
        return out
      }
      return v
    }
    const model = {
      slides: slides.map((s) => ({ ...s, notes: getSlideNotesDoc(handles, s.id) ?? [] })),
      media: rows
        .map((r) => `${ids.get(r.id)}:${r.family ?? ''}:${r.weight ?? ''}`)
        .sort((a, b) => a.localeCompare(b)),
      result: { ...imported.result, deckId: undefined, placeholders: undefined },
    }
    const modelJson = JSON.stringify(normal(model), null, 1)
    const modelFingerprint = sha(modelJson)
    // `--dump DIR`: the normalised model per run, to diff runs that disagree.
    const dump = process.env['PERF_PPTX_DUMP']
    if (dump !== undefined) writeFileSync(join(dump, `model-${process.pid}.json`), modelJson)
    doc.destroy()

    // The package, entry by entry: what it says, not how it was compressed.
    const zip = await JSZip.loadAsync(exported.buffer)
    const idPattern = new RegExp(
      [...ids.keys()].map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') || '(?!)',
      'g',
    )
    const parts: string[] = []
    for (const name of Object.keys(zip.files).sort()) {
      const entry = zip.files[name]!
      if (entry.dir || name === 'docProps/core.xml') continue
      if (/\.(xml|rels)$/.test(name)) {
        const xml = await entry.async('string')
        parts.push(`${name}:${sha(xml.replace(idPattern, (m) => ids.get(m) ?? m))}`)
      } else {
        parts.push(`${name}:${sha(await entry.async('nodebuffer'))}`)
      }
    }
    const exportFingerprint = sha(parts.join('\n'))

    const result: RunResult = {
      phases,
      importMs,
      exportMs,
      maxRssMb,
      slides: imported.result.slideCount,
      objects: imported.result.objectsCreated,
      mediaRows: rows.length,
      videos,
      exportBytes: exported.buffer.byteLength,
      warnings,
      modelFingerprint: modelFingerprint.slice(0, 16),
      exportFingerprint: exportFingerprint.slice(0, 16),
    }
    process.stdout.write(`PERF_RESULT ${JSON.stringify(result)}\n`)
  } finally {
    clearInterval(sampler)
    if (deckId !== undefined) {
      await db.delete(decks).where(eq(decks.id, deckId))
      await purgeDeckBucketPrefix(db, deckId, log)
    }
    await db.delete(folders).where(eq(folders.id, folderId))
    await db.delete(users).where(eq(users.sub, owner))
    await pool.end()
  }
}

function sha(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

// ─── The parent: input, runs, statistics ──────────────────────────────────

async function syntheticDeckPath(): Promise<string> {
  const spec = {
    slides: Number(option('--slides') ?? DEFAULT_SPEC.slides),
    images: Number(option('--images') ?? DEFAULT_SPEC.images),
    seed: Number(option('--seed') ?? DEFAULT_SPEC.seed),
  }
  const dir = resolve(HERE, '../node_modules/.cache/perf-pptx')
  const file = join(
    dir,
    `synthetic-v${GENERATOR_VERSION}-${spec.slides}s-${spec.images}i-seed${spec.seed}.pptx`,
  )
  if (!existsSync(file)) {
    console.log(`Generating ${basename(file)} (once; cached in ${dir}) …`)
    mkdirSync(dir, { recursive: true })
    const t = performance.now()
    writeFileSync(file, await buildSyntheticDeck(spec))
    console.log(`  done in ${((performance.now() - t) / 1000).toFixed(1)} s`)
  }
  return file
}

function runChild(deckPath: string, profileDir: string | undefined): Promise<RunResult> {
  const nodeArgs = [...process.execArgv]
  if (profileDir !== undefined) nodeArgs.push('--cpu-prof', `--cpu-prof-dir=${profileDir}`)
  return new Promise((ok, fail) => {
    const p = spawn(
      process.execPath,
      [...nodeArgs, fileURLToPath(import.meta.url), '--child', deckPath],
      {
        stdio: ['ignore', 'pipe', 'inherit'],
        env: {
          ...process.env,
          ...(option('--dump') !== undefined ? { PERF_PPTX_DUMP: resolve(option('--dump')!) } : {}),
        },
      },
    )
    let out = ''
    p.stdout.on('data', (d: Buffer) => (out += d.toString()))
    p.on('error', fail)
    p.on('exit', (code) => {
      const line = out.split('\n').find((l) => l.startsWith('PERF_RESULT '))
      if (code !== 0 || line === undefined) {
        fail(new Error(`run exited with ${code}\n${out}`))
        return
      }
      ok(JSON.parse(line.slice('PERF_RESULT '.length)) as RunResult)
    })
  })
}

async function parent(): Promise<void> {
  const runs = Number(option('--runs') ?? 5)
  const real = option('--deck')
  const deckPath = real !== undefined ? resolve(real) : await syntheticDeckPath()
  const deck = readFileSync(deckPath)
  const profileDir = flag('--cpu-prof')
    ? resolve(HERE, '../node_modules/.cache/perf-pptx/profiles')
    : undefined
  if (profileDir !== undefined) mkdirSync(profileDir, { recursive: true })

  console.log(
    `Deck ${basename(deckPath)}: ${mb(deck.byteLength)} MB, sha256 ${sha(deck).slice(0, 16)}`,
  )
  console.log(`Node ${process.version}, ${process.platform}/${process.arch}, ${runs} runs\n`)

  const results: RunResult[] = []
  for (let i = 0; i < runs; i++) {
    const r = await runChild(deckPath, profileDir)
    results.push(r)
    console.log(
      `  run ${i + 1}: import ${(r.importMs / 1000).toFixed(2)} s, export ${(r.exportMs / 1000).toFixed(2)} s, peak RSS ${r.maxRssMb} MB`,
    )
  }

  const first = results[0]!
  console.log(
    `\n${first.slides} slides, ${first.objects} objects, ${first.mediaRows} media rows` +
      ` (${first.videos} videos), export ${mb(first.exportBytes)} MB, ${first.warnings} warnings`,
  )

  // Phase table, in the order the phases ran.
  const keys: string[] = []
  for (const p of first.phases) {
    const k = `${p.op}.${p.phase}`
    if (!keys.includes(k)) keys.push(k)
  }
  const row = (label: string, ms: number[], rss: number[]): string =>
    `${label.padEnd(20)} ${String(Math.round(median(ms))).padStart(8)} ${String(
      Math.round(quantile(ms, 0.95)),
    ).padStart(8)} ${String(Math.max(...rss)).padStart(9)}`
  console.log(
    `\n${'phase'.padEnd(20)} ${'p50 ms'.padStart(8)} ${'p95 ms'.padStart(8)} ${'RSS MB'.padStart(9)}`,
  )
  for (const k of keys) {
    const ms = results.map((r) =>
      r.phases.filter((p) => `${p.op}.${p.phase}` === k).reduce((a, p) => a + p.ms, 0),
    )
    const rss = results.map((r) =>
      Math.max(0, ...r.phases.filter((p) => `${p.op}.${p.phase}` === k).map((p) => p.rssMb)),
    )
    console.log(row(k, ms, rss))
  }
  const peaks = results.map((r) => r.maxRssMb)
  console.log(
    row(
      'import (wall)',
      results.map((r) => r.importMs),
      peaks,
    ),
  )
  console.log(
    row(
      'export (wall)',
      results.map((r) => r.exportMs),
      peaks,
    ),
  )
  // Two views of the peak: the kernel's maxRSS for the process, and the
  // highest `process.memoryUsage.rss()` sampled. They disagree on macOS
  // (task resident size vs ru_maxrss), so both are printed; compare like
  // with like across revisions.
  const sampled = results.map((r) => Math.max(...r.phases.map((p) => p.rssMb)))
  console.log(
    `\npeak RSS per run: maxRSS p50 ${Math.round(median(peaks))} MB, max ${Math.max(...peaks)} MB;` +
      ` sampled p50 ${Math.round(median(sampled))} MB, max ${Math.max(...sampled)} MB`,
  )

  const models = new Set(results.map((r) => r.modelFingerprint))
  const packages = new Set(results.map((r) => r.exportFingerprint))
  console.log(`model fingerprint  ${[...models].join(' ')}`)
  console.log(`export fingerprint ${[...packages].join(' ')}`)
  if (models.size > 1 || packages.size > 1) {
    console.log('!! the runs disagree: the import or export is not deterministic')
    process.exitCode = 1
  }
  if (profileDir !== undefined) console.log(`CPU profiles in ${profileDir}`)

  const json = option('--json')
  if (json !== undefined) {
    writeFileSync(resolve(json), JSON.stringify({ deck: deckPath, runs: results }, null, 2))
  }
}

if (flag('--child')) {
  await child(argv[argv.indexOf('--child') + 1]!)
} else {
  await parent()
}
