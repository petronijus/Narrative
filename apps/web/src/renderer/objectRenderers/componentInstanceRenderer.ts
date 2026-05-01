/**
 * renderer/objectRenderers/componentInstanceRenderer.ts
 *
 * M16 P5 — Placeholder renderer for ComponentInstanceObject.
 *
 * P5 renders a visually distinct placeholder: a rounded outlined rect with
 * a ⌘ badge and the component name label centered inside. The placeholder is
 * sized from the instance's stored width/height (bounding box of the original
 * promoted selection). Selection, move, and scale work the same as for any
 * other single-object type because SceneGraph treats the container as a leaf.
 *
 * P6 will replace this renderer with a full master-doc expansion that subscribes
 * to the `component:<id>` Y.Doc and renders the subtree in-place. For now the
 * instance is an opaque canvas node that is clearly recognisable to the author.
 *
 * Design decisions:
 * - Uses Pixi Graphics for the rect + Pixi Text for the label (no HTMLText —
 *   avoids DOM overlay complexity for a placeholder).
 * - Colors are hard-coded neutrals (not design tokens) because the placeholder
 *   is an editor metaphor, not author content.
 * - Pivot at center so transform handles and rotation match every other renderer.
 *
 * TODO(P6) — replace with master-doc expansion renderer.
 */

import { Container, Graphics, Text, TextStyle } from 'pixi.js'
import type { ComponentInstanceObject } from '@narrative/shared'
import type { ObjectRenderer } from './index.js'

// ---------------------------------------------------------------------------
// Symbol-keyed slots — avoid property collision on untyped Container
// ---------------------------------------------------------------------------

const GRAPHICS_TAG = Symbol('compInstGraphics')
const LABEL_TAG = Symbol('compInstLabel')
const DATA_TAG = Symbol('compInstData')

// `Container` from Pixi v8 has no public typing for arbitrary symbol-keyed
// slots, so we widen to `any` for the symbol-key access pattern. Sticking
// the slots on the node directly (rather than a side Map) means GC is
// automatic when the node is destroyed by the reconciler.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const asAny = (node: Container): any => node as any

function getGraphics(node: Container): Graphics | undefined {
  return asAny(node)[GRAPHICS_TAG] as Graphics | undefined
}

function getLabel(node: Container): Text | undefined {
  return asAny(node)[LABEL_TAG] as Text | undefined
}

function getCachedData(node: Container): ComponentInstanceObject | undefined {
  return asAny(node)[DATA_TAG] as ComponentInstanceObject | undefined
}

