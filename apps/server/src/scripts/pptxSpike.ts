/**
 * scripts/pptxSpike.ts
 *
 * M28 Phase 1 spike. Exploratory only — not production code, not exposed by
 * any route. Goal: prove the export library (pptxgenjs) and the parse stack
 * (jszip + fast-xml-parser) can carry the MVP feature set from the M28 plan,
 * then quantify the long tail when fed real-world `.pptx` files.
 *
 * What it does
 * ------------
 * 1. EXPORT: builds a synthetic deck with pptxgenjs covering every MVP shape
 *    (text, image-from-Buffer, rect, ellipse, line, solid + image backgrounds,
 *    rotation). Writes `<tmp>/spike-export.pptx`. Measures wall-clock and RAM.
 *
 * 2. IMPORT: walks any `.pptx` files in `<repo>/tests/fixtures/pptx/`
 *    (created on demand — drop Microsoft / Canva / Keynote exports there) plus
 *    the file we just produced. For each file:
 *      - Lists ZIP entries
 *      - Parses `ppt/presentation.xml` for slide-id order
 *      - Parses each `ppt/slides/slideN.xml`, extracts the shape graph
 *      - Maps observed XML elements against the M28 mapping table:
 *        covered / not-covered / unexpected
 *      - Logs schema-element coverage so the long tail is visible
 *    Measures parse wall-clock + RAM per file.
 *
 * 3. REPORT: prints a markdown-shaped summary at the end. Copy/paste into
 *    docs/plans/m28-pptx-import-export.md under "Spike findings".
 *
 * Run with: `pnpm --filter @narrative/server pptx:spike`
 */

