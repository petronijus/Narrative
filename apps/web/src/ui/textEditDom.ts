/**
 * ui/textEditDom.ts
 *
 * Pure DOM ↔ editable-string mapping for the inline text-edit overlay.
 * Extracted from TextEditOverlay so the tree-walking logic can be unit
 * tested in jsdom independently of the contenteditable / selection model.
 *
 * The contenteditable mirrors `buildListedHtml`: one `<div data-pb>` per
 * paragraph, list markers as `<span data-marker contenteditable="false">`,
 * and empty paragraphs carrying `<br data-empty>`. The "editable string"
 * model is the paragraphs joined by U+2029 (PARAGRAPH_SEP); these helpers
 * translate between DOM points and that string:
 *   - top-level <div>/<p>   → a paragraph; a U+2029 separates consecutive ones
 *   - text node             → its characters
 *   - <br> (not data-empty) → one '\n' (soft line break inside a paragraph)
 *   - <span data-marker>    → 0 chars (the glyph is not part of the body)
 *   - <br data-empty>       → 0 chars (empty-paragraph placeholder)
 */

import { PARAGRAPH_SEP } from '@narrative/slide-model'

export function isParaBlock(n: Node): boolean {
  return n.nodeName === 'DIV' || n.nodeName === 'P'
}
export function isMarkerEl(n: Node): boolean {
  return n.nodeType === Node.ELEMENT_NODE && (n as HTMLElement).dataset['marker'] === '1'
}
export function isEmptyBr(n: Node): boolean {
  return n.nodeName === 'BR' && (n as HTMLElement).dataset?.['empty'] === '1'
}

/** Count body chars contributed by an inline subtree (markers/empty skipped). */
export function countInline(node: Node): number {
  if (node.nodeType === Node.TEXT_NODE) return (node.nodeValue ?? '').length
  if (node.nodeName === 'BR') return isEmptyBr(node) ? 0 : 1
  if (isMarkerEl(node)) return 0
  let n = 0
  for (let i = 0; i < node.childNodes.length; i++) n += countInline(node.childNodes[i]!)
  return n
}

/** Reconstruct the editable-string body from the contenteditable DOM. */
export function getElementInnerText(el: HTMLElement): string {
  let out = ''
  let paraStarted = false
  const inline = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      out += node.nodeValue ?? ''
      return
    }
    if (node.nodeName === 'BR') {
      if (!isEmptyBr(node)) out += '\n'
      return
    }
    if (isMarkerEl(node)) return
    for (let i = 0; i < node.childNodes.length; i++) inline(node.childNodes[i]!)
  }
  for (let i = 0; i < el.childNodes.length; i++) {
    const top = el.childNodes[i]!
    if (isParaBlock(top)) {
      if (paraStarted) out += PARAGRAPH_SEP
      paraStarted = true
      for (let j = 0; j < top.childNodes.length; j++) inline(top.childNodes[j]!)
    } else {
      // Bare top-level content (transient, pre-rebuild) — part of the
      // current paragraph, no separator.
      paraStarted = true
      inline(top)
    }
  }
  return out
}

/**
 * Convert a DOM Range endpoint to an editable-string char index, matching
 * `getElementInnerText`'s model (paragraph separators between top-level
 * blocks, markers/empty-brs contributing nothing).
 */
