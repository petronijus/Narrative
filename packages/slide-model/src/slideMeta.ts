/**
 * slide-model/src/slideMeta.ts
 *
 * Two slide-level primitives the command layer (packages/commands) needs
 * and slides.ts does not offer:
 *
 *   - clearSlideTransitionDirection — `updateSlideTransition` treats an
 *     absent / undefined `direction` as "leave unchanged", so there was no
 *     way to remove a push direction once set. This is that way.
 *   - getSlideNotesText — a plain-text view of a slide's speaker notes for
 *     read-only callers (agent queries). Unlike `getSlideNotesFragment` it never
 *     writes: a pre-M19 slide without a notes fragment reads as `''`
 *     instead of having one installed lazily.
 */

import * as Y from 'yjs'
import { LOCAL_ORIGIN } from './mutations.js'
import type { SlideMutationContext } from './slideMutationContext.js'

function findSlideMap(ctx: SlideMutationContext, slideId: string): Y.Map<unknown> | undefined {
  for (let i = 0; i < ctx.slides.length; i++) {
    const m = ctx.slides.get(i)
    if (m.get('id') === slideId) return m
  }
  return undefined
}

/**
 * Remove the push direction from a slide's transition, so a later `push`
 * falls back to the runner's default direction. Returns false (and writes
 * nothing) when the slide or its transition record does not exist or has
 * no direction.
 */
export function clearSlideTransitionDirection(ctx: SlideMutationContext, slideId: string): boolean {
  const slide = findSlideMap(ctx, slideId)
  const transition = slide?.get('transition')
  if (!(transition instanceof Y.Map) || !transition.has('direction')) return false
  ctx.doc.transact(() => {
    transition.delete('direction')
  }, LOCAL_ORIGIN)
  return true
}

/**
 * Tiptap block nodes (StarterKit) whose text forms one line of the plain
 * view. Everything else that is an element is a container (lists, list
 * items, blockquotes) whose children are walked.
 */
const TEXT_BLOCKS = new Set(['paragraph', 'heading', 'codeBlock'])

/**
 * The speaker notes of a slide as plain text: one line per paragraph /
 * heading / code block, list items prefixed with "- " (bullets) or "N. "
 * (numbered, honouring the list's `start`) and indented two spaces per
 * nesting level, hard breaks as "\n", horizontal rules as "---". Marks
 * (bold, links, …) are dropped. Returns `''` for a slide without notes and
 * `null` when the slide does not exist. Never writes.
 */
export function getSlideNotesText(ctx: SlideMutationContext, slideId: string): string | null {
  const slide = findSlideMap(ctx, slideId)
  if (slide === undefined) return null
  const fragment = slide.get('notes')
  if (!(fragment instanceof Y.XmlFragment)) return ''

  const lines: string[] = []
  const inlineText = (el: Y.XmlElement | Y.XmlFragment): string => {
    let out = ''
    for (const child of el.toArray()) {
      if (child instanceof Y.XmlText) {
        for (const op of child.toDelta() as Array<{ insert: unknown }>) {
          if (typeof op.insert === 'string') out += op.insert
        }
      } else if (child instanceof Y.XmlElement) {
        out += child.nodeName === 'hardBreak' ? '\n' : inlineText(child)
      }
    }
    return out
  }
  const walk = (node: Y.XmlElement | Y.XmlFragment, depth: number, marker: string | null): void => {
    let pendingMarker = marker
    let ordinal = 1
    if (node instanceof Y.XmlElement && node.nodeName === 'orderedList') {
      const start = Number(node.getAttribute('start'))
      if (Number.isInteger(start) && start > 0) ordinal = start
    }
    for (const child of node.toArray()) {
      // ProseMirror never puts bare text directly under a container node.
      if (!(child instanceof Y.XmlElement)) continue
      const name = child.nodeName
      if (TEXT_BLOCKS.has(name)) {
        const indent = '  '.repeat(Math.max(0, depth - 1))
        const prefix = pendingMarker ?? (depth > 0 ? '  ' : '')
        lines.push(`${indent}${prefix}${inlineText(child)}`)
        pendingMarker = null
      } else if (name === 'horizontalRule') {
        lines.push('---')
      } else if (name === 'listItem') {
        const parentName = node instanceof Y.XmlElement ? node.nodeName : ''
        const itemMarker = parentName === 'orderedList' ? `${ordinal++}. ` : '- '
        walk(child, depth, itemMarker)
      } else if (name === 'bulletList' || name === 'orderedList') {
        walk(child, depth + 1, null)
      } else {
        walk(child, depth, null)
      }
    }
  }
  walk(fragment, 0, null)
  return lines.join('\n')
}