import { mkdirSync, readdirSync, statSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import { getHeapStatistics } from 'node:v8'

import PptxGenJSImport from 'pptxgenjs'
import JSZip from 'jszip'
import { XMLParser } from 'fast-xml-parser'

// pptxgenjs 4.x has two interop quirks:
//   1. .d.ts merges class + namespace at its default export, so NodeNext +
//      verbatimModuleSyntax sees the default as a namespace, not a constructor.
//   2. tsx loads the CJS bundle (`module.exports = PptxGenJS`) and wraps it in
//      `{ default: <class> }`, so the default *value* under tsx is the wrapper.
// Both quirks are runtime-or-types only — at runtime under tsx, the class is
// reachable via `.default` on the wrapper. Defensive resolver handles both
// native Node (default is class) and tsx (default is `{ default: class }`).
interface PptxSlide {
  background: { color?: string; data?: string }
  addText: (text: string, opts: Record<string, unknown>) => void
  addImage: (opts: Record<string, unknown>) => void
  addShape: (kind: string, opts: Record<string, unknown>) => void
}
interface PptxApp {
  layout: string
  author: string
  title: string
  addSlide: () => PptxSlide
  writeFile: (opts: { fileName: string }) => Promise<string>
}
type PptxCtor = new () => PptxApp
function resolvePptxCtor(mod: unknown): PptxCtor {
  // tsx-CJS shape: the import is { default: <class>, 'module.exports': <class> }
  if (mod !== null && typeof mod === 'object' && 'default' in mod) {
    const inner = (mod as { default: unknown }).default
    if (typeof inner === 'function') return inner as unknown as PptxCtor
  }
  // native ESM shape: the default IS the class
  return mod as unknown as PptxCtor
}
const PptxGenJS = resolvePptxCtor(PptxGenJSImport)

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..')
const FIXTURES_DIR = join(REPO_ROOT, 'tests', 'fixtures', 'pptx')
const OUT_DIR = join(tmpdir(), 'narrative-pptx-spike')
mkdirSync(OUT_DIR, { recursive: true })

/** 100x60 solid-red PNG, hand-crafted so the spike has no I/O dependencies. */
const RED_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAGQAAAA8CAYAAACVcF/9AAAAJUlEQVR42u3OAQ0AAAjDsH/QkfgI' +
  'g1S2dW0lqpQpU6ZMmTL1aQUe9wAB6aJBpwAAAABJRU5ErkJggg=='

// ---------------------------------------------------------------------------
// Mapping table — keep in sync with docs/plans/m28-pptx-import-export.md
// ---------------------------------------------------------------------------

/**
 * XML elements (and child kinds) that map to a Narrative model in MVP scope.
 * Anything observed but not in this set is part of the "long tail" the spike
 * is supposed to quantify.
 */
const MVP_ELEMENTS = new Set<string>([
  // top-level slide structure
  'p:sld',
  'p:cSld',
  'p:spTree',
  'p:nvGrpSpPr', // group shape props (the spTree root)
  'p:grpSpPr',
  'p:nvSpPr', // shape non-visual props
  'p:nvPicPr',
  'p:nvCxnSpPr', // line connector
  // shape body
  'p:sp', // generic shape (rect/ellipse/text frame)
  'p:pic', // picture
  'p:cxnSp', // connector / line
  'p:spPr',
  'a:xfrm',
  'a:off',
  'a:ext',
  'a:prstGeom', // preset geometry (rect, ellipse, line, …)
  'a:avLst',
  // fill / stroke
  'a:solidFill',
  'a:srgbClr',
  'a:blipFill',
  'a:blip',
  'a:stretch',
  'a:fillRect',
  'a:ln', // outline
  'a:noFill',
  // text
  'p:txBody',
  'a:bodyPr',
  'a:lstStyle',
  'a:p',
  'a:pPr',
  'a:r',
  'a:rPr',
  'a:t',
  'a:endParaRPr',
  // image bookkeeping (we know about these even if we don't use all)
  'p:cNvPr',
  'p:cNvSpPr',
  'p:cNvPicPr',
  'p:cNvCxnSpPr',
  'a:picLocks',
  'a:spLocks',
  'a:cxnSpLocks',
  // slide background (solid / image)
  'p:bg',
  'p:bgPr',
  'p:bgRef',
])

/** Elements known to be deferred (post-MVP) per the plan. */
const DEFERRED_ELEMENTS = new Set<string>([
  // theme / layout / master
  'p:sldLayoutId',
  'p:sldMasterId',
  'p:sldLayoutIdLst',
  'p:sldMasterIdLst',
  // animation / transition
  'p:timing',
  'p:transition',
  // tables
  'a:tbl',
  'a:tblPr',
  'a:tblGrid',
  'a:tr',
  'a:tc',
  // charts / SmartArt
  'c:chart',
  'dgm:relIds',
  // gradients
  'a:gradFill',
  'a:gsLst',
  'a:gs',
  // video / audio
  'p:videoFile',
  'a:videoFile',
  'p:audioFile',
  'a:audioFile',
])

// ---------------------------------------------------------------------------
// Memory + timing helpers
// ---------------------------------------------------------------------------

interface Sample {
  label: string
  ms: number
  rssDeltaMB: number
  heapDeltaMB: number
  peakRssMB: number
}

async function measure<T>(
  label: string,
  fn: () => Promise<T>,
): Promise<{ value: T; sample: Sample }> {
  if (typeof global.gc === 'function') global.gc()
  const before = process.memoryUsage()
  let peakRss = before.rss
  const t0 = performance.now()
  const poll = setInterval(() => {
    const m = process.memoryUsage()
    if (m.rss > peakRss) peakRss = m.rss
  }, 25)
  try {
    const value = await fn()
    const ms = performance.now() - t0
    const after = process.memoryUsage()
    return {
      value,
      sample: {
        label,
        ms,
        rssDeltaMB: (after.rss - before.rss) / 1e6,
        heapDeltaMB: (after.heapUsed - before.heapUsed) / 1e6,
        peakRssMB: peakRss / 1e6,
      },
    }
  } finally {
    clearInterval(poll)
  }
}

// ---------------------------------------------------------------------------
// 1. Export — build a synthetic MVP-coverage deck and write it to disk
// ---------------------------------------------------------------------------

async function buildExport(outFile: string): Promise<{ bytes: number }> {
  const pptx = new PptxGenJS()
  pptx.layout = 'LAYOUT_WIDE'
  pptx.author = 'Narrative spike'
  pptx.title = 'M28 spike — MVP coverage'

  // ── Slide 1: solid background + text + image + rectangle ───────────────
  const s1 = pptx.addSlide()
  s1.background = { color: 'F4F4F5' }
  s1.addText('Spike — Slide 1', {
    x: 0.5,
    y: 0.5,
    w: 9,
    h: 1,
    fontSize: 32,
    bold: true,
    color: '0F172A',
  })
  s1.addText('Body copy line with a single style applied to the whole frame.', {
    x: 0.5,
    y: 1.7,
    w: 9,
    h: 0.6,
    fontSize: 16,
    color: '334155',
  })
  s1.addImage({ data: `data:image/png;base64,${RED_PNG_BASE64}`, x: 0.5, y: 2.8, w: 3, h: 1.8 })
  s1.addShape('rect', {
    x: 5,
    y: 2.8,
    w: 4,
    h: 1.8,
    fill: { color: '3B82F6' },
    line: { color: '1E3A8A', width: 2 },
  })

  // ── Slide 2: rotation + ellipse + line ──────────────────────────────────
  const s2 = pptx.addSlide()
  s2.background = { color: 'FEF3C7' }
  s2.addShape('ellipse', {
    x: 1,
    y: 1,
    w: 3,
    h: 3,
    fill: { color: 'F59E0B' },
    line: { color: '92400E', width: 2 },
  })
  s2.addShape('rect', {
    x: 5,
    y: 1,
    w: 3,
    h: 3,
    fill: { color: '10B981' },
    line: { color: '064E3B', width: 2 },
    rotate: 30,
  })
  s2.addShape('line', {
    x: 1,
    y: 4.5,
    w: 7,
    h: 0,
    line: { color: '7C3AED', width: 4 },
  })

  // ── Slide 3: image background ───────────────────────────────────────────
  const s3 = pptx.addSlide()
  s3.background = { data: `data:image/png;base64,${RED_PNG_BASE64}` }
  s3.addText('Image-background slide', {
    x: 0.5,
    y: 0.5,
    w: 9,
    h: 1,
    fontSize: 28,
    bold: true,
    color: 'FFFFFF',
  })

  await pptx.writeFile({ fileName: outFile })
  const bytes = statSync(outFile).size
  return { bytes }
}

// ---------------------------------------------------------------------------
// 2. Import — walk the zip, parse the XML, score against the mapping table
// ---------------------------------------------------------------------------

interface SlideObservation {
  slideName: string
  shapeCount: number
  textShapeCount: number
  pictureCount: number
  connectorCount: number
  prstGeomTypes: Record<string, number>
  fillKinds: Record<string, number>
  textRunCount: number
  hasRotation: boolean
  hasImageBg: boolean
  hasSolidBg: boolean
}

interface FileReport {
  file: string
  bytes: number
  zipEntries: string[]
  slideCount: number
  elementHistogram: Record<string, number>
  unknownElements: string[]
  deferredElementsSeen: string[]
  slides: SlideObservation[]
}

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  preserveOrder: true,
  ignoreDeclaration: true,
  trimValues: false,
})

