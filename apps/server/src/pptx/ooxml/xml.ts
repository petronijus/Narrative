/**
 * pptx/ooxml/xml.ts
 *
 * The writing half of XML: a small element tree and its serialisation.
 *
 * OOXML is schema-ordered — `<p:spPr>` children must appear in the order
 * the XSD sequence gives — so parts are built as trees in that order and
 * serialised in one place, where every attribute value and text node is
 * escaped. Nothing in the writer concatenates markup by hand.
 */

export type XmlAttrValue = string | number | boolean | undefined | null

export interface XmlElement {
  readonly name: string
  readonly attrs: Readonly<Record<string, XmlAttrValue>>
  readonly children: readonly XmlNode[]
}

/** A text node (escaped on output). */
export interface XmlText {
  readonly text: string
}

export type XmlNode = XmlElement | XmlText

/** What `el` accepts as children: nodes, strings, nested lists, and holes. */
export type XmlChild = XmlNode | string | null | undefined | false | readonly XmlChild[]

function flatten(children: readonly XmlChild[], out: XmlNode[]): XmlNode[] {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue
    if (typeof c === 'string') out.push({ text: c })
    else if (Array.isArray(c)) flatten(c as readonly XmlChild[], out)
    else out.push(c as XmlNode)
  }
  return out
}

/**
 * Build an element. Attributes whose value is `undefined` or `null` are left
 * out, so optional attributes can be passed straight through; children may
 * be nested arrays and may contain holes (`null`, `undefined`, `false`) for
 * the same reason.
 */
export function el(
  name: string,
  attrs: Record<string, XmlAttrValue> = {},
  ...children: XmlChild[]
): XmlElement {
  return { name, attrs, children: flatten(children, []) }
}

/** An element with no attributes. */
export function tag(name: string, ...children: XmlChild[]): XmlElement {
  return el(name, {}, ...children)
}

export function isElement(n: XmlNode): n is XmlElement {
  return (n as XmlElement).name !== undefined
}

const ATTR_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  '\t': '&#9;',
  '\n': '&#10;',
  '\r': '&#13;',
}
const TEXT_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;' }

/**
 * Characters XML 1.0 cannot carry at all (C0 controls other than tab, LF and
 * CR, plus the non-characters U+FFFE/U+FFFF). A deck typed by a person can
 * still contain them — pasted from somewhere — and one of them makes the
 * whole part unreadable, so they are dropped rather than written.
 */
const INVALID_XML_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g

export function escapeAttr(v: string): string {
  return v.replace(INVALID_XML_CHARS, '').replace(/[&<>"\t\n\r]/g, (c) => ATTR_ESCAPES[c]!)
}

export function escapeText(v: string): string {
  return v.replace(INVALID_XML_CHARS, '').replace(/[&<>]/g, (c) => TEXT_ESCAPES[c]!)
}

function attrString(v: XmlAttrValue): string | undefined {
  if (v === undefined || v === null) return undefined
  if (typeof v === 'boolean') return v ? '1' : '0'
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error(`ooxml/xml: non-finite attribute value ${v}`)
    return String(v)
  }
  return v
}

export function serialize(node: XmlNode): string {
  if (!isElement(node)) return escapeText(node.text)
  let out = `<${node.name}`
  for (const [k, raw] of Object.entries(node.attrs)) {
    const v = attrString(raw)
    if (v !== undefined) out += ` ${k}="${escapeAttr(v)}"`
  }
  if (node.children.length === 0) return `${out}/>`
  out += '>'
  for (const c of node.children) out += serialize(c)
  return `${out}</${node.name}>`
}

/** A complete part: declaration + root. */
export function xmlDocument(root: XmlElement): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n${serialize(root)}`
}

/** Namespaces the writer uses, by conventional prefix. */
export const NS = {
  a: 'http://schemas.openxmlformats.org/drawingml/2006/main',
  r: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  p: 'http://schemas.openxmlformats.org/presentationml/2006/main',
  mc: 'http://schemas.openxmlformats.org/markup-compatibility/2006',
  p14: 'http://schemas.microsoft.com/office/powerpoint/2010/main',
  p159: 'http://schemas.microsoft.com/office/powerpoint/2015/09/main',
  a14: 'http://schemas.microsoft.com/office/drawing/2010/main',
  rel: 'http://schemas.openxmlformats.org/package/2006/relationships',
  ct: 'http://schemas.openxmlformats.org/package/2006/content-types',
  cp: 'http://schemas.openxmlformats.org/package/2006/metadata/core-properties',
  dc: 'http://purl.org/dc/elements/1.1/',
  dcterms: 'http://purl.org/dc/terms/',
  dcmitype: 'http://purl.org/dc/dcmitype/',
  xsi: 'http://www.w3.org/2001/XMLSchema-instance',
  ep: 'http://schemas.openxmlformats.org/officeDocument/2006/extended-properties',
  vt: 'http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes',
} as const

/** `xmlns:*` attributes for a root element. */
export function xmlns(...prefixes: Array<keyof typeof NS>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const p of prefixes) out[`xmlns:${p}`] = NS[p]
  return out
}
