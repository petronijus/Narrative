/**
 * state/writeComponentMasterTree.ts
 *
 * One-shot helper that opens a Hocuspocus connection to a freshly
 * created `component:<id>` doc, writes the promoted master subtree +
 * animations into it on first sync, then tears the connection down.
 *
 * Used by the Promote-to-Component flow so the master Y.Doc is never
 * left empty after a successful promotion (silent data loss).
 *
 * The component doc layout mirrors a one-slide deck: a `slides`
 * Y.Array with a single Y.Map carrying `objects` (Y.Array<Y.Map>) and
 * `animations` (Y.Array<Y.Map>). Keeping the same shape lets the P6
 * editor reuse deck object/animation infrastructure unchanged.
 */

import * as Y from 'yjs'
import { HocuspocusProvider } from '@hocuspocus/provider'
import type { SlideObject, AnimationStep } from '@narrative/shared'

const HOCUSPOCUS_URL = import.meta.env['VITE_HOCUSPOCUS_URL'] ?? 'ws://localhost:3002'

interface WriteArgs {
  componentId: string
  masterTree: SlideObject[]
  masterAnimations: AnimationStep[]
  token: string | null
  /** How long to wait for the first sync before bailing. */
  timeoutMs?: number
}

export async function writeComponentMasterTree({
  componentId,
  masterTree,
  masterAnimations,
  token,
  timeoutMs = 10_000,
}: WriteArgs): Promise<void> {
  const doc = new Y.Doc()
  const provider = new HocuspocusProvider({
    url: HOCUSPOCUS_URL,
    name: `component:${componentId}`,
    document: doc,
    ...(token !== null ? { token } : { token: null }),
    connect: true,
  })

  try {
    await new Promise<void>((resolve, reject) => {
      const t = window.setTimeout(() => {
        reject(new Error('writeComponentMasterTree: timed out waiting for sync'))
      }, timeoutMs)

      const onSynced = () => {
        window.clearTimeout(t)
        provider.off('synced', onSynced)
        resolve()
      }
      provider.on('synced', onSynced)
    })

    // Build the canonical "slide-shaped" tree the deck format expects.
    doc.transact(() => {
      const slides = doc.getArray<Y.Map<unknown>>('slides')

      // Idempotency: if a previous run already wrote here, bail. Hocuspocus
      // delivers the persisted state on synced — we should NEVER clobber it.
      if (slides.length > 0) return

      const slide = new Y.Map<unknown>()
      slide.set('id', 'master')
      slide.set('order', 0)

      const objects = new Y.Array<Y.Map<unknown>>()
      for (const obj of masterTree) {
        objects.push([plainObjectToYMap(obj)])
      }
      slide.set('objects', objects)

      const animations = new Y.Array<Y.Map<unknown>>()
      for (const step of masterAnimations) {
        animations.push([plainObjectToYMap(step as unknown as Record<string, unknown>)])
      }
      slide.set('animations', animations)

      slides.push([slide])
    })

    // Force a flush to the server before we tear down the connection.
    // HocuspocusProvider drains its outbox on destroy; we still wait one
    // tick so the websocket has a chance to ship the update frame.
    await new Promise((resolve) => window.setTimeout(resolve, 50))
  } finally {
    provider.destroy()
    doc.destroy()
  }
}

/**
 * Recursive plain → Y.Map / Y.Array conversion. SlideObjects use plain
 * arrays for things like gradient stops or path points, so we walk the
 * object tree converting nested arrays / objects into their Yjs
 * counterparts.
 *
 * Strings, numbers, booleans, null pass through. Y.Text is restored
 * from a plain string via `Y.Text(s)` — only relevant for `text`
 * objects whose body was serialized to a string in `promoteToComponent`.
 */
function plainObjectToYMap(input: Record<string, unknown> | unknown): Y.Map<unknown> {
  const map = new Y.Map<unknown>()
  if (input === null || typeof input !== 'object') return map
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    map.set(k, plainToYValue(k, v))
  }
  return map
}

function plainToYValue(key: string, v: unknown): unknown {
  if (v === null) return null
  if (typeof v !== 'object') return v
  if (Array.isArray(v)) {
    const arr = new Y.Array<unknown>()
    for (const item of v) {
      arr.push([plainToYValue(key, item)])
    }
    return arr
  }
  // Restore Y.Text for text-object bodies so the deck-style renderer
  // can subscribe to character-level changes later. Detection is
  // heuristic: the field is named `text` and the value is a string.
  if (key === 'text' && typeof v === 'string') {
    return new Y.Text(v)
  }
  // Plain object → nested Y.Map.
  return plainObjectToYMap(v as Record<string, unknown>)
}