/**
 * Walks a fast-xml-parser preserveOrder tree, calling `visit` for every
 * tagged node (the only key with a colon in the tag name). The tree shape is
 * an array of objects each shaped like `{ "p:sld": [...children...], ":@": {...attrs...} }`.
 */
function walkXml(
  node: unknown,
  visit: (tag: string, attrs: Record<string, unknown>, children: unknown) => void,
): void {
  if (Array.isArray(node)) {
    for (const child of node) walkXml(child, visit)
    return
  }
  if (node === null || typeof node !== 'object') return
  for (const [key, value] of Object.entries(node)) {
    if (key === ':@' || key === '#text') continue
    const attrsRaw = (node as Record<string, unknown>)[':@']
    const attrs = (typeof attrsRaw === 'object' && attrsRaw !== null ? attrsRaw : {}) as Record<
      string,
      unknown
    >
    visit(key, attrs, value)
    walkXml(value, visit)
  }
}

async function parseFile(filePath: string): Promise<FileReport> {
  const bytes = statSync(filePath).size
  const buf = readFileSync(filePath)
  const zip = await JSZip.loadAsync(buf)
  const zipEntries = Object.keys(zip.files).sort()

  const slidePaths = zipEntries.filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort()
  const elementHistogram: Record<string, number> = {}
  const unknownElements = new Set<string>()
  const deferredElementsSeen = new Set<string>()
  const slides: SlideObservation[] = []

  for (const slidePath of slidePaths) {
    const entry = zip.file(slidePath)
    if (entry === null) continue
    const xml = await entry.async('string')
    const tree = xmlParser.parse(xml)

    const obs: SlideObservation = {
      slideName: basename(slidePath),
      shapeCount: 0,
      textShapeCount: 0,
      pictureCount: 0,
      connectorCount: 0,
      prstGeomTypes: {},
      fillKinds: {},
      textRunCount: 0,
      hasRotation: false,
      hasImageBg: false,
      hasSolidBg: false,
    }

    walkXml(tree, (tag, attrs, _children) => {
      elementHistogram[tag] = (elementHistogram[tag] ?? 0) + 1
      if (!MVP_ELEMENTS.has(tag)) {
        if (DEFERRED_ELEMENTS.has(tag)) deferredElementsSeen.add(tag)
        else unknownElements.add(tag)
      }
      switch (tag) {
        case 'p:sp':
          obs.shapeCount++
          break
        case 'p:pic':
          obs.shapeCount++
          obs.pictureCount++
          break
        case 'p:cxnSp':
          obs.shapeCount++
          obs.connectorCount++
          break
        case 'a:prstGeom': {
          const prst = String(attrs['@prst'] ?? 'unknown')
          obs.prstGeomTypes[prst] = (obs.prstGeomTypes[prst] ?? 0) + 1
          break
        }
        case 'a:solidFill':
          obs.fillKinds['solid'] = (obs.fillKinds['solid'] ?? 0) + 1
          break
        case 'a:gradFill':
          obs.fillKinds['gradient'] = (obs.fillKinds['gradient'] ?? 0) + 1
          break
        case 'a:blipFill':
          obs.fillKinds['blip'] = (obs.fillKinds['blip'] ?? 0) + 1
          break
        case 'a:noFill':
          obs.fillKinds['none'] = (obs.fillKinds['none'] ?? 0) + 1
          break
        case 'a:r':
          obs.textRunCount++
          break
        case 'p:txBody':
          obs.textShapeCount++
          break
        case 'a:xfrm':
          if (attrs['@rot'] !== undefined) obs.hasRotation = true
          break
        case 'p:bgPr':
          // peek at first child to tell solid vs blip
          break
      }
    })

    // detect bg fill kind from raw xml — cheap textual check
    if (/<p:bg[\s>]/.test(xml)) {
      if (/<p:bg[\s\S]*?<a:blipFill/.test(xml)) obs.hasImageBg = true
      if (/<p:bg[\s\S]*?<a:solidFill/.test(xml)) obs.hasSolidBg = true
    }

    slides.push(obs)
  }

  return {
    file: filePath,
    bytes,
    zipEntries,
    slideCount: slidePaths.length,
    elementHistogram,
    unknownElements: Array.from(unknownElements).sort(),
    deferredElementsSeen: Array.from(deferredElementsSeen).sort(),
    slides,
  }
}

