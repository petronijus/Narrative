/**
 * perf/commands.ts — what an agent's command costs on the server, per phase
 * (docs/plans/performance.md, G7 / S3). No LLM: the probe drives the real
 * ServerHost the MCP server and the command API call, against the real
 * Hocuspocus document engine and the dev Postgres, on a seeded deck.
 *
 *   just perf-commands [--slides 100] [--commands 200] [--batches 10] [--pace 0] [--folder-live]
 *                      [--json out.json]
 *
 * What it builds (under random ids, deleted at the end):
 *   a user; a folder with colour and text-style tokens, the example style
 *   pack compiled into it and three uploaded font faces (rows only, no
 *   files); a deck of `--slides` slides, each with a title, a three-paragraph
 *   body, four rectangles and an ellipse, stored as one snapshot row the way
 *   the sync server stores it and NOT loaded — as when an agent works on a
 *   deck nobody has open. `--folder-live` keeps the folder document loaded
 *   (an editor open on one of its decks), so tokens and the pack come from
 *   memory instead of the stored row.
 *
 * What it runs: `--commands` commands in one agent session, a fixed mix —
 * object.update, object.create, text.setBoxTypography (reads the folder's
 * fonts), text.style.apply (reads its tokens), and every tenth a
 * slide.applyLayout (reads pack and tokens) — then `--batches` atomic
 * ops.apply batches of 10 and of 100 object.update ops each. `--pace` waits
 * that many ms after each command, as an agent's think time does: past the
 * store debounce (2 s) each command is then stored on its own again.
 *
 * Per command, p50 / p95 of the wall time and of each phase:
 *   admit    access check (deck role) and run resolution
 *   context  the folder's tokens / fonts / style pack (only for commands
 *            that declare them)
 *   lease    the document lease (the first one loads the deck from Postgres)
 *   transact the Yjs work under the lease (prepare, the handler, for
 *            ops.apply the fork), the store excluded
 *   store    a document store the command waits for
 *   audit    agent_ops insert, run touch
 * plus the database statements and writes the process sent while the
 * command ran, and over the whole run: document stores, bytes they wrote,
 * and the same per command. Stores that run on the debounce, off any
 * command's path, are counted in the totals and as "off path".
 *
 * Numbers depend on the machine and on what else uses the dev Postgres;
 * compare runs on one machine, back to back. Excluded from the build
 * (tsconfig.build.json).
 */