export function domPositionToCharIndex(root: Node, container: Node, offset: number): number {
  // Chrome parks the caret INSIDE the leading non-editable marker span on a
  // bare Home keypress (e.g. on the "•" text node at offset 0). The marker
  // contributes no body chars, so resolve such a caret to the start of the
  // paragraph's actual text (right after the marker) — otherwise the index
  // is wrong and start-of-line gestures (Backspace-merge) misfire.
  {
    let n: Node | null = container
    while (n !== null && n !== root) {
      if (isMarkerEl(n)) {
        const parent = n.parentNode
        if (parent !== null) {
          container = parent
          offset = Array.prototype.indexOf.call(parent.childNodes, n) + 1
        }
        break
      }
      n = n.parentNode
    }
  }
  let count = 0
  let paraStarted = false
  let found = false
  let result = 0
  const stopAt = (node: Node, off: number): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      count += Math.min(off, (node.nodeValue ?? '').length)
    } else {
      for (let i = 0; i < off && i < node.childNodes.length; i++)
        count += countInline(node.childNodes[i]!)
    }
    result = count
    found = true
  }
  const inline = (node: Node): void => {
    if (found) return
    if (node === container) {
      stopAt(node, offset)
      return
    }
    if (node.nodeType === Node.TEXT_NODE) {
      count += (node.nodeValue ?? '').length
      return
    }
    if (node.nodeName === 'BR') {
      if (!isEmptyBr(node)) count += 1
      return
    }
    if (isMarkerEl(node)) return
    for (let i = 0; i < node.childNodes.length && !found; i++) inline(node.childNodes[i]!)
  }
  // Caret anchored on the root element itself: offset is a top-level child index.
  if (container === root) {
    for (let i = 0; i < offset && i < root.childNodes.length; i++) {
      const top = root.childNodes[i]!
      if (isParaBlock(top)) {
        if (paraStarted) count += 1
        paraStarted = true
      } else {
        paraStarted = true
      }
      count += countInline(top)
    }
    return count
  }
  for (let i = 0; i < root.childNodes.length && !found; i++) {
    const top = root.childNodes[i]!
    if (isParaBlock(top)) {
      if (paraStarted) count += 1
      paraStarted = true
      if (top === container) {
        stopAt(top, offset)
        break
      }
      for (let j = 0; j < top.childNodes.length && !found; j++) inline(top.childNodes[j]!)
    } else {
      paraStarted = true
      inline(top)
    }
  }
  return found ? result : count
}

/** Place caret at `local` chars into a paragraph block's inline content. */
function placeInParagraph(block: Node, local: number): { node: Node; offset: number } | null {
  let remaining = local
  let result: { node: Node; offset: number } | null = null
  const walk = (node: Node): boolean => {
    if (result !== null) return true
    if (node.nodeType === Node.TEXT_NODE) {
      const len = (node.nodeValue ?? '').length
      if (remaining <= len) {
        result = { node, offset: remaining }
        return true
      }
      remaining -= len
      return false
    }
    if (node.nodeName === 'BR') {
      if (isEmptyBr(node)) return false
      if (remaining === 0) {
        const parent = node.parentNode
        if (parent !== null) {
          result = { node: parent, offset: Array.prototype.indexOf.call(parent.childNodes, node) }
          return true
        }
      }
      remaining -= 1
      return false
    }
    if (isMarkerEl(node)) return false
    for (let i = 0; i < node.childNodes.length; i++) if (walk(node.childNodes[i]!)) return true
    return false
  }
  for (let i = 0; i < block.childNodes.length; i++) if (walk(block.childNodes[i]!)) break
  if (result === null) {
    // End of paragraph (or empty paragraph): caret after the last child.
    result = { node: block, offset: block.childNodes.length }
  }
  return result
}

/**
 * Convert an editable-string char index back to a DOM (node, offset) pair
 * so we can restore the caret after an innerHTML rebuild.
 */
export function charIndexToDomPosition(root: Node, index: number): { node: Node; offset: number } {
  const paras: Node[] = []
  for (let i = 0; i < root.childNodes.length; i++) {
    if (isParaBlock(root.childNodes[i]!)) paras.push(root.childNodes[i]!)
  }
  if (paras.length === 0) {
    const pos = placeInParagraph(root, index)
    return pos ?? { node: root, offset: root.childNodes.length }
  }
  let start = 0
  for (let p = 0; p < paras.length; p++) {
    const len = countInline(paras[p]!)
    if (index <= start + len) {
      const pos = placeInParagraph(paras[p]!, index - start)
      if (pos !== null) return pos
    }
    start += len + 1 // paragraph chars + its U+2029 separator
  }
  const last = paras[paras.length - 1]!
  return { node: last, offset: last.childNodes.length }
}
