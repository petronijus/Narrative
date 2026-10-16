/**
 * pptx/ooxml/notes.ts
 *
 * Speaker notes, both directions.
 *
 * In the model a slide's notes are the notes editor's document — Tiptap's
 * StarterKit schema (paragraphs, headings, bullet and ordered lists,
 * blockquotes, code blocks, rules; bold, italic, strike, underline, code,
 * links) — stored in a `Y.XmlFragment` the way y-prosemirror stores any
 * ProseMirror document: an element per node, named after its type, with
 * the node's attributes; text as `Y.XmlText` whose formatting attributes
 * are the marks. `NotesDoc` is that document as plain JSON.
 *
 * PowerPoint's notes page is a text body. The writer lays the document out
 * the way PowerPoint can show it — runs with bold / italic / strike /
 * underline, code in a monospace face, headings larger and bold, list items
 * with bullets or numbers at their nesting level, quotes indented, links —
 * and puts the exact document in the notes slide's extension. The reader
 * takes the extension while the native body still says the same text (the
 * notes were not edited in PowerPoint since), and otherwise builds a
 * document from the native body: formatted paragraphs and nested lists.
 */

import { sanitizeHref } from '@narrative/shared'
import {
  NOTES_LINK_DEFAULTS,
  isNotesText,
  type NotesDoc,
  type NotesElement,
  type NotesMarks,
  type NotesNode,
  type NotesText,
} from '@narrative/slide-model'
import { el, tag, type XmlChild, type XmlElement } from './xml.js'
import { type XmlNode, findAll, findFirst, getAttrs, getChildren, getTag } from './read.js'
import { AUTONUM } from './vocabulary.js'
import { int, oneOf, str, type Schema } from './extSchema.js'

// ---------------------------------------------------------------------------
// The document — NotesDoc and its fragment encoding live in slide-model
// (notes.ts), shared with the notes commands.
// ---------------------------------------------------------------------------

const isText = isNotesText

// ---------------------------------------------------------------------------
// The document, validated (it comes from a file)
// ---------------------------------------------------------------------------

/** Node types of the notes editor's schema, each with the attributes it takes. */
const NODE_ATTRS: Record<string, Record<string, Schema>> = {
  paragraph: {},
  heading: { level: int(1, 6) },
  bulletList: {},
  orderedList: { start: int(0, 1_000_000), type: oneOf('1', 'a', 'A', 'i', 'I') },
  listItem: {},
  blockquote: {},
  codeBlock: { language: str(64) },
  horizontalRule: {},
  hardBreak: {},
}

const nullableStr =
  (n: number): Schema =>
  (v) =>
    v === null ? null : str(n)(v)

/** Marks of the notes editor's schema. A link's target is sanitised like any imported link. */
const MARK_ATTRS: Record<string, Record<string, Schema>> = {
  bold: {},
  italic: {},
  strike: {},
  underline: {},
  code: {},
  link: {
    href: (v) => (typeof v === 'string' ? (sanitizeHref(v) ?? undefined) : undefined),
    target: nullableStr(32),
    rel: nullableStr(128),
    class: nullableStr(128),
  },
}

const MAX_NODES = 50_000
const MAX_DEPTH = 32

function checkAttrs(
  value: unknown,
  fields: Record<string, Schema>,
): Record<string, unknown> | undefined {
  if (value === undefined) return {}
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const schema = fields[k]
    if (schema === undefined) return undefined
    const parsed = schema(v)
    if (parsed === undefined) return undefined
    out[k] = parsed
  }
  return out
}