import { parseArgs } from 'node:util'
import { writeFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { nanoid } from 'nanoid'
import pg from 'pg'
import * as Y from 'yjs'
import { eq } from 'drizzle-orm'
import type { Extension, onStoreDocumentPayload } from '@hocuspocus/server'
import type { FastifyBaseLogger } from 'fastify'
import { exampleStylePack, type RectangleObject, type TextObject } from '@narrative/shared'
import {
  addObjects,
  addSlide,
  createSlideDoc,
  getSlideObjectsCtx,
  PARAGRAPH_SEP,
} from '@narrative/slide-model'
import type { CommandInvocation } from '@narrative/commands'
import { db, pool } from '../src/db/client.js'
import { agentRuns, deckUpdates, decks, folders, mediaAssets, users } from '../src/db/schema.js'
import { createHocuspocusServer } from '../src/hocuspocus/index.js'
import { createAgentRuntime, type AgentRuntime } from '../src/agent/runtime.js'
import { createAgentPrincipalKeys } from '../src/agent/presence.js'
import { createDbAccess, type AgentAccess } from '../src/agent/access.js'
import { createDrizzleRunStore, type RunStore } from '../src/agent/runStore.js'
import { createDbFolderTokensReader } from '../src/agent/folderTokens.js'
import { createDbFolderFontsReader } from '../src/agent/folderFonts.js'
import { createDbFolderStylePackReader } from '../src/agent/folderStylePack.js'
import type { DocumentLease } from '../src/agent/documents.js'
import type { HostRequest, HostResult } from '../src/agent/serverHost.js'
import { writeLiveDoc } from '../src/services/liveDocs.js'
import { quantile, summarize as summarizeSample } from '@narrative/perf/stats'

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

const { values: args } = parseArgs({
  options: {
    slides: { type: 'string', default: '100' },
    commands: { type: 'string', default: '200' },
    batches: { type: 'string', default: '10' },
    pace: { type: 'string', default: '0' },
    'folder-live': { type: 'boolean', default: false },
    json: { type: 'string' },
  },
})
const SLIDES = Number.parseInt(args.slides, 10)
const COMMANDS = Number.parseInt(args.commands, 10)
const BATCHES = Number.parseInt(args.batches, 10)
/** Think time between commands, ms (an LLM takes seconds per tool call). */
const PACE = Number.parseInt(args.pace, 10)
const FOLDER_LIVE = args['folder-live']

// ---------------------------------------------------------------------------
// Instrumentation: phases of the command in flight, database statements
// ---------------------------------------------------------------------------

const PHASES = ['admit', 'context', 'lease', 'transact', 'store', 'audit'] as const
type Phase = (typeof PHASES)[number]

interface Sample {
  command: string
  ok: boolean
  total: number
  phases: Record<Phase, number>
  statements: number
  writes: number
}

interface Totals {
  stores: number
  storesOffPath: number
  storedBytes: number
  storeMs: number[]
}

let current: Sample | null = null
/** Depth of lease.transact calls in flight: a store inside one is on a command's path. */
let inTransact = 0
let counting = false
const totals: Totals = { stores: 0, storesOffPath: 0, storedBytes: 0, storeMs: [] }

function addPhase(phase: Phase, dt: number): void {
  if (current !== null) current.phases[phase] += dt
}

function timed<A extends unknown[], R>(phase: Phase, fn: (...a: A) => Promise<R>) {
  return async (...a: A): Promise<R> => {
    const t0 = performance.now()
    try {
      return await fn(...a)
    } finally {
      addPhase(phase, performance.now() - t0)
    }
  }
}

// Every statement this process sends, by verb; `writes` = INSERT/UPDATE/DELETE.
const ClientProto = pg.Client.prototype as unknown as { query: (...a: unknown[]) => unknown }
const originalQuery = ClientProto.query
ClientProto.query = function (this: unknown, ...a: unknown[]) {
  if (counting) {
    const first = a[0]
    const text =
      typeof first === 'string' ? first : ((first as { text?: string } | null)?.text ?? '')
    if (current !== null) {
      current.statements += 1
      if (/^\s*(insert|update|delete)\b/i.test(text)) current.writes += 1
    }
    // A document snapshot: its bytes are the parameters of the insert.
    if (/^\s*insert into "(deck|folder|component)_updates"/i.test(text)) {
      const values = (Array.isArray(a[1]) ? a[1] : (first as { values?: unknown[] }).values) ?? []
      for (const v of values) if (v instanceof Uint8Array) totals.storedBytes += v.byteLength
    }
  }
  return originalQuery.apply(this, a)
}

function newSample(command: string): Sample {
  return {
    command,
    ok: false,
    total: 0,
    phases: Object.fromEntries(PHASES.map((p) => [p, 0])) as Record<Phase, number>,
    statements: 0,
    writes: 0,
  }
}

// ---------------------------------------------------------------------------
// The seeded deck
// ---------------------------------------------------------------------------

const slideId = (n: number): string => `p${n}`

function buildDeck(slides: number): Uint8Array {
  const deck = createSlideDoc()
  // createSlideDoc seeds no slide; ids are fixed so the workload can name things.
  for (let n = 0; n < slides; n++) {
    const slide = addSlide(deck)
    deck.slides.get(n).set('id', slideId(n))
    void slide
    const objects = getSlideObjectsCtx(deck, slideId(n))!
    const text = (id: string, y: number, body: string, size: number): TextObject => ({
      id,
      type: 'text',
      x: 120,
      y,
      width: 1680,
      height: size * 2,
      text: body,
      fontSize: size,
      fontWeight: 'normal',
      color: 0x111111,
      align: 'left',
      rotation: 0,
      opacity: 1,
    })
    const rect = (id: string, x: number): RectangleObject => ({
      id,
      type: 'rectangle',
      x,
      y: 760,
      width: 360,
      height: 200,
      fill: 0x4060e0,
      rotation: 0,
      opacity: 1,
    })
    addObjects(objects, [
      text(`${slideId(n)}-title`, 80, `Slide ${n + 1}: quarterly review of the programme`, 64),
      text(
        `${slideId(n)}-body`,
        260,
        [
          'Revenue grew in every region, led by Europe and the Americas, while costs held flat.',
          'The margin improved by three points; the plan for next year keeps the same mix.',
          'Open questions: hiring in the second half, and the timing of the platform launch.',
        ].join(PARAGRAPH_SEP),
        28,
      ),
      rect(`${slideId(n)}-r1`, 120),
      rect(`${slideId(n)}-r2`, 540),
      rect(`${slideId(n)}-r3`, 960),
      rect(`${slideId(n)}-r4`, 1380),
      { ...rect(`${slideId(n)}-e1`, 1500), type: 'ellipse', y: 80, width: 200, height: 200 },
    ])
  }
  const update = Y.encodeStateAsUpdate(deck.doc)
  deck.doc.destroy()
  return update
}

/** The command a step of the workload runs. */
function workload(i: number): CommandInvocation {
  const s = slideId(i % SLIDES)
  if (i % 10 === 9)
    return {
      command: 'slide.applyLayout',
      input: {
        slide: s,
        layoutId: 'title-bullets',
        content: {
          title: `Results, part ${i}`,
          bullets: { paragraphs: [{ text: 'Europe +12%' }, { text: 'Americas +8%' }] },
        },
      },
    }
  switch (i % 4) {
    case 0:
      return {
        command: 'object.update',
        input: { slide: s, object: `${s}-r1`, patch: { x: 100 + (i % 50) } },
      }
    case 1:
      return {
        command: 'object.create',
        input: { slide: s, object: { type: 'rectangle', x: 200, y: 200, width: 80, height: 80 } },
      }
    case 2:
      return {
        command: 'text.setBoxTypography',
        input: {
          slide: s,
          objects: [`${s}-title`],
          style: { fontFamily: 'Brand Sans', fontSize: 60 + (i % 8) },
        },
      }
    default:
      return {
        command: 'text.style.apply',
        input: { slide: s, objects: [`${s}-body`], style: 'Body' },
      }
  }
}

function batchOf(size: number, round: number): CommandInvocation[] {
  return Array.from({ length: size }, (_, k) => {
    const s = slideId((round * size + k) % SLIDES)
    return {
      command: 'object.update',
      input: { slide: s, object: `${s}-r2`, patch: { y: 700 + ((round + k) % 90) } },
    }
  })
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const quietLog = {
  level: 'silent',
  fatal: () => undefined,
  error: (...a: unknown[]) => console.error('[server error]', ...a),
  warn: () => undefined,
  info: () => undefined,
  debug: () => undefined,
  trace: () => undefined,
  silent: () => undefined,
  child: () => quietLog,
} as unknown as FastifyBaseLogger

async function main(): Promise<void> {
  const suffix = nanoid(8)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, 'x')
  const userId = `perf-user-${suffix}`
  const principalKeys = createAgentPrincipalKeys(
    `perf-only-agent-principal-key-${suffix}-0123456789`,
  )

  const server = createHocuspocusServer({ port: 0, db, principalKeys })
  const hocuspocus = server.hocuspocus

  // Document stores: count, bytes, time; on a command's path or not.
  const persistence = hocuspocus.configuration.extensions.find(
    (e) => e.constructor.name === 'PostgresPersistence',
  ) as Extension & { onStoreDocument(p: onStoreDocumentPayload): Promise<void> }
  const store = persistence.onStoreDocument.bind(persistence)
  persistence.onStoreDocument = async (payload) => {
    const t0 = performance.now()
    await store(payload)
    const dt = performance.now() - t0
    if (!counting) return
    totals.stores += 1
    totals.storeMs.push(dt)
    if (inTransact > 0) addPhase('store', dt)
    else totals.storesOffPath += 1
  }

  // The shared dev database: never close other processes' runs or sweep them.
  const realRuns = createDrizzleRunStore(db)
  const runStore: RunStore = {
    ...realRuns,
    closeAllOpen: async () => 0,
    deleteRunsInactiveBefore: async () => 0,
    insertOp: timed('audit', realRuns.insertOp),
    touchRun: timed('audit', realRuns.touchRun),
    setOpConfirmation: timed('audit', realRuns.setOpConfirmation),
    insertRun: timed('admit', realRuns.insertRun),
    userDisplayName: timed('admit', realRuns.userDisplayName),
  }
  const realAccess = createDbAccess(db)
  const access: AgentAccess = {
    deckRole: timed('admit', realAccess.deckRole),
    componentRole: timed('admit', realAccess.componentRole),
    folderRole: timed('admit', realAccess.folderRole),
    folderContentRole: timed('admit', realAccess.folderContentRole),
  }
  const liveDeps = { db, log: quietLog, hocuspocus: () => hocuspocus }
  const runtime: AgentRuntime = await createAgentRuntime({
    db,
    log: quietLog,
    hocuspocus,
    appOrigin: 'http://localhost:5173',
    principalKeys,
    store: runStore,
    access,
    exportSweep: null,
    afterDeckRevert: async () => undefined,
    folderTokens: timed('context', createDbFolderTokensReader(liveDeps)),
    folderFonts: timed('context', createDbFolderFontsReader(db)),
    folderStylePack: timed('context', createDbFolderStylePackReader(liveDeps)),
  })

  // The lease and the work under it.
  const documents = runtime.documents
  const acquire = documents.acquire.bind(documents)
  documents.acquire = async (name: string): Promise<DocumentLease> => {
    const t0 = performance.now()
    const lease = await acquire(name)
    addPhase('lease', performance.now() - t0)
    return {
      ...lease,
      documentName: lease.documentName,
      document: lease.document,
      release: () => lease.release(),
      transact: async (fn, ...rest) => {
        const t1 = performance.now()
        const storeBefore = current?.phases.store ?? 0
        inTransact += 1
        try {
          return await lease.transact(fn, ...rest)
        } finally {
          inTransact -= 1
          const stored = (current?.phases.store ?? 0) - storeBefore
          addPhase('transact', performance.now() - t1 - stored)
        }
      },
    }
  }

  const session = { surface: 'api' as const, sessionKey: `perf:${suffix}`, clientName: 'perf' }
  const exec = (req: Omit<HostRequest, 'actor' | 'surface'>): Promise<HostResult> =>
    runtime.host.execute({ actor: { userId }, ...session, ...req })
  const must = (r: HostResult): Extract<HostResult, { ok: true }> => {
    if (!r.ok) throw new Error(`${r.command}: ${r.error.code} ${r.error.message}`)
    return r
  }

  // Everything the probe created goes, however the run ends: also when the
  // output is cut off (`| head`) or the run is interrupted.
  let removed: Promise<void> | null = null
  const removeRows = (): Promise<void> =>
    (removed ??= (async () => {
      // The user's runs (their ops cascade), decks (rows cascade), folders (fonts cascade), the user.
      await db.delete(agentRuns).where(eq(agentRuns.userSub, userId))
      await db.delete(decks).where(eq(decks.ownerUserId, userId))
      await db.delete(folders).where(eq(folders.ownerUserId, userId))
      await db.delete(users).where(eq(users.sub, userId))
    })())
  process.stdout.on('error', () => undefined)
  for (const signal of ['SIGINT', 'SIGTERM'] as const)
    process.once(signal, () => {
      void removeRows().finally(() => process.exit(130))
    })

  let folderId: string | null = null
  try {
    // --- Seed --------------------------------------------------------------
    await db.insert(users).values({ sub: userId, email: `${userId}@example.test`, name: 'Perf' })
    const folder = must(
      await exec({ target: {}, invocation: { command: 'folder.create', input: { name: 'Perf' } } }),
    ).result as { id: string }
    folderId = folder.id
    const deck = must(
      await exec({
        target: {},
        invocation: { command: 'deck.create', input: { title: 'Perf deck', folderId } },
      }),
    ).result as { id: string }
    const deckId = deck.id
    const deckState = buildDeck(SLIDES)
    // Nobody has the new deck loaded: its first snapshot row, as a store writes it.
    await db.insert(deckUpdates).values({ deckId, update: deckState })
    // Tokens through the sync server, then the example pack set and compiled.
    await writeLiveDoc(liveDeps, 'folder', folderId, (doc) => {
      const root = doc.getMap<unknown>('tokens')
      const cat = (name: string): Y.Map<unknown> => {
        const m = new Y.Map<unknown>()
        root.set(name, m)
        return m
      }
      const put = (into: Y.Map<unknown>, id: string, fields: Record<string, unknown>): void => {
        const m = new Y.Map<unknown>()
        into.set(id, m)
        for (const [k, v] of Object.entries(fields)) m.set(k, v)
      }
      const colors = cat('colors')
      put(colors, 'ink', { name: 'Ink', value: '#222222' })
      put(colors, 'brand', { name: 'Brand', value: '#2040c0' })
      const textStyles = cat('textStyles')
      put(textStyles, 'title', { name: 'Title', family: 'Inter', weight: 700, size: 72 })
      put(textStyles, 'body', { name: 'Body', family: 'Inter', weight: 400, size: 24 })
      cat('effectStyles')
    })
    for (const input of [{ op: 'set', pack: exampleStylePack() }, { op: 'compile' }])
      must(await exec({ target: { folderId }, invocation: { command: 'style.pack.edit', input } }))
    await db.insert(mediaAssets).values(
      [300, 600, 700].map((weight) => ({
        id: `perf-font-${suffix}-${weight}`,
        folderId,
        uploaderUserId: userId,
        mimeType: 'font/woff2',
        sizeBytes: 1,
        storageKey: `folders/${folderId}/fonts/perf-${weight}.woff2`,
        kind: 'font' as const,
        fontFamily: 'Brand Sans',
        fontWeight: weight,
        fontStyle: 'normal',
        fontAxes: {},
      })),
    )
    await runtime.documents.closeAll()
    hocuspocus.flushPendingStores()
    await waitFor(() => hocuspocus.documents.size === 0, 15_000)
    if (FOLDER_LIVE) await hocuspocus.openDirectConnection(`folder:${folderId}`, { userId })

    const deckBytes = deckState.byteLength
    console.log(
      `deck: ${SLIDES} slides, ${SLIDES * 7} objects, snapshot ${kb(deckBytes)} kB; ` +
        `folder ${FOLDER_LIVE ? 'loaded (live)' : 'stored (not loaded)'}`,
    )

    // --- Commands ----------------------------------------------------------
    counting = true
    const samples: Sample[] = []
    const run = async (label: string, req: Omit<HostRequest, 'actor' | 'surface'>) => {
      const sample = newSample(label)
      current = sample
      const t0 = performance.now()
      const res = await exec(req)
      sample.total = performance.now() - t0
      sample.ok = res.ok
      if (!res.ok) console.error(`  ${label} failed: ${res.error.code} ${res.error.message}`)
      current = null
      samples.push(sample)
      return sample
    }
    for (let i = 0; i < COMMANDS; i++) {
      const invocation = workload(i)
      await run(invocation.command, { target: { deckId }, invocation })
      if (PACE > 0) await new Promise((r) => setTimeout(r, PACE))
    }
    const commandSamples = [...samples]
    const commandStores = { ...totals, storeMs: [...totals.storeMs] }

    // --- Batches -----------------------------------------------------------
    const batchSamples: Sample[] = []
    for (const size of [10, 100]) {
      for (let b = 0; b < BATCHES; b++) {
        batchSamples.push(
          await run(`ops.apply x${size}`, {
            target: { deckId },
            batch: { ops: batchOf(size, b), atomic: true },
          }),
        )
      }
    }

    // Whatever is still on the debounce, then the totals.
    const settledAt = performance.now()
    hocuspocus.flushPendingStores()
    await waitFor(() => totals.stores > 0 && !hasPendingStores(hocuspocus), 15_000)
    counting = false
    const flushMs = performance.now() - settledAt

    // --- Report ------------------------------------------------------------
    const report = buildReport(
      commandSamples.slice(1),
      commandSamples[0]!,
      batchSamples,
      commandStores,
      totals,
    )
    console.log(report.text)
    console.log(`(final flush of pending stores: ${ms(flushMs)} ms)`)
    if (args.json !== undefined) {
      writeFileSync(
        args.json,
        JSON.stringify(
          {
            at: new Date().toISOString(),
            slides: SLIDES,
            commands: COMMANDS,
            batches: BATCHES,
            paceMs: PACE,
            folderLive: FOLDER_LIVE,
            deckBytes,
            ...report.data,
          },
          null,
          2,
        ),
      )
      console.log(`written to ${args.json}`)
    }
  } finally {
    counting = false
    await runtime.shutdown()
    hocuspocus.flushPendingStores()
    await waitFor(() => !hasPendingStores(hocuspocus), 15_000).catch(() => undefined)
    await server.destroy()
    await removeRows()
    await pool.end()
  }
}

function hasPendingStores(hp: AgentRuntimeHocuspocus): boolean {
  const debouncer = (
    hp as unknown as {
      debouncer: { isDebounced(id: string): boolean; isCurrentlyExecuting(id: string): boolean }
    }
  ).debouncer
  for (const doc of hp.documents.values()) {
    const id = `onStoreDocument-${doc.name}`
    if (debouncer.isDebounced(id) || debouncer.isCurrentlyExecuting(id)) return true
  }
  return false
}

type AgentRuntimeHocuspocus = ReturnType<typeof createHocuspocusServer>['hocuspocus']

async function waitFor(cond: () => boolean, timeoutMs: number): Promise<void> {
  const until = Date.now() + timeoutMs
  while (!cond()) {
    if (Date.now() > until) throw new Error('timed out waiting')
    await new Promise((r) => setTimeout(r, 10))
  }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

/**
 * A sample as this probe reports it: `@narrative/perf`'s summary (median,
 * mean, max; quantiles R type 7) plus the p95 and the sum the tables print.
 * An empty sample (no document store during the commands) is all zeros.
 */
interface Summary {
  n: number
  p50: number
  p95: number
  max: number
  mean: number
  total: number
}

function summarize(xs: readonly number[]): Summary {
  if (xs.length === 0) return { n: 0, p50: 0, p95: 0, max: 0, mean: 0, total: 0 }
  const s = summarizeSample(xs)
  return {
    n: s.n,
    p50: s.median,
    p95: quantile(xs, 0.95),
    max: s.max,
    mean: s.mean,
    total: xs.reduce((sum, x) => sum + x, 0),
  }
}

/** A number for a table cell: milliseconds with two decimals below 10, one above. */
function ms(x: number): string {
  return x < 10 ? x.toFixed(2) : x.toFixed(1)
}

/** Bytes in kB with one decimal. */
function kb(bytes: number): string {
  return (bytes / 1024).toFixed(1)
}

/** A plain-text table: the label column left-aligned, the numbers right-aligned. */
function table(header: readonly string[], rows: ReadonlyArray<readonly string[]>): string {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)))
  const line = (cells: readonly string[]): string =>
    cells.map((c, i) => (i === 0 ? c.padEnd(widths[i]!) : c.padStart(widths[i]!))).join('  ')
  return [line(header), widths.map((w) => '-'.repeat(w)).join('  '), ...rows.map(line)].join('\n')
}

