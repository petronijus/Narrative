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
 *   - <br>                  → one '\n' (soft line break inside a paragraph)
 *   - <span data-marker>    → 0 chars (the glyph is not part of the body)
 *   - a placeholder <br>    → 0 chars (see isPlaceholderBr)
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

/** The block a node's line belongs to: its paragraph, or for bare content the editor (a div). */
function blockOf(n: Node): Node | null {
  let block = n.parentNode
  // Runs are inline elements, never a div or a p.
  while (block !== null && !isParaBlock(block)) block = block.parentNode
  return block
}

/** A block's leaves in order: text nodes with characters, and line breaks (markers left out). */
function leavesOf(block: Node): Node[] {
  const leaves: Node[] = []
  const walk = (node: Node): void => {
    for (let c = node.firstChild; c !== null; c = c.nextSibling) {
      if (c.nodeType === Node.TEXT_NODE) {
        if ((c.nodeValue ?? '') !== '') leaves.push(c)
      } else if (c.nodeName === 'BR') leaves.push(c)
      else if (!isMarkerEl(c)) walk(c)
    }
  }
  walk(block)
  return leaves
}

/**
 * Whether the last leaf of a block, coming after `before`, holds an empty
 * line open rather than breaking one: it is the block's only content, or what
 * comes before it ends in a line break. HTML (and `white-space: pre-wrap`) draws no line
 * after a break that ends its block, so an empty last line takes a second
 * break, which is no character of the body:
 *   - the document's own, `<br data-empty>` (an empty paragraph; the line
 *     after a paragraph's closing soft break — buildListedHtml);
 *   - the browser's, added as it edits: a lone `<br>` (`<u><br></u>` once
 *     every character is deleted), `a<br><br>`, or — the browser's own line
 *     break in pre-wrap text — `a\n\n`. Both engines do it.
 * Counted as characters, Shift+Enter at a paragraph's end sent "\n\n" (a new
 * paragraph) and an emptied box kept a "\n".
 */
function holdsLastLine(before: Node | undefined): boolean {
  if (before === undefined) return true
  if (before.nodeName === 'BR') return true
  return (before.nodeValue ?? '').endsWith('\n')
}

/** A `<br>` that holds a line open (see holdsLastLine): no character of the body. */
export function isPlaceholderBr(n: Node): boolean {
  if (n.nodeName !== 'BR') return false
  if (isEmptyBr(n)) return true
  const block = blockOf(n)
  if (block === null) return false
  const leaves = leavesOf(block)
  return leaves[leaves.length - 1] === n && holdsLastLine(leaves[leaves.length - 2])
}

/**
 * The body characters of a text node: its text, without a closing newline
 * that only holds the block's last line open (see holdsLastLine).
 */
export function textChars(n: Node): string {
  const value = n.nodeValue ?? ''
  if (!value.endsWith('\n')) return value
  // "a\n" breaks a line (nothing holds a line after it); "a\n\n" or a lone
  // "\n" after a break holds the last one open.
  if (value.length >= 2 && value[value.length - 2] !== '\n') return value
  const block = blockOf(n)
  if (block === null) return value
  const leaves = leavesOf(block)
  if (leaves[leaves.length - 1] !== n) return value
  const holds = value.length >= 2 || holdsLastLine(leaves[leaves.length - 2])
  return holds ? value.slice(0, -1) : value
}

/** Count body chars contributed by an inline subtree (markers/empty skipped). */
export function countInline(node: Node): number {
  if (node.nodeType === Node.TEXT_NODE) return textChars(node).length
  if (node.nodeName === 'BR') return isPlaceholderBr(node) ? 0 : 1
  if (isMarkerEl(node)) return 0
  let n = 0
  for (let i = 0; i < node.childNodes.length; i++) n += countInline(node.childNodes[i]!)
  return n
}

/**
 * Whether the editor's DOM is exactly the markup `html` builds (elements,
 * attributes and text; adjacent and empty text nodes do not count). The
 * overlay's look is its markup: every run's formatting is an element of its
 * own (`<u>`, `<i>`, a styled span), the root carries nothing the runs could
 * not take back (an underline on the root would draw a second line under
 * every `<u>` and could not be removed from a plain run). So where the
 * browser put typed text outside the run the document gave it — into an
 * empty paragraph, over a selection it replaced with a bare text node —
 * the editor shows less than the canvas would, and this says so.
 */
export function domShowsHtml(el: HTMLElement, html: string): boolean {
  const want = el.ownerDocument.createElement('template')
  want.innerHTML = html
  want.content.normalize()
  const live = el.cloneNode(true)
  live.normalize()
  const a = live.childNodes
  const b = want.content.childNodes
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (!a[i]!.isEqualNode(b[i]!)) return false
  return true
}

/** Reconstruct the editable-string body from the contenteditable DOM. */
export function getElementInnerText(el: HTMLElement): string {
  let out = ''
  let paraStarted = false
  const inline = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      out += textChars(node)
      return
    }
    if (node.nodeName === 'BR') {
      if (!isPlaceholderBr(node)) out += '\n'
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
      count += Math.min(off, textChars(node).length)
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
      count += textChars(node).length
      return
    }
    if (node.nodeName === 'BR') {
      if (!isPlaceholderBr(node)) count += 1
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
      const len = textChars(node).length
      if (remaining <= len) {
        result = { node, offset: remaining }
        return true
      }
      remaining -= len
      return false
    }
    if (node.nodeName === 'BR') {
      if (isPlaceholderBr(node)) {
        // The caret on a placeholder's line sits before it (where the
        // browser puts it), not after the block's last child.
        if (remaining !== 0) return false
        const parent = node.parentNode
        if (parent === null) return false
        result = { node: parent, offset: Array.prototype.indexOf.call(parent.childNodes, node) }
        return true
      }
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