// ---------------------------------------------------------------------------
// 3. Report
// ---------------------------------------------------------------------------

function fmtSample(s: Sample): string {
  return (
    `${s.label.padEnd(40)} ${s.ms.toFixed(0).padStart(6)} ms   ` +
    `peakRSS ${s.peakRssMB.toFixed(1).padStart(7)} MB   ` +
    `Δheap ${s.heapDeltaMB.toFixed(1).padStart(6)} MB`
  )
}

function reportFile(r: FileReport): string {
  const lines: string[] = []
  lines.push(`### \`${r.file.replace(REPO_ROOT, '<repo>').replace(OUT_DIR, '<tmp>')}\``)
  lines.push('')
  lines.push(`- size: **${(r.bytes / 1024).toFixed(1)} KB**`)
  lines.push(`- slides: **${r.slideCount}**`)
  lines.push(`- zip entries: ${r.zipEntries.length}`)
  lines.push(`- distinct XML tags across slides: ${Object.keys(r.elementHistogram).length}`)
  lines.push(
    `- deferred-but-seen: ${r.deferredElementsSeen.length === 0 ? '_none_' : r.deferredElementsSeen.join(', ')}`,
  )
  lines.push(
    `- unknown / unmapped: ${r.unknownElements.length === 0 ? '_none_' : r.unknownElements.join(', ')}`,
  )
  lines.push('')
  lines.push('| slide | shapes | text | pic | line | rotation | prstGeom kinds | fills |')
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |')
  for (const s of r.slides) {
    lines.push(
      `| ${s.slideName} | ${s.shapeCount} | ${s.textShapeCount} | ${s.pictureCount} | ${s.connectorCount} | ` +
        `${s.hasRotation ? 'yes' : '—'} | ${
          Object.entries(s.prstGeomTypes)
            .map(([k, v]) => `${k}×${v}`)
            .join(', ') || '—'
        } | ` +
        `${
          Object.entries(s.fillKinds)
            .map(([k, v]) => `${k}×${v}`)
            .join(', ') || '—'
        } |`,
    )
  }
  lines.push('')
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const samples: Sample[] = []

  const exportPath = join(OUT_DIR, 'spike-export.pptx')
  const exportResult = await measure('export: build + write spike-export.pptx', async () =>
    buildExport(exportPath),
  )
  samples.push(exportResult.sample)
  console.log(`\nWrote ${exportPath} (${(exportResult.value.bytes / 1024).toFixed(1)} KB)\n`)

  // Files to import: our own export + anything in tests/fixtures/pptx/
  const fixtureFiles: string[] = []
  try {
    for (const name of readdirSync(FIXTURES_DIR)) {
      const full = join(FIXTURES_DIR, name)
      if (statSync(full).isFile() && name.toLowerCase().endsWith('.pptx')) fixtureFiles.push(full)
    }
  } catch {
    // dir doesn't exist; that's fine — drop fixtures there to see them parsed
  }
  const toParse = [exportPath, ...fixtureFiles]
  const reports: FileReport[] = []
  for (const f of toParse) {
    const { value, sample } = await measure(`parse: ${basename(f)}`, async () => parseFile(f))
    samples.push(sample)
    reports.push(value)
  }

  // ─── Report ────────────────────────────────────────────────────────────
  const out: string[] = []
  out.push('# M28 spike — findings')
  out.push('')
  out.push(`_Generated: ${new Date().toISOString()}_`)
  out.push('')
  out.push('## Timings + memory')
  out.push('')
  out.push('```')
  for (const s of samples) out.push(fmtSample(s))
  out.push('```')
  out.push('')
  out.push(
    `Node: ${process.version} • V8 heap limit: ${(getHeapStatistics().heap_size_limit / 1e6).toFixed(0)} MB`,
  )
  out.push('')
  out.push('## Files parsed')
  out.push('')
  for (const r of reports) out.push(reportFile(r))

  // Coverage summary
  const allElements = new Set<string>()
  const allDeferred = new Set<string>()
  const allUnknown = new Set<string>()
  for (const r of reports) {
    for (const k of Object.keys(r.elementHistogram)) allElements.add(k)
    for (const k of r.deferredElementsSeen) allDeferred.add(k)
    for (const k of r.unknownElements) allUnknown.add(k)
  }
  out.push('## Mapping table coverage')
  out.push('')
  out.push(`- distinct XML elements observed: **${allElements.size}**`)
  out.push(
    `- in MVP set + observed: **${[...allElements].filter((e) => MVP_ELEMENTS.has(e)).length}** / ${MVP_ELEMENTS.size}`,
  )
  out.push(
    `- deferred (post-MVP) but observed: **${allDeferred.size}** — ${allDeferred.size === 0 ? '_none_' : [...allDeferred].sort().join(', ')}`,
  )
  out.push(
    `- **unknown** (not in either list): **${allUnknown.size}** — ${allUnknown.size === 0 ? '_none_' : [...allUnknown].sort().join(', ')}`,
  )
  out.push('')
  if (fixtureFiles.length === 0) {
    out.push(
      '> ⚠️  No real-world fixtures present. Drop Microsoft / Canva / Keynote-exported `.pptx` files into',
    )
    out.push(
      "> `tests/fixtures/pptx/` and re-run to quantify the long tail beyond pptxgenjs's own output.",
    )
    out.push('')
  }

  out.push('## Manual verification checklist')
  out.push('')
  out.push(
    `- [ ] Open \`${exportPath}\` in **PowerPoint Online** — slides render without warnings.`,
  )
  out.push(`- [ ] Open the same file in **Keynote** — slides render, text positioning preserved.`)
  out.push(`- [ ] Open in **Google Slides** — fidelity check.`)
  out.push('')

  const report = out.join('\n')
  console.log('\n' + '═'.repeat(72) + '\n')
  console.log(report)

  const reportPath = join(OUT_DIR, 'spike-findings.md')
  writeFileSync(reportPath, report, 'utf8')
  console.log(`\nReport written to ${reportPath}`)
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
