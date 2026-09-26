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
 *
 * Objects are written through slide-model's `insertObjectsWithRichText`
 * (the canonical `plainObjectToYMap` binding + delta replay), so the
 * `_richTextOps` deltas `promoteToComponent` puts on text objects and
 * table cells land in the master as real rich text — inline runs and
 * paragraph attributes (lists, levels, bullets) intact.
 */

import * as Y from 'yjs'
import { HocuspocusProvider } from '@hocuspocus/provider'
import type { SlideObject, AnimationStep } from '@narrative/shared'
import { animationStepToYMap, insertObjectsWithRichText } from '@narrative/slide-model'

const HOCUSPOCUS_URL = import.meta.env['VITE_HOCUSPOCUS_URL'] ?? 'ws://localhost:3002'

interface WriteArgs {
  componentId: string
  masterTree: SlideObject[]
  masterAnimations: AnimationStep[]
  /** How long to wait for the first sync before bailing. */
  timeoutMs?: number
}

export async function writeComponentMasterTree({
  componentId,
  masterTree,
  masterAnimations,
  timeoutMs = 10_000,
}: WriteArgs): Promise<void> {
  const doc = new Y.Doc()
  const provider = new HocuspocusProvider({
    url: HOCUSPOCUS_URL,
    name: `component:${componentId}`,
    document: doc,
    // Sentinel triggers HocuspocusProvider's auth-frame; server reads the
    // real session from the `narrative_session` cookie on the WS upgrade.
    // See `docs/adr/0005-server-side-session-cookies.md`.
    token: 'cookie',
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
      const animations = new Y.Array<Y.Map<unknown>>()
      slide.set('objects', objects)
      slide.set('animations', animations)

      // Integrate the slide FIRST: rich-text bodies (text objects and table
      // cells) can only be filled once their Y.Texts live in the doc, so
      // `insertObjectsWithRichText` needs an integrated target array. All of
      // it stays inside this one transaction.
      slides.push([slide])
      insertObjectsWithRichText(objects, masterTree)
      if (masterAnimations.length > 0) animations.push(masterAnimations.map(animationStepToYMap))
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
