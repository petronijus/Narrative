/**
 * pptx/ooxml/read.ts
 *
 * The reading half of XML: how every OOXML part is parsed, and the helpers
 * that walk fast-xml-parser's `preserveOrder` tree. Shared by the importer and
 * by the round-trip tests that read what the exporter wrote.
 */

import { XMLParser, type X2jOptions } from 'fast-xml-parser'
import * as nodableEntities from '@nodable/entities'
import type { EntityDecoderOptions } from '@nodable/entities'

/**
 * `@nodable/entities` 2.1 exports its decoder by name, with every method
 * fast-xml-parser calls on it (`decode`, `reset`, `setXmlVersion`, …); its
 * published typings declare it as a default export and leave
 * `setXmlVersion` out. This is the module's runtime shape.
 */
const { EntityDecoder } = nodableEntities as unknown as {
  EntityDecoder: new (options: EntityDecoderOptions) => NonNullable<X2jOptions['entityDecoder']>
}

/**
 * fast-xml-parser preserveOrder layout:
 *   - Each element is an object with exactly one tag key (besides ':@' for
 *     attrs), and the value is an array of child elements.
 *   - Text content lives in `{ '#text': '...' }` entries.
 *   - Attributes live in `{ ':@': { '@attr': value, ... } }`.
 */
export type XmlNode = Record<string, unknown>

/**
 * The one XMLParser configuration every OOXML part is read with.
 *
 * `parseTagValue: false` is the point: fast-xml-parser otherwise turns text
 * that looks numeric into a number, and every reader here only takes
 * `#text` when it is a string — so a run whose whole text was "2", "2026" or
 * "10" silently vanished from the import (and "007" would have become 7).
 * PowerPoint splits runs at every formatting change, so a bold year inside a
 * sentence is exactly such a run. Text is text; attributes are converted
 * explicitly where they are read.
 */
/**
 * The parser's entity decoder, set up for XML: the predefined entities and
 * character references (`&#10;`, `&#x2029;`, `&#233;`), which are XML text
 * — fast-xml-parser's own default leaves the references as literal `&#…;`.
 * No HTML named entities: XML has none. Expansion is limited as
 * fast-xml-parser limits it by default (100 000 expanded characters per
 * document, every entity counted). One decoder per parser: it keeps
 * per-document counters.
 */
function xmlEntityDecoder(): NonNullable<X2jOptions['entityDecoder']> {
  return new EntityDecoder({
    numericAllowed: true,
    limit: { maxTotalExpansions: 0, maxExpandedLength: 100_000, applyLimitsTo: 'all' },
  })
}

export function ooxmlParser(opts: { trimValues?: boolean } = {}): XMLParser {
  return new XMLParser({
    entityDecoder: xmlEntityDecoder(),
    ignoreAttributes: false,
    attributeNamePrefix: '@',
    preserveOrder: true,
    ignoreDeclaration: true,
    parseTagValue: false,
    trimValues: opts.trimValues ?? true,
  })
}

export function getAttrs(node: XmlNode): Record<string, unknown> {
  const a = node[':@']
  return a !== null && typeof a === 'object' ? (a as Record<string, unknown>) : {}
}

export function getTag(node: XmlNode): string | null {
  for (const key of Object.keys(node)) {
    if (key !== ':@' && key !== '#text') return key
  }
  return null
}

export function getChildren(node: XmlNode, tag: string): XmlNode[] {
  const v = node[tag]
  return Array.isArray(v) ? (v as XmlNode[]) : []
}

export function findFirst(nodes: XmlNode[], tag: string): XmlNode | undefined {
  for (const n of nodes) {
    if (getTag(n) === tag) return n
  }
  return undefined
}

export function findAll(nodes: XmlNode[], tag: string): XmlNode[] {
  return nodes.filter((n) => getTag(n) === tag)
}

/** Recursive: yields every node in the subtree (depth-first). */
export function* walk(nodes: XmlNode[]): IterableIterator<XmlNode> {
  for (const n of nodes) {
    yield n
    const tag = getTag(n)
    if (tag !== null) {
      yield* walk(getChildren(n, tag))
    }
  }
}
