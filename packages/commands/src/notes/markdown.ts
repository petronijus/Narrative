/**
 * commands/src/notes/markdown.ts — speaker notes as Markdown, both ways.
 *
 * Agents read and write a slide's notes as Markdown (slide.notes.get /
 * slide.notes.set); the notes are stored as the notes editor's document
 * (`NotesDoc`, slide-model/src/notes.ts). This module converts between the
 * two over mdast (CommonMark, plus GFM `~~strikethrough~~`):
 *
 *   paragraph, # heading (1–6), - / 1. lists (nested, ordered `start`),
 *   > quote, ``` code block (language), ---, **bold**, *italic*,
 *   ~~strike~~, `code`, [link](https://…), <u>underline</u>
 *
 * A newline inside a paragraph is a line break (speaker notes are written
 * line by line; CommonMark would join the lines), and so is the explicit
 * CommonMark hard break. Link targets go through the same sanitiser as
 * every other link. Anything the notes editor cannot hold (images, tables,
 * raw HTML other than <u>) is kept as its text.
 *
 * Loaded on demand (the commands import it dynamically in their `load`
 * phase) so the Markdown parser stays out of the editor's main bundle.
 */

import type {
  Blockquote,
  BlockContent,
  Code,
  DefinitionContent,
  Heading,
  List,
  ListItem,
  Nodes,
  Paragraph,
  PhrasingContent,
  Root,
  RootContent,
} from 'mdast'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { toMarkdown } from 'mdast-util-to-markdown'
import {
  gfmStrikethroughFromMarkdown,
  gfmStrikethroughToMarkdown,
} from 'mdast-util-gfm-strikethrough'
import { gfmStrikethrough } from 'micromark-extension-gfm-strikethrough'
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

// ---------------------------------------------------------------------------
// Markdown → NotesDoc
// ---------------------------------------------------------------------------

/** Marks in effect while walking inline content. */
type MarkSet = Readonly<NotesMarks>

function withMark(marks: MarkSet, name: string, attrs: Record<string, unknown> = {}): MarkSet {
  return { ...marks, [name]: attrs }
}

function textNode(text: string, marks: MarkSet): NotesText {
  return Object.keys(marks).length > 0 ? { text, marks: { ...marks } } : { text }
}

/** Inline mdast → notes inline nodes (text runs and hard breaks). */
function inline(nodes: readonly PhrasingContent[], outer: MarkSet): NotesNode[] {
  const out: NotesNode[] = []
  // `<u>` … `</u>` arrive as separate html nodes around the underlined runs.
  let marks = outer
  const pushText = (value: string, m: MarkSet): void => {
    // A newline inside a paragraph is a line break (see the header).
    value.split('\n').forEach((part, i) => {
      if (i > 0) out.push({ type: 'hardBreak' })
      if (part !== '') out.push(textNode(part, m))
    })
  }
  for (const n of nodes) {
    switch (n.type) {
      case 'text':
        pushText(n.value, marks)
        break
      case 'strong':
        out.push(...inline(n.children, withMark(marks, 'bold')))
        break
      case 'emphasis':
        out.push(...inline(n.children, withMark(marks, 'italic')))
        break
      case 'delete':
        out.push(...inline(n.children, withMark(marks, 'strike')))
        break
      case 'inlineCode':
        if (n.value !== '') out.push(textNode(n.value, withMark(marks, 'code')))
        break
      case 'break':
        out.push({ type: 'hardBreak' })
        break
      case 'link': {
        const href = sanitizeHref(n.url)
        const inner =
          href === null ? marks : withMark(marks, 'link', { href, ...NOTES_LINK_DEFAULTS })
        out.push(...inline(n.children, inner))
        break
      }
      case 'html': {
        const tag = n.value.trim().toLowerCase()
        if (tag === '<u>') marks = withMark(marks, 'underline')
        else if (tag === '</u>') {
          const { underline: _dropped, ...rest } = marks
          marks = rest
        } else pushText(n.value, marks)
        break
      }
      case 'image':
        if (n.alt) pushText(n.alt, marks)
        break
      default:
        // footnote references, link references…: keep what reads as text.
        if ('children' in n) out.push(...inline(n.children as PhrasingContent[], marks))
        else if ('value' in n && typeof n.value === 'string') pushText(n.value, marks)
    }
  }
  return mergeRuns(out)
}