/** The document the notes extension carries, or undefined when it is not one the editor can hold. */
export function validNotesDoc(value: unknown): NotesDoc | undefined {
  let count = 0
  const node = (v: unknown, depth: number): NotesNode | undefined => {
    if (++count > MAX_NODES || depth > MAX_DEPTH) return undefined
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return undefined
    const r = v as Record<string, unknown>
    if ('text' in r) {
      if (typeof r['text'] !== 'string' || r['text'].length === 0) return undefined
      const out: NotesText = { text: r['text'] }
      if (r['marks'] !== undefined) {
        if (r['marks'] === null || typeof r['marks'] !== 'object' || Array.isArray(r['marks']))
          return undefined
        const marks: NotesMarks = {}
        for (const [name, attrs] of Object.entries(r['marks'] as Record<string, unknown>)) {
          const fields = MARK_ATTRS[name]
          const checked = fields !== undefined ? checkAttrs(attrs, fields) : undefined
          if (checked === undefined) return undefined
          marks[name] = checked
        }
        out.marks = marks
      }
      return out
    }
    const type = r['type']
    if (typeof type !== 'string' || NODE_ATTRS[type] === undefined) return undefined
    const out: NotesElement = { type }
    const attrs = checkAttrs(r['attrs'], NODE_ATTRS[type]!)
    if (attrs === undefined) return undefined
    if (Object.keys(attrs).length > 0) out.attrs = attrs
    if (r['content'] !== undefined) {
      if (!Array.isArray(r['content'])) return undefined
      const content: NotesNode[] = []
      for (const c of r['content']) {
        const n = node(c, depth + 1)
        if (n === undefined) return undefined
        content.push(n)
      }
      if (content.length > 0) out.content = content
    }
    return out
  }
  if (!Array.isArray(value)) return undefined
  const doc: NotesDoc = []
  for (const v of value) {
    const n = node(v, 0)
    if (n === undefined) return undefined
    doc.push(n)
  }
  return doc
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

export interface NotesWriteContext {
  /** Relationship id of a URL hyperlink on the notes slide. */
  hyperlinkRelId(href: string): string
}

/** PowerPoint's notes text size, and headings above it (hundredths of a point). */
const NOTES_SIZE = 1200
const HEADING_SIZE: Record<number, number> = { 1: 2000, 2: 1600, 3: 1400 }
const MONOSPACE = 'Consolas'
/** Indent per list level and for a quote, EMU (0.25 in). */
const INDENT_EMU = 228_600

interface Line {
  inline: NotesNode[]
  level: number
  indent: number
  bullet?: { kind: 'bullet' } | { kind: 'number'; startAt?: number }
  heading?: number
  code?: boolean
}

/** The document's blocks as PowerPoint paragraphs, in order. */
function layout(doc: NotesDoc): Line[] {
  const lines: Line[] = []
  const blocks = (
    nodes: readonly NotesNode[],
    ctx: { level: number; indent: number; list?: { kind: 'bullet' | 'number'; start: number } },
  ): void => {
    for (const n of nodes) {
      if (isText(n)) {
        // Inline content where a block belongs: its own paragraph.
        lines.push({ inline: [n], level: ctx.level, indent: ctx.indent })
        continue
      }
      switch (n.type) {
        case 'paragraph':
          lines.push({ inline: n.content ?? [], level: ctx.level, indent: ctx.indent })
          break
        case 'heading':
          lines.push({
            inline: n.content ?? [],
            level: ctx.level,
            indent: ctx.indent,
            heading: Number(n.attrs?.['level'] ?? 1),
          })
          break
        case 'codeBlock':
          lines.push({ inline: n.content ?? [], level: ctx.level, indent: ctx.indent, code: true })
          break
        case 'horizontalRule':
          lines.push({ inline: [], level: ctx.level, indent: ctx.indent })
          break
        case 'blockquote':
          blocks(n.content ?? [], { level: ctx.level, indent: ctx.indent + INDENT_EMU })
          break
        case 'bulletList':
        case 'orderedList': {
          const kind = n.type === 'bulletList' ? 'bullet' : 'number'
          const start = Number(n.attrs?.['start'] ?? 1)
          const level = ctx.list === undefined ? 0 : ctx.level + 1
          ;(n.content ?? []).forEach((item, i) => {
            const children = isText(item) ? [item] : (item.content ?? [])
            children.forEach((child, j) => {
              const before = lines.length
              blocks([child], {
                level,
                indent: ctx.indent + (level + 1) * INDENT_EMU,
                list: { kind, start },
              })
              // The item's first paragraph carries its marker.
              if (j === 0 && lines.length > before && lines[before]!.bullet === undefined) {
                lines[before]!.bullet =
                  kind === 'bullet' ? { kind } : i === 0 ? { kind, startAt: start } : { kind }
              }
            })
          })
          break
        }
        default:
          // A node the layout does not know: its content still reads.
          blocks(n.content ?? [], ctx)
      }
    }
  }
  blocks(doc, { level: 0, indent: 0 })
  return lines
}

function runProps(marks: NotesMarks | undefined, line: Line, ctx: NotesWriteContext): XmlElement {
  const m = marks ?? {}
  const bold = m['bold'] !== undefined || line.heading !== undefined
  const size = line.heading !== undefined ? (HEADING_SIZE[line.heading] ?? NOTES_SIZE) : undefined
  const mono = m['code'] !== undefined || line.code === true
  const href = typeof m['link']?.['href'] === 'string' ? sanitizeHref(m['link']['href']) : null
  return el(
    'a:rPr',
    {
      lang: 'en-US',
      sz: size,
      b: bold ? 1 : undefined,
      i: m['italic'] !== undefined ? 1 : undefined,
      u: m['underline'] !== undefined ? 'sng' : undefined,
      strike: m['strike'] !== undefined ? 'sngStrike' : undefined,
      dirty: 0,
    },
    mono && [
      el('a:latin', { typeface: MONOSPACE }),
      el('a:ea', { typeface: MONOSPACE }),
      el('a:cs', { typeface: MONOSPACE }),
    ],
    href !== null && el('a:hlinkClick', { 'r:id': ctx.hyperlinkRelId(href) }),
  )
}

/** The notes body's paragraphs, and the text they show (the extension's fingerprint). */
export function writeNotesBody(
  doc: NotesDoc,
  ctx: NotesWriteContext,
): { paragraphs: XmlElement[]; text: string } {
  const texts: string[] = []
  const paragraphs = layout(doc).map((line) => {
    let text = ''
    const inline: XmlChild[] = []
    for (const n of line.inline) {
      if (isText(n)) {
        // A code block's line breaks are lines of their own.
        n.text.split('\n').forEach((part, i) => {
          if (i > 0) {
            inline.push(tag('a:br', runProps(n.marks, line, ctx)))
            text += '\n'
          }
          if (part.length > 0) {
            inline.push(tag('a:r', runProps(n.marks, line, ctx), tag('a:t', part)))
            text += part
          }
        })
      } else if (n.type === 'hardBreak') {
        inline.push(tag('a:br', runProps(undefined, line, ctx)))
        text += '\n'
      }
    }
    texts.push(text)
    const b = line.bullet
    return tag(
      'a:p',
      el(
        'a:pPr',
        {
          marL: line.indent > 0 ? line.indent : undefined,
          indent: b !== undefined ? -INDENT_EMU : undefined,
          lvl: line.level > 0 ? Math.min(8, line.level) : undefined,
        },
        b === undefined
          ? tag('a:buNone')
          : b.kind === 'bullet'
            ? el('a:buChar', { char: '•' })
            : el('a:buAutoNum', {
                type: AUTONUM.toXml('decimal'),
                startAt: b.startAt !== undefined && b.startAt !== 1 ? b.startAt : undefined,
              }),
      ),
      inline,
      el('a:endParaRPr', { lang: 'en-US', dirty: 0 }),
    )
  })
  return { paragraphs, text: texts.join(' ') }
}

export const NARRATIVE_NOTES_EXT_URI = '{3A7D1E58-9C2B-4F6A-B5E0-8D4C1F2A7B96}'
const NARRATIVE_NOTES_NS = 'urn:narrative:ooxml:notes:1'

/** `<p:extLst>` for `<p:notes>`: the exact document and the text the native body shows. */
export function writeNotesExt(doc: NotesDoc, text: string): XmlElement {
  return tag(
    'p:extLst',
    el(
      'p:ext',
      { uri: NARRATIVE_NOTES_EXT_URI },
      el('nx:notes', { 'xmlns:nx': NARRATIVE_NOTES_NS, text, doc: JSON.stringify(doc) }),
    ),
  )
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** Where a notes run's `<a:hlinkClick r:id>` leads, when it is a URL. */
export type NotesLinkResolver = (rId: string) => string | undefined

function readMarks(rPr: XmlNode | undefined, links: NotesLinkResolver): NotesMarks | undefined {
  if (rPr === undefined) return undefined
  const a = getAttrs(rPr)
  const marks: NotesMarks = {}
  if (a['@b'] === '1' || a['@b'] === 'true') marks['bold'] = {}
  if (a['@i'] === '1' || a['@i'] === 'true') marks['italic'] = {}
  if (typeof a['@u'] === 'string' && a['@u'] !== 'none') marks['underline'] = {}
  if (typeof a['@strike'] === 'string' && a['@strike'] !== 'noStrike') marks['strike'] = {}
  const kids = getChildren(rPr, getTag(rPr) ?? 'a:rPr')
  const latin = findFirst(kids, 'a:latin')
  if (latin !== undefined && getAttrs(latin)['@typeface'] === MONOSPACE) marks['code'] = {}
  const hlink = findFirst(kids, 'a:hlinkClick')
  const rId = hlink !== undefined ? getAttrs(hlink)['@r:id'] : undefined
  const href = typeof rId === 'string' ? links(rId) : undefined
  const safe = href !== undefined ? sanitizeHref(href) : null
  if (safe !== null) marks['link'] = { href: safe, ...NOTES_LINK_DEFAULTS }
  return Object.keys(marks).length > 0 ? marks : undefined
}

interface NativeParagraph {
  inline: NotesNode[]
  text: string
  list?: 'bullet' | 'number'
  startAt?: number
  level: number
}

function readParagraph(p: XmlNode, links: NotesLinkResolver): NativeParagraph {
  const kids = getChildren(p, 'a:p')
  const pPr = findFirst(kids, 'a:pPr')
  const out: NativeParagraph = { inline: [], text: '', level: 0 }
  if (pPr !== undefined) {
    const lvl = Number(getAttrs(pPr)['@lvl'] ?? 0)
    if (Number.isFinite(lvl) && lvl > 0) out.level = Math.min(8, Math.floor(lvl))
    const pKids = getChildren(pPr, 'a:pPr')
    if (findFirst(pKids, 'a:buChar') !== undefined) out.list = 'bullet'
    const auto = findFirst(pKids, 'a:buAutoNum')
    if (auto !== undefined) {
      out.list = 'number'
      const s = Number(getAttrs(auto)['@startAt'])
      if (Number.isFinite(s) && s >= 1) out.startAt = Math.floor(s)
    }
  }
  const push = (n: NotesNode): void => {
    const last = out.inline[out.inline.length - 1]
    // Adjacent runs with the same marks are one text node.
    if (
      last !== undefined &&
      isText(last) &&
      isText(n) &&
      JSON.stringify(last.marks) === JSON.stringify(n.marks)
    ) {
      last.text += n.text
    } else {
      out.inline.push(n)
    }
  }
  for (const child of kids) {
    const t = getTag(child)
    if (t === 'a:br') {
      push({ type: 'hardBreak' })
      out.text += '\n'
    } else if (t === 'a:r') {
      const rKids = getChildren(child, 'a:r')
      const tNode = findFirst(rKids, 'a:t')
      const text =
        tNode !== undefined
          ? getChildren(tNode, 'a:t')
              .map((c) => String((c as { '#text'?: unknown })['#text'] ?? ''))
              .join('')
          : ''
      if (text.length === 0) continue
      const marks = readMarks(findFirst(rKids, 'a:rPr'), links)
      push(marks !== undefined ? { text, marks } : { text })
      out.text += text
    }
  }
  return out
}

/** A document from a native notes body: formatted paragraphs, list paragraphs as nested lists. */
function documentOf(paragraphs: readonly NativeParagraph[]): NotesDoc {
  const doc: NotesDoc = []
  const stack: Array<{ list: NotesElement; kind: 'bullet' | 'number'; level: number }> = []
  for (const p of paragraphs) {
    const para: NotesElement = { type: 'paragraph' }
    if (p.inline.length > 0) para.content = p.inline
    if (p.list === undefined) {
      stack.length = 0
      doc.push(para)
      continue
    }
    while (stack.length > 0 && stack[stack.length - 1]!.level > p.level) stack.pop()
    const top = stack[stack.length - 1]
    if (top !== undefined && top.level === p.level && top.kind !== p.list) stack.pop()
    const current = stack[stack.length - 1]
    let list: NotesElement
    if (current !== undefined && current.level === p.level) {
      list = current.list
    } else {
      list = { type: p.list === 'bullet' ? 'bulletList' : 'orderedList', content: [] }
      if (p.list === 'number') list.attrs = { start: p.startAt ?? 1 }
      const parent = stack[stack.length - 1]
      const parentItem = parent?.list.content?.[parent.list.content.length - 1] as
        NotesElement | undefined
      if (parentItem !== undefined) parentItem.content = [...(parentItem.content ?? []), list]
      else doc.push(list)
      stack.push({ list, kind: p.list, level: p.level })
    }
    list.content!.push({ type: 'listItem', content: [para] })
  }
  return doc
}

/**
 * The notes document in a notes slide (`<p:notes>`'s children): the exact
 * one from a Narrative export while the native body still shows its text,
 * else the one the native body says. Undefined for a notes page with no
 * body text at all.
 */
export function readNotes(
  notesChildren: XmlNode[],
  links: NotesLinkResolver,
): NotesDoc | undefined {
  const cSld = findFirst(notesChildren, 'p:cSld')
  const spTree = cSld !== undefined ? findFirst(getChildren(cSld, 'p:cSld'), 'p:spTree') : undefined
  if (spTree === undefined) return undefined
  // The notes are the body placeholder's text (PowerPoint also places the
  // slide image, header, date and number placeholders on a notes page).
  let body: XmlNode | undefined
  let fallback: XmlNode | undefined
  for (const sp of findAll(getChildren(spTree, 'p:spTree'), 'p:sp')) {
    const spKids = getChildren(sp, 'p:sp')
    const nv = findFirst(spKids, 'p:nvSpPr')
    const nvPr = nv !== undefined ? findFirst(getChildren(nv, 'p:nvSpPr'), 'p:nvPr') : undefined
    const ph = nvPr !== undefined ? findFirst(getChildren(nvPr, 'p:nvPr'), 'p:ph') : undefined
    const txBody = findFirst(spKids, 'p:txBody')
    if (txBody === undefined) continue
    const type = ph !== undefined ? getAttrs(ph)['@type'] : undefined
    if (type === 'body') {
      body = txBody
      break
    }
    // Older exporters mark the body by index only.
    if (ph !== undefined && type === undefined && fallback === undefined) fallback = txBody
  }
  const txBody = body ?? fallback
  if (txBody === undefined) return undefined
  const paragraphs = findAll(getChildren(txBody, 'p:txBody'), 'a:p').map((p) =>
    readParagraph(p, links),
  )
  const text = paragraphs.map((p) => p.text).join(' ')

  const extLst = findFirst(notesChildren, 'p:extLst')
  if (extLst !== undefined) {
    for (const ext of getChildren(extLst, 'p:extLst')) {
      if (getTag(ext) !== 'p:ext' || getAttrs(ext)['@uri'] !== NARRATIVE_NOTES_EXT_URI) continue
      const node = findFirst(getChildren(ext, 'p:ext'), 'nx:notes')
      if (node === undefined || getAttrs(node)['@text'] !== text) break
      try {
        const doc = validNotesDoc(JSON.parse(String(getAttrs(node)['@doc'] ?? '[]')))
        if (doc !== undefined) return doc
      } catch {
        /* malformed: the native body stands */
      }
      break
    }
  }
  if (paragraphs.every((p) => p.text.trim() === '')) return undefined
  return documentOf(paragraphs)
}
