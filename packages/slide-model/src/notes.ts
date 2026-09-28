/**
 * slide-model/src/notes.ts — a slide's speaker notes as a document.
 *
 * The notes are the notes editor's document — Tiptap's StarterKit schema
 * (paragraphs, headings, bullet and ordered lists, blockquotes, code
 * blocks, rules, hard breaks; bold, italic, strike, underline, code,
 * links) — stored in a `Y.XmlFragment` the way y-prosemirror stores any
 * ProseMirror document: an element per node, named after its type, with
 * the node's attributes; text as `Y.XmlText` whose formatting attributes
 * are the marks. `NotesDoc` is that document as plain JSON, the form the
 * PowerPoint writer and reader and the notes commands work with.
 *
 * The editor itself edits the fragment through the y-prosemirror binding;
 * `setSlideNotes` is how everything else (commands, PowerPoint import)
 * replaces a slide's notes.
 */

import * as Y from 'yjs'
import { LOCAL_ORIGIN } from './mutations.js'
import type { SlideMutationContext } from './slideMutationContext.js'

/** A text run's marks: mark name → the mark's attributes (`{}` when it has none). */
export type NotesMarks = Record<string, Record<string, unknown>>

export interface NotesText {
  text: string
  marks?: NotesMarks
}

export interface NotesElement {
  type: string
  attrs?: Record<string, unknown>
  content?: NotesNode[]
}

export type NotesNode = NotesText | NotesElement

/** A notes document: its top-level blocks. */
export type NotesDoc = NotesNode[]

export const isNotesText = (n: NotesNode): n is NotesText => 'text' in n

/**
 * The attributes the notes editor's Link mark gives every link besides its
 * `href` (Tiptap's defaults), so a link written from outside the editor is
 * stored exactly like one the editor made.
 */
export const NOTES_LINK_DEFAULTS: Readonly<{ target: string; rel: string; class: null }> = {
  target: '_blank',
  rel: 'noopener noreferrer nofollow',
  class: null,
}

/** A notes fragment as JSON (y-prosemirror's encoding, see the header). */
export function notesFromFragment(fragment: Y.XmlFragment): NotesDoc {
  const nodes = (items: Array<Y.XmlElement | Y.XmlText | Y.XmlHook>): NotesNode[] => {
    const out: NotesNode[] = []
    for (const item of items) {
      if (item instanceof Y.XmlText) {
        for (const op of item.toDelta() as Array<{ insert: unknown; attributes?: NotesMarks }>) {
          if (typeof op.insert !== 'string') continue
          out.push(
            op.attributes !== undefined
              ? { text: op.insert, marks: op.attributes }
              : { text: op.insert },
          )
        }
      } else if (item instanceof Y.XmlElement) {
        const node: NotesElement = { type: item.nodeName }
        const attrs = item.getAttributes() as Record<string, unknown>
        if (Object.keys(attrs).length > 0) node.attrs = attrs
        const content = nodes(item.toArray() as Array<Y.XmlElement | Y.XmlText>)
        if (content.length > 0) node.content = content
        out.push(node)
      }
    }
    return out
  }
  return nodes(fragment.toArray() as Array<Y.XmlElement | Y.XmlText>)
}

/**
 * Fill an empty notes fragment with a document, as y-prosemirror would
 * (consecutive text nodes share one `Y.XmlText`).
 */
export function writeNotesIntoFragment(fragment: Y.XmlFragment, doc: NotesDoc): void {
  const build = (content: readonly NotesNode[]): Array<Y.XmlElement | Y.XmlText> => {
    const out: Array<Y.XmlElement | Y.XmlText> = []
    let delta: Array<{ insert: string; attributes?: NotesMarks }> = []
    const flush = (): void => {
      if (delta.length === 0) return
      const t = new Y.XmlText()
      t.applyDelta(delta)
      out.push(t)
      delta = []
    }
    for (const n of content) {
      if (isNotesText(n)) {
        delta.push(
          n.marks !== undefined ? { insert: n.text, attributes: n.marks } : { insert: n.text },
        )
        continue
      }
      flush()
      const e = new Y.XmlElement(n.type)
      for (const [k, v] of Object.entries(n.attrs ?? {})) e.setAttribute(k, v as string)
      e.insert(0, build(n.content ?? []))
      out.push(e)
    }
    flush()
    return out
  }
  fragment.insert(0, build(doc))
}

function findSlideMap(ctx: SlideMutationContext, slideId: string): Y.Map<unknown> | undefined {
  for (let i = 0; i < ctx.slides.length; i++) {
    const m = ctx.slides.get(i)
    if (m.get('id') === slideId) return m
  }
  return undefined
}

/**
 * A slide's notes as a document: `[]` for a slide without notes, `null`
 * when the slide does not exist. Never writes (a pre-M19 slide without a
 * notes fragment reads as empty rather than having one installed).
 */
export function getSlideNotesDoc(ctx: SlideMutationContext, slideId: string): NotesDoc | null {
  const slide = findSlideMap(ctx, slideId)
  if (slide === undefined) return null
  const fragment = slide.get('notes')
  return fragment instanceof Y.XmlFragment ? notesFromFragment(fragment) : []
}

/**
 * Replace a slide's speaker notes with `doc` (`[]` clears them), in one
 * transaction. The slide's existing fragment is emptied and refilled rather
 * than swapped for a new one, so an open notes editor — bound to that
 * fragment — shows the new notes at once. Returns false (and writes
 * nothing) when the slide does not exist.
 */
export function setSlideNotes(ctx: SlideMutationContext, slideId: string, doc: NotesDoc): boolean {
  const slide = findSlideMap(ctx, slideId)
  if (slide === undefined) return false
  ctx.doc.transact(() => {
    let fragment = slide.get('notes')
    if (!(fragment instanceof Y.XmlFragment)) {
      fragment = new Y.XmlFragment()
      slide.set('notes', fragment)
    }
    const notes = fragment as Y.XmlFragment
    if (notes.length > 0) notes.delete(0, notes.length)
    if (doc.length > 0) writeNotesIntoFragment(notes, doc)
  }, LOCAL_ORIGIN)
  return true
}