function sameMarks(a: NotesMarks | undefined, b: NotesMarks | undefined): boolean {
  return JSON.stringify(a ?? {}) === JSON.stringify(b ?? {})
}

/** Join neighbouring text runs with identical marks (as the editor stores them). */
function mergeRuns(nodes: NotesNode[]): NotesNode[] {
  const out: NotesNode[] = []
  for (const n of nodes) {
    const last = out[out.length - 1]
    if (
      last !== undefined &&
      isNotesText(last) &&
      isNotesText(n) &&
      sameMarks(last.marks, n.marks)
    ) {
      out[out.length - 1] = { ...last, text: last.text + n.text }
    } else out.push(n)
  }
  return out
}

function element(
  type: string,
  content: NotesNode[],
  attrs?: Record<string, unknown>,
): NotesElement {
  const e: NotesElement = { type }
  if (attrs !== undefined && Object.keys(attrs).length > 0) e.attrs = attrs
  if (content.length > 0) e.content = content
  return e
}

function paragraphOf(p: Paragraph): NotesElement {
  return element('paragraph', inline(p.children, {}))
}

/** Block mdast → notes blocks. */
function blocks(nodes: ReadonlyArray<RootContent | BlockContent | DefinitionContent>): NotesNode[] {
  const out: NotesNode[] = []
  for (const n of nodes) {
    switch (n.type) {
      case 'paragraph':
        out.push(paragraphOf(n))
        break
      case 'heading':
        out.push(element('heading', inline((n as Heading).children, {}), { level: n.depth }))
        break
      case 'blockquote': {
        const content = blocks((n as Blockquote).children)
        // A quote holds at least one block in the editor's schema.
        out.push(element('blockquote', content.length > 0 ? content : [element('paragraph', [])]))
        break
      }
      case 'code': {
        const code = n as Code
        out.push(
          element(
            'codeBlock',
            code.value === '' ? [] : [{ text: code.value }],
            code.lang ? { language: code.lang } : undefined,
          ),
        )
        break
      }
      case 'thematicBreak':
        out.push({ type: 'horizontalRule' })
        break
      case 'list':
        out.push(listOf(n as List))
        break
      case 'html':
        // Raw HTML blocks: their text, as a paragraph.
        out.push(element('paragraph', inline([{ type: 'text', value: n.value }], {})))
        break
      default:
        // definitions, footnote definitions, tables (not enabled): drop.
        break
    }
  }
  return out
}

function listOf(list: List): NotesElement {
  const items = list.children.map((item: ListItem) => {
    const content = blocks(item.children)
    // A list item starts with a paragraph in the editor's schema.
    const first = content[0]
    if (first === undefined || isNotesText(first) || first.type !== 'paragraph') {
      content.unshift(element('paragraph', []))
    }
    return element('listItem', content)
  })
  return list.ordered === true
    ? element('orderedList', items, { start: list.start ?? 1 })
    : element('bulletList', items)
}

/** Parse Markdown into a notes document (`[]` for blank input). */
export function notesFromMarkdown(markdown: string): NotesDoc {
  const tree: Root = fromMarkdown(markdown, {
    extensions: [gfmStrikethrough({ singleTilde: false })],
    mdastExtensions: [gfmStrikethroughFromMarkdown()],
  })
  return blocks(tree.children)
}

// ---------------------------------------------------------------------------
// NotesDoc → Markdown
// ---------------------------------------------------------------------------

/** Mark order from the outside in, so nesting is stable across runs. */
const MARK_ORDER = ['link', 'bold', 'italic', 'strike', 'underline', 'code'] as const