function setCachedData(node: Container, data: ComponentInstanceObject): void {
  asAny(node)[DATA_TAG] = data
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

/** Corner radius for the placeholder rect (editor aesthetic). */
const CORNER_R = 8
/** Border color — indigo-ish to signal "component" without clashing with selection blue. */
const BORDER_COLOR = 0x6366f1
/** Border alpha */
const BORDER_ALPHA = 0.7
/** Background fill — very faint tint */
const FILL_COLOR = 0x6366f1
const FILL_ALPHA = 0.06
/** Stroke width */
const STROKE_W = 1.5

function drawPlaceholder(graphics: Graphics, label: Text, data: ComponentInstanceObject): void {
  const { width, height } = data

  graphics.clear()
  // Background fill
  graphics.roundRect(0, 0, width, height, CORNER_R)
  graphics.fill({ color: FILL_COLOR, alpha: FILL_ALPHA })
  // Border
  graphics.roundRect(0, 0, width, height, CORNER_R)
  graphics.stroke({ color: BORDER_COLOR, width: STROKE_W, alpha: BORDER_ALPHA })

  // ⌘ badge in top-left corner
  const BADGE_SIZE = 14
  const BADGE_PAD = 6
  graphics.roundRect(BADGE_PAD, BADGE_PAD, BADGE_SIZE, BADGE_SIZE, 3)
  graphics.fill({ color: BORDER_COLOR, alpha: 0.15 })
  graphics.roundRect(BADGE_PAD, BADGE_PAD, BADGE_SIZE, BADGE_SIZE, 3)
  graphics.stroke({ color: BORDER_COLOR, width: 1, alpha: 0.5 })

  // Update label text
  const maxLabelWidth = Math.max(width - 20, 40)
  const displayName =
    data.componentName != null && data.componentName.length > 0 ? data.componentName : 'Component'
  label.text = `⌘ ${displayName}`
  label.style.wordWrapWidth = maxLabelWidth
  // Center the label
  label.x = width / 2
  label.y = height / 2
}

function makeLabelStyle(): TextStyle {
  return new TextStyle({
    fontFamily: 'system-ui, -apple-system, sans-serif',
    fontSize: 11,
    fill: BORDER_COLOR,
    align: 'center',
    wordWrap: true,
    wordWrapWidth: 200,
    breakWords: true,
    // Note: Pixi v8 TextStyle does not have an `alpha` field — set alpha on
    // the Text container itself after mount instead.
  })
}

// ---------------------------------------------------------------------------
// Transform
// ---------------------------------------------------------------------------

function applyTransform(container: Container, data: ComponentInstanceObject): void {
  container.rotation = data.rotation
  container.alpha = data.opacity
  container.pivot.set(data.width / 2, data.height / 2)
  container.x = data.x + data.width / 2
  container.y = data.y + data.height / 2
}

// ---------------------------------------------------------------------------
// Renderer implementation
// ---------------------------------------------------------------------------

export const componentInstanceRenderer: ObjectRenderer<ComponentInstanceObject> = {
  type: 'componentInstance' as const,

  mount(data: ComponentInstanceObject): Container {
    const container = new Container()
    const graphics = new Graphics()
    const label = new Text({ style: makeLabelStyle() })
    label.anchor.set(0.5, 0.5)
    // Pixi v8 TextStyle has no alpha field — set on the container
    label.alpha = 0.85

    asAny(container)[GRAPHICS_TAG] = graphics
    asAny(container)[LABEL_TAG] = label
    setCachedData(container, data)

    drawPlaceholder(graphics, label, data)

    container.addChild(graphics)
    container.addChild(label)
    applyTransform(container, data)

    return container
  },

  update(node: Container, _prev: ComponentInstanceObject, next: ComponentInstanceObject): void {
    const graphics = getGraphics(node)
    const label = getLabel(node)
    if (graphics !== undefined && label !== undefined) {
      setCachedData(node, next)
      drawPlaceholder(graphics, label, next)
    }
    applyTransform(node, next)
  },

  applyPatch(node: Container, patch: Partial<ComponentInstanceObject>): void {
    const cached = getCachedData(node)
    if (cached === undefined) return

    const next: ComponentInstanceObject = { ...cached, ...patch }
    setCachedData(node, next)

    const geometryChanged =
      patch.width !== undefined || patch.height !== undefined || 'componentName' in patch

    if (geometryChanged) {
      const graphics = getGraphics(node)
      const label = getLabel(node)
      if (graphics !== undefined && label !== undefined) {
        drawPlaceholder(graphics, label, next)
      }
    }

    if (patch.x !== undefined) node.x = patch.x + node.pivot.x
    if (patch.y !== undefined) node.y = patch.y + node.pivot.y
    if (patch.rotation !== undefined) node.rotation = patch.rotation
    if (patch.opacity !== undefined) node.alpha = patch.opacity

    if (patch.width !== undefined || patch.height !== undefined) {
      const newPivotX = next.width / 2
      const newPivotY = next.height / 2
      const dataX = node.x - node.pivot.x
      const dataY = node.y - node.pivot.y
      node.pivot.set(newPivotX, newPivotY)
      node.x = dataX + newPivotX
      node.y = dataY + newPivotY
    }
  },

  destroy(node: Container): void {
    const graphics = getGraphics(node)
    const label = getLabel(node)
    graphics?.destroy()
    label?.destroy()
    node.destroy()
  },
}
