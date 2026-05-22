#!/usr/bin/env node
/**
 * tests/pptx-import/generate-report.mjs
 *
 * Build a side-by-side HTML report comparing LibreOffice-rendered
 * reference slides against the screenshots Playwright captured from
 * the Narrative editor after importing the same .pptx fixture.
 *
 * Usage:
 *   node tests/pptx-import/generate-report.mjs <deckname>
 *
 *   <deckname> defaults to the only deck under tests/fixtures/pptx/reference/
 *   if there's exactly one.
 *
 * Inputs:
 *   tests/fixtures/pptx/reference/<deckname>/SlideN.png   (LibreOffice)
 *   tests/pptx-import/imported/<deckname>/SlideN.png      (Narrative)
 *
 * Output:
 *   tests/pptx-import/report-<deckname>.html
 */

import { readdir, writeFile, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..', '..')

const REFERENCE_BASE = join(REPO_ROOT, 'tests', 'fixtures', 'pptx', 'reference')
const IMPORTED_BASE = join(REPO_ROOT, 'tests', 'pptx-import', 'imported')

async function resolveDeckName(arg) {
  if (arg) return arg
  const entries = await readdir(REFERENCE_BASE, { withFileTypes: true }).catch(() => [])
  const folders = entries.filter((e) => e.isDirectory()).map((e) => e.name)
  if (folders.length === 1) return folders[0]
  if (folders.length === 0) {
    throw new Error(`no decks found under ${REFERENCE_BASE}`)
  }
  throw new Error(
    `multiple decks under ${REFERENCE_BASE} — pass the deck name as an argument:\n  ${folders.join('\n  ')}`,
  )
}

function slideIndex(name) {
  const m = /Slide(\d+)\.png$/i.exec(name)
  return m ? parseInt(m[1], 10) : Number.POSITIVE_INFINITY
}

async function listSlides(dir) {
  const entries = await readdir(dir).catch(() => [])
  return entries
    .filter((n) => /^Slide\d+\.png$/i.test(n))
    .sort((a, b) => slideIndex(a) - slideIndex(b))
}

async function exists(p) {
  return stat(p)
    .then(() => true)
    .catch(() => false)
}

async function main() {
  const deckName = await resolveDeckName(process.argv[2])

  const refDir = join(REFERENCE_BASE, deckName)
  const impDir = join(IMPORTED_BASE, deckName)

  const refSlides = await listSlides(refDir)
  const impAvailable = await exists(impDir)
  const impSlides = impAvailable ? await listSlides(impDir) : []

  const all = new Set([...refSlides, ...impSlides])
  const slides = Array.from(all).sort((a, b) => slideIndex(a) - slideIndex(b))

  const reportPath = join(REPO_ROOT, 'tests', 'pptx-import', `report-${deckName}.html`)
  const reportDir = dirname(reportPath)

  // All <img> srcs are relative paths from the report file's location so
  // the user can open the HTML directly in their browser.
  const refRel = (name) => relative(reportDir, join(refDir, name))
  const impRel = (name) => relative(reportDir, join(impDir, name))

  const rows = await Promise.all(
    slides.map(async (name) => {
      const refOk = await exists(join(refDir, name))
      const impOk = await exists(join(impDir, name))
      return { name, refOk, impOk }
    }),
  )

  const html = renderHtml({
    deckName,
    importedAvailable: impAvailable,
    rows,
    refRel,
    impRel,
  })

  await writeFile(reportPath, html, 'utf8')
  console.log(`wrote ${reportPath}`)
  console.log(`open with: xdg-open ${reportPath}`)
}

function renderHtml({ deckName, importedAvailable, rows, refRel, impRel }) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>PPTX import fidelity — ${escape(deckName)}</title>
  <style>
    :root {
      --bg: #0b0d10;
      --panel: #14181d;
      --border: #232a32;
      --text: #e6ebf0;
      --muted: #8a949e;
      --accent: #5b9dff;
      --bad: #ff5b6e;
    }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; background: var(--bg); color: var(--text); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, system-ui, sans-serif; }
    header { padding: 20px 28px; border-bottom: 1px solid var(--border); position: sticky; top: 0; background: rgba(11, 13, 16, 0.92); backdrop-filter: blur(8px); z-index: 10; }
    h1 { margin: 0 0 4px 0; font-size: 18px; font-weight: 600; }
    .sub { color: var(--muted); font-size: 13px; }
    main { padding: 20px 28px 60px; max-width: 2400px; }
    .row { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 28px; }
    .pane { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
    .pane-head { padding: 10px 14px; border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; }
    .pane-head .label { font-size: 13px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: 0.06em; }
    .pane-head .slide { font-size: 13px; color: var(--text); }
    .pane img { display: block; width: 100%; height: auto; cursor: zoom-in; }
    .missing { padding: 40px; text-align: center; color: var(--bad); font-size: 14px; }
    .empty { padding: 40px 0; text-align: center; color: var(--muted); }
    .legend { display: inline-flex; gap: 14px; align-items: center; font-size: 12px; color: var(--muted); }
    .swatch { width: 10px; height: 10px; border-radius: 2px; display: inline-block; vertical-align: middle; margin-right: 4px; }

    /* Lightbox */
    .lightbox { position: fixed; inset: 0; background: rgba(0,0,0,0.92); display: none; align-items: center; justify-content: center; z-index: 100; cursor: zoom-out; }
    .lightbox.open { display: flex; }
    .lightbox img { max-width: 96vw; max-height: 96vh; object-fit: contain; }
  </style>
</head>
<body>
  <header>
    <h1>PPTX import fidelity — ${escape(deckName)}</h1>
    <div class="sub">
      <span class="legend">
        <span><span class="swatch" style="background: #c2c8d1"></span>Reference (LibreOffice render of original .pptx)</span>
        <span><span class="swatch" style="background: var(--accent)"></span>Imported (Narrative editor in present mode)</span>
        <span>${rows.length} slides</span>
        ${importedAvailable ? '' : '<span style="color: var(--bad)">⚠️ no imported screenshots yet — run pnpm --filter web test:e2e pptx-import-fidelity</span>'}
      </span>
    </div>
  </header>
  <main>
    ${rows.length === 0 ? '<div class="empty">no slides found</div>' : ''}
    ${rows.map((r) => renderRow(r, refRel, impRel)).join('\n')}
  </main>
  <div class="lightbox" id="lightbox" onclick="this.classList.remove('open')"><img id="lightbox-img" alt="" /></div>
  <script>
    document.querySelectorAll('img[data-zoom]').forEach((img) => {
      img.addEventListener('click', () => {
        document.getElementById('lightbox-img').src = img.src
        document.getElementById('lightbox').classList.add('open')
      })
    })
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') document.getElementById('lightbox').classList.remove('open')
    })
  </script>
</body>
</html>
`
}

function renderRow({ name, refOk, impOk }, refRel, impRel) {
  const label = name.replace(/\.png$/, '')
  return `<section class="row">
      <div class="pane">
        <div class="pane-head"><span class="label">Reference</span><span class="slide">${escape(label)}</span></div>
        ${refOk ? `<img data-zoom src="${escape(refRel(name))}" alt="reference ${escape(label)}" />` : '<div class="missing">reference image missing</div>'}
      </div>
      <div class="pane">
        <div class="pane-head"><span class="label">Imported</span><span class="slide">${escape(label)}</span></div>
        ${impOk ? `<img data-zoom src="${escape(impRel(name))}" alt="imported ${escape(label)}" />` : '<div class="missing">no imported screenshot</div>'}
      </div>
    </section>`
}

function escape(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