/** One text run as mdast, its marks nested outside-in. */
function runToMdast(run: NotesText): PhrasingContent[] {
  const marks = run.marks ?? {}
  let nodes: PhrasingContent[] =
    marks['code'] !== undefined
      ? [{ type: 'inlineCode', value: run.text }]
      : [{ type: 'text', value: run.text }]
  for (const name of [...MARK_ORDER].reverse()) {
    if (name === 'code' || marks[name] === undefined) continue
    if (name === 'bold') nodes = [{ type: 'strong', children: nodes }]
    else if (name === 'italic') nodes = [{ type: 'emphasis', children: nodes }]
    else if (name === 'strike') nodes = [{ type: 'delete', children: nodes }]
    else if (name === 'underline')
      nodes = [{ type: 'html', value: '<u>' }, ...nodes, { type: 'html', value: '</u>' }]
    else if (name === 'link') {
      const href = marks['link']?.['href']
      if (typeof href === 'string' && sanitizeHref(href) !== null) {
        nodes = [{ type: 'link', url: href, children: nodes }]
      }
    }
  }
  return nodes
}

function inlineToMdast(content: readonly NotesNode[] | undefined): PhrasingContent[] {
  const out: PhrasingContent[] = []
  for (const n of content ?? []) {
    if (isNotesText(n)) out.push(...runToMdast(n))
    else if (n.type === 'hardBreak') out.push({ type: 'break' })
    else out.push(...inlineToMdast(n.content))
  }
  return out
}

function plainText(content: readonly NotesNode[] | undefined): string {
  let s = ''
  for (const n of content ?? []) {
    if (isNotesText(n)) s += n.text
    else if (n.type === 'hardBreak') s += '\n'
    else s += plainText(n.content)
  }
  return s
}

function blockToMdast(n: NotesNode): BlockContent[] {
  if (isNotesText(n)) return [{ type: 'paragraph', children: runToMdast(n) }]
  switch (n.type) {
    case 'paragraph':
      return [{ type: 'paragraph', children: inlineToMdast(n.content) }]
    case 'heading': {
      const level = Math.min(6, Math.max(1, Number(n.attrs?.['level'] ?? 1)))
      return [
        { type: 'heading', depth: level as Heading['depth'], children: inlineToMdast(n.content) },
      ]
    }
    case 'blockquote':
      return [{ type: 'blockquote', children: (n.content ?? []).flatMap(blockToMdast) }]
    case 'codeBlock': {
      const lang = n.attrs?.['language']
      return [
        {
          type: 'code',
          lang: typeof lang === 'string' && lang !== '' ? lang : null,
          value: plainText(n.content),
        },
      ]
    }
    case 'horizontalRule':
      return [{ type: 'thematicBreak' }]
    case 'bulletList':
    case 'orderedList': {
      const ordered = n.type === 'orderedList'
      const start = Number(n.attrs?.['start'] ?? 1)
      return [
        {
          type: 'list',
          ordered,
          ...(ordered ? { start: Number.isFinite(start) ? start : 1 } : {}),
          spread: false,
          children: (n.content ?? []).map((item): ListItem => ({
            type: 'listItem',
            spread: false,
            children: isNotesText(item)
              ? [{ type: 'paragraph', children: runToMdast(item) }]
              : (item.content ?? []).flatMap(blockToMdast),
          })),
        },
      ]
    }
    default:
      // A node Markdown has no form for: its content still reads.
      return (n.content ?? []).flatMap(blockToMdast)
  }
}

/** Render a notes document as Markdown (`''` for empty notes). */
export function notesToMarkdown(doc: NotesDoc): string {
  const root: Root = { type: 'root', children: doc.flatMap(blockToMdast) }
  if (root.children.length === 0) return ''
  return toMarkdown(root as Nodes, {
    extensions: [gfmStrikethroughToMarkdown()],
    bullet: '-',
    emphasis: '*',
    strong: '*',
    fences: true,
    rule: '-',
  }).trimEnd()
}