function phaseRow(label: string, xs: readonly Sample[]): string[] {
  const s = (f: (x: Sample) => number): Summary => summarize(xs.map(f))
  const total = s((x) => x.total)
  const cell = (sum: Summary): string => `${ms(sum.p50)} / ${ms(sum.p95)}`
  return [
    label,
    String(xs.length),
    cell(total),
    ...PHASES.map((p) => cell(s((x) => x.phases[p]))),
    s((x) => x.statements).mean.toFixed(1),
    s((x) => x.writes).mean.toFixed(1),
  ]
}

function buildReport(
  commands: readonly Sample[],
  first: Sample,
  batches: readonly Sample[],
  commandStores: Totals,
  all: Totals,
): { text: string; data: Record<string, unknown> } {
  const header = ['command', 'n', 'total p50/p95', ...PHASES, 'stmts', 'writes']
  const byCommand = new Map<string, Sample[]>()
  for (const x of commands) byCommand.set(x.command, [...(byCommand.get(x.command) ?? []), x])
  const rows = [
    phaseRow('all (first excluded)', commands),
    ...[...byCommand.entries()].sort().map(([c, xs]) => phaseRow(c, xs)),
    phaseRow(`first: ${first.command}`, [first]),
  ]
  const batchRows = [10, 100].map((n) =>
    phaseRow(
      `ops.apply x${n}`,
      batches.filter((b) => b.command === `ops.apply x${n}`),
    ),
  )
  const n = commands.length + 1
  const storeSummary = summarize(commandStores.storeMs)
  const storesText = [
    `commands: ${n}, failed: ${[first, ...commands].filter((x) => !x.ok).length}`,
    `document stores during the commands: ${commandStores.stores} ` +
      `(${commandStores.storesOffPath} off a command's path), ` +
      `${kb(commandStores.storedBytes)} kB written = ${kb(commandStores.storedBytes / n)} kB per command; ` +
      `one store p50 ${ms(storeSummary.p50)} ms, p95 ${ms(storeSummary.p95)} ms`,
    `document stores, whole run incl. batches and the final flush: ${all.stores}, ${kb(all.storedBytes)} kB`,
  ].join('\n')
  const text = [
    '',
    'p50 / p95 in ms; stmts/writes: database statements / writes this process sent per command (mean)',
    table(header, rows),
    '',
    table(header, batchRows),
    '',
    storesText,
  ].join('\n')
  const json = (xs: readonly Sample[]) => ({
    n: xs.length,
    total: summarize(xs.map((x) => x.total)),
    phases: Object.fromEntries(PHASES.map((p) => [p, summarize(xs.map((x) => x.phases[p]))])),
    statements: summarize(xs.map((x) => x.statements)),
    writes: summarize(xs.map((x) => x.writes)),
  })
  return {
    text,
    data: {
      commands: json(commands),
      byCommand: Object.fromEntries([...byCommand.entries()].map(([c, xs]) => [c, json(xs)])),
      first: json([first]),
      batches: Object.fromEntries(
        [10, 100].map((b) => [b, json(batches.filter((x) => x.command === `ops.apply x${b}`))]),
      ),
      stores: {
        duringCommands: commandStores.stores,
        offPath: commandStores.storesOffPath,
        bytesDuringCommands: commandStores.storedBytes,
        storeMs: storeSummary,
        wholeRun: all.stores,
        bytesWholeRun: all.storedBytes,
      },
    },
  }
}

await main()
