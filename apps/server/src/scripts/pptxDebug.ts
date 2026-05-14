/**
 * scripts/pptxDebug.ts
 *
 * Runs the .pptx import pipeline (parser → writer) on a single file and
 * dumps the resulting Y.Doc state as plain JSON so we can see exactly what
 * shape/colour/stroke/text data lands in Narrative.
 *
 * Usage: `node ../../node_modules/tsx/dist/cli.mjs src/scripts/pptxDebug.ts <path-to-pptx>`
 */

import { readFileSync } from 'node:fs'
import * as Y from 'yjs'
import { parsePptx } from '../pptx/parser.js'
import { buildDeckUpdate } from '../pptx/writer.js'

const path = process.argv[2]
if (path === undefined) {
  console.error('Usage: pptxDebug.ts <path-to-pptx>')
  process.exit(1)
}

const buf = readFileSync(path)
const parsed = await parsePptx(buf)
console.log(`Parsed: ${parsed.slides.length} slides, ${parsed.slideWidth}x${parsed.slideHeight}px`)
console.log(`Ignored elements: ${parsed.ignoredElements.join(', ') || '_none_'}`)
console.log()

// ── Dump the raw parser output (what the writer consumes) ────────────────
console.log('── RAW PARSER OUTPUT ──')
for (const s of parsed.slides) {
  console.log(`Slide ${s.source}, background ${JSON.stringify(s.background)}`)
  for (const shape of s.shapes) {
    const summary = {
      kind: shape.kind,
      x: round(shape.x),
      y: round(shape.y),
      w: round(shape.width),
      h: round(shape.height),
      rot: round(shape.rotation),
      fillColor:
        shape.fillColor !== undefined
          ? '#' + shape.fillColor.toString(16).padStart(6, '0')
          : undefined,
      gradient: shape.fillGradient !== undefined ? shape.fillGradient.kind : undefined,
      stroke:
        shape.strokeColor !== undefined
          ? '#' + shape.strokeColor.toString(16).padStart(6, '0')
          : undefined,
      strokeWidth: shape.strokeWidth,
      text: shape.text,
      textColor:
        shape.textColor !== undefined
          ? '#' + shape.textColor.toString(16).padStart(6, '0')
          : undefined,
      fontSize: shape.fontSize,
      sourceTag: shape.sourceTag,
      prstGeom: shape.prstGeom,
    }
    console.log('  ' + JSON.stringify(summary))
  }
}
console.log()

// ── Build the Y.Doc and dump what's inside ──────────────────────────────
const result = buildDeckUpdate(parsed)
console.log(
  `Writer: ${result.slideCount} slides, ${result.objectsCreated} objects, skipped images=${result.skipped.images} unknown=${result.skipped.unknownShapes}`,
)
console.log()

const doc = new Y.Doc()
Y.applyUpdate(doc, new Uint8Array(result.state))
const slides = doc.getArray<Y.Map<unknown>>('slides')
console.log('── Y.DOC SLIDES ──')
for (let i = 0; i < slides.length; i++) {
  const slide = slides.get(i)
  const objects = slide.get('objects') as Y.Array<Y.Map<unknown>> | undefined
  const background = slide.get('background') as Y.Map<unknown> | undefined
  console.log(
    `Slide ${i + 1}: ${objects?.length ?? 0} objects, background=${bgSummary(background)}`,
  )
  for (let j = 0; j < (objects?.length ?? 0); j++) {
    const obj = objects!.get(j).toJSON()
    console.log('  ' + JSON.stringify(obj))
  }
}

function round(n: number): number {
  return Math.round(n * 100) / 100
}

function bgSummary(bg: Y.Map<unknown> | undefined): string {
  if (bg === undefined) return 'none'
  return JSON.stringify(bg.toJSON())
}
