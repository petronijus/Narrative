/**
 * pptx/ooxml/validate.test.ts
 *
 * Every part of an exported .pptx against the ECMA-376 schemas.
 *
 * PowerPoint is strict where the schema is: an element out of order or an
 * attribute out of range makes it "repair" the file (dropping what it cannot
 * place) or refuse it. The round-trip tests prove the importer reads the
 * export back; this proves the export is a valid package for everyone else.
 *
 * Parts are validated the way a reader that knows only the base schema sees
 * them — Markup Compatibility (ECMA-376 Part 3) processed first: each
 * `mc:AlternateContent` is replaced by its `mc:Fallback`. The `mc:Choice`
 * branches carry PowerPoint 2010+ extensions (`p14`, `p159`), whose schemas
 * are Microsoft's and not part of the standard.
 *
 * Needs `xmllint` (libxml2): macOS ships it, on Linux it is libxml2-utils.
 */

import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import JSZip from 'jszip'
import { XMLBuilder } from 'fast-xml-parser'
import { describe, expect, it } from 'vitest'
import { ooxmlParser, type XmlNode } from './read.js'
import { writeDeck } from './writeDeck.js'
import { matrixDeck } from '../roundtripMatrix.js'

const SCHEMAS = fileURLToPath(new URL('./__schemas__/', import.meta.url))
const TRANSITIONAL = join(SCHEMAS, 'ecma-376-4-transitional')
const OPC = join(SCHEMAS, 'ecma-376-2-opc')

/** The schema a package part is an instance of, by its path. */
function schemaFor(path: string): string {
  if (path === '[Content_Types].xml') return join(OPC, 'opc-contentTypes.xsd')
  if (path.endsWith('.rels')) return join(OPC, 'opc-relationships.xsd')
  if (path === 'docProps/core.xml') return join(OPC, 'opc-coreProperties.xsd')
  if (path === 'docProps/app.xml')
    return join(TRANSITIONAL, 'shared-documentPropertiesExtended.xsd')
  if (path.startsWith('ppt/theme/')) return join(TRANSITIONAL, 'dml-main.xsd')
  return join(TRANSITIONAL, 'pml.xsd')
}

/** Markup Compatibility for a base-schema reader: every AlternateContent becomes its Fallback. */
function takeFallbacks(nodes: XmlNode[]): XmlNode[] {
  const out: XmlNode[] = []
  for (const node of nodes) {
    const tag = Object.keys(node).find((k) => k !== ':@')
    if (tag === 'mc:AlternateContent') {
      const branches = node[tag] as XmlNode[]
      const fallback = branches.find((b) => 'mc:Fallback' in b)
      if (fallback !== undefined) out.push(...takeFallbacks(fallback['mc:Fallback'] as XmlNode[]))
      continue
    }
    if (tag !== undefined && Array.isArray(node[tag])) {
      out.push({ ...node, [tag]: takeFallbacks(node[tag] as XmlNode[]) })
    } else {
      out.push(node)
    }
  }
  return out
}

const builder = new XMLBuilder({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  suppressEmptyNode: true,
})

function forBaseSchema(xml: string): string {
  const tree = ooxmlParser({ trimValues: false }).parse(xml) as XmlNode[]
  return builder.build(takeFallbacks(tree)) as string
}

/**
 * The Dublin Core schemas reach `dc.xsd` twice — through the location the
 * OPC schema names (mapped by the catalog) and through `dcterms.xsd`'s
 * relative import — and libxml2 notes that it skips the second. It is the
 * same file; nothing about the parts being validated.
 */
const DUPLICATE_IMPORT =
  /Schemas parser warning : Element '\{http:\/\/www\.w3\.org\/2001\/XMLSchema\}import': Skipping import of schema located at '[^']*\/dublin-core\/dc\.xsd' for the namespace 'http:\/\/purl\.org\/dc\/elements\/1\.1\/'/

function xmllintAvailable(): boolean {
  return spawnSync('xmllint', ['--version']).status === 0
}

/** Validate the package's XML parts; returns xmllint's complaints (empty when valid). */
async function validatePackage(bytes: Buffer): Promise<string[]> {
  const zip = await JSZip.loadAsync(bytes)
  const dir = mkdtempSync(join(tmpdir(), 'narrative-ooxml-'))
  try {
    const bySchema = new Map<string, string[]>()
    let n = 0
    for (const [path, entry] of Object.entries(zip.files)) {
      if (entry.dir || !(path.endsWith('.xml') || path.endsWith('.rels'))) continue
      const file = join(dir, `${String(n++).padStart(3, '0')}-${path.replace(/[^\w.-]/g, '_')}`)
      writeFileSync(file, forBaseSchema(await entry.async('string')))
      const schema = schemaFor(path)
      bySchema.set(schema, [...(bySchema.get(schema) ?? []), file])
    }
    const problems: string[] = []
    for (const [schema, files] of bySchema) {
      const r = spawnSync('xmllint', ['--noout', '--nonet', '--schema', schema, ...files], {
        encoding: 'utf8',
        env: { ...process.env, XML_CATALOG_FILES: join(SCHEMAS, 'catalog.xml') },
        maxBuffer: 64 * 1024 * 1024,
      })
      const lines = r.stderr
        .split('\n')
        .filter((l) => l.trim() !== '' && !/ validates$/.test(l) && !DUPLICATE_IMPORT.test(l))
      if (r.status !== 0 || lines.length > 0) problems.push(...lines)
    }
    return problems
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('exported .pptx against ECMA-376', () => {
  it('has xmllint to validate with', () => {
    expect(
      xmllintAvailable(),
      'install xmllint (libxml2-utils) to run the OOXML schema checks',
    ).toBe(true)
  })

  it('writes every part of the feature matrix schema-valid', async () => {
    const deck = await matrixDeck()
    const notesBySlideId = new Map(deck.notes)
    const bytes = await writeDeck(deck.slides, {
      title: 'Matrix & <validation>',
      author: 'Narrative',
      assetLoader: async (id) => deck.assets.get(id) ?? null,
      notesBySlideId,
      now: new Date(0),
    })
    expect(await validatePackage(bytes)).toEqual([])
  })

  it('reports a part that breaks the schema (the check is not vacuous)', async () => {
    const deck = await matrixDeck()
    const bytes = await writeDeck(deck.slides.slice(0, 2), {
      assetLoader: async (id) => deck.assets.get(id) ?? null,
      now: new Date(0),
    })
    const zip = await JSZip.loadAsync(bytes)
    const slide = await zip.file('ppt/slides/slide2.xml')!.async('string')
    // `<a:ext>` must follow `<a:off>` inside `<a:xfrm>`.
    const broken = slide.replace(/(<a:off [^>]*\/>)(<a:ext [^>]*\/>)/, '$2$1')
    expect(broken).not.toBe(slide)
    zip.file('ppt/slides/slide2.xml', broken)
    const problems = await validatePackage(await zip.generateAsync({ type: 'nodebuffer' }))
    expect(problems.some((l) => /slide2\.xml.*a:off/.test(l.replace(/\{[^}]*\}/g, 'a:')))).toBe(
      true,
    )
  })

  it('writes an empty deck schema-valid', async () => {
    const bytes = await writeDeck([], { now: new Date(0) })
    expect(await validatePackage(bytes)).toEqual([])
  })
})
