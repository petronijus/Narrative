/**
 * renderer/playTransition.ts
 *
 * Slide transition orchestrator used by present mode.
 *
 * Today SceneGraph renders a single "active" slide. To run a transition we
 * need BOTH the outgoing and incoming slide painted on stage simultaneously:
 *
 *   1. `outgoing` = SceneGraph's current root (already on screen, holds the
 *      outgoing slide's per-object Containers).
 *   2. `incoming` = a fresh Container we build here by mounting each of the
 *      incoming slide's objects via the renderer registry. Added to the stage
 *      as a sibling of `outgoing`.
 *   3. `runSlideTransition()` from `@narrative/animation` animates them via
 *      GSAP timeline — proxy pattern for Pixi targets, no direct mutation.
 *   4. On completion, `sceneGraph.adoptSlideRoot()` hands the incoming root
 *      over to SceneGraph — the outgoing root + its children are destroyed,
 *      and SceneGraph's internal bookkeeping is rewired to match the new
 *      on-stage content. No flash because nothing re-mounts.
 *
 * Magic Move (`transition.kind === 'magic'`): in addition to the root-level
 * crossfade, pair up the outgoing and incoming Containers by object id and
 * pass them as `magicPairs` so the transition can morph each matched object
 * from its outgoing transform to its incoming transform.
 */

import { Container } from 'pixi.js'
import type { SlideObject, SlideTransition } from '@narrative/shared'
import { runSlideTransition, type MagicMoveObjectPair } from '@narrative/animation'
import { getRenderer } from './objectRenderers/index.js'
import { SLIDE_WIDTH, SLIDE_HEIGHT } from './constants.js'
import type { SceneGraph } from './SceneGraph.js'

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface PlayTransitionArgs {
  sceneGraph: SceneGraph
  /** Parsed objects of the incoming slide (plain snapshot from Y.Doc). */
  incomingObjects: SlideObject[]
  /** Transition config — kind, durationMs, direction. */
  transition: SlideTransition
}

export interface PlayTransitionResult {
  /** Destroys the incoming root if the caller aborts mid-transition. */
  abort(): void
  /** Resolves when the GSAP timeline finishes and the adoption step runs. */
  done: Promise<void>
}

/**
 * Start a slide transition. Returns immediately with a handle; the actual
 * animation + adoption happens async inside `done`.
 *
 * Caller is expected to gate UI interactions on `done`; while the transition
 * is running the SceneGraph's root reference is still the OUTGOING slide —
 * any Y.Doc mutation applied through SceneGraph in that window targets the
 * outgoing slide's nodes. Present mode doesn't edit, so that's a non-issue.
 */
export function playTransition(args: PlayTransitionArgs): PlayTransitionResult {
  const { sceneGraph, incomingObjects, transition } = args

  const outgoingRoot = sceneGraph.getRoot()
  const app = sceneGraph.getApp()

  // Build the incoming root off-stage, mount each slide object via the
  // registered renderer (same code path SceneGraph.addObject uses).
  const incomingRoot = new Container()
  const incomingNodes: Array<{ id: string; container: Container; data: SlideObject }> = []
  for (const obj of incomingObjects) {
    const renderer = getRenderer(obj.type)
    if (renderer === undefined) continue
    const container = renderer.mount(obj)
    incomingRoot.addChild(container)
    incomingNodes.push({ id: obj.id, container, data: obj })
  }

  // Magic Move pairing: match by id across outgoing + incoming.
  let magicPairs: MagicMoveObjectPair[] | undefined
  if (transition.kind === 'magic') {
    magicPairs = []
    for (const node of incomingNodes) {
      const outgoing = sceneGraph.getContainer(node.id)
      if (outgoing !== undefined) {
        magicPairs.push({
          id: node.id,
          outgoing: outgoing as unknown as MagicMoveObjectPair['outgoing'],
          incoming: node.container as unknown as MagicMoveObjectPair['incoming'],
        })
      }
    }
  }

  // Parent incoming on the same stage so it renders concurrently with outgoing.
  app.stage.addChild(incomingRoot)

  let aborted = false

  const done = (async () => {
    try {
      await runSlideTransition(
        {
          outgoing: outgoingRoot as unknown as MagicMoveObjectPair['outgoing'],
          incoming: incomingRoot as unknown as MagicMoveObjectPair['incoming'],
          slideSize: { width: SLIDE_WIDTH, height: SLIDE_HEIGHT },
          magicPairs,
        },
        transition,
      )
    } catch (err) {
      console.error('[playTransition] runSlideTransition threw', err)
    }

    if (aborted) return

    // Adopt incoming as the new SceneGraph root. Destroys outgoing root +
    // children, clears node bookkeeping, installs incoming + its node map.
    sceneGraph.adoptSlideRoot(incomingRoot, incomingNodes)
  })()

  return {
    abort(): void {
      aborted = true
      if (!incomingRoot.destroyed) {
        incomingRoot.destroy({ children: true })
      }
    },
    done,
  }
}
