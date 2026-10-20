/**
 * renderer/playTransition.ts
 *
 * Slide transition orchestrator used by present mode.
 *
 * SceneGraph renders a single "active" slide. To run a transition both the
 * outgoing and the incoming slide are on stage at once:
 *
 *   1. `outgoing` = SceneGraph's current root (already on screen).
 *   2. `incoming` = a slide scene prepared off stage (renderer/presentSlides.ts):
 *      every object mounted, every picture uploaded, every text rasterised —
 *      nothing is mounted at click time. Its root is added to the stage as a
 *      sibling of `outgoing`.
 *   3. `compileSlideTransition()` from `@narrative/animation` animates them via
 *      a GSAP timeline — proxy pattern for Pixi targets, no direct mutation.
 *   4. On completion, `sceneGraph.swapSlideScene()` makes the incoming scene
 *      the scene graph's own and hands the outgoing one back intact
 *      (`onSwapped`), for the slide cache to keep or destroy. No flash: nothing
 *      re-mounts, and the frame that draws the swap draws what the last frame
 *      of the transition showed.
 *
 * Magic Move (`transition.kind === 'magic'`): in addition to the root-level
 * crossfade, pair up the outgoing and incoming Containers by object name or id
 * and pass them as `magicPairs` so the transition can morph each matched object
 * from its outgoing transform to its incoming transform.
 */

import type { SlideTransition } from '@narrative/shared'
import {
  compileSlideTransition,
  type CompiledTransition,
  type MagicMoveObjectPair,
} from '@narrative/animation'
import type { Container } from 'pixi.js'
import { SLIDE_WIDTH, SLIDE_HEIGHT } from './constants.js'
import type { SceneGraph, SlideScene } from './SceneGraph.js'
import { getDefaultRenderScheduler } from './RenderScheduler.js'

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface PlayTransitionArgs {
  sceneGraph: SceneGraph
  /** The incoming slide, prepared off stage and not on the stage yet. */
  incoming: SlideScene
  /** Transition config — kind, durationMs, direction. */
  transition: SlideTransition
  /**
   * The transition ended and the scene graph shows `incoming` now; `outgoing`
   * is the scene it took off the stage (SceneGraph.swapSlideScene).
   */
  onSwapped?: (outgoing: SlideScene) => void
}

export interface PlayTransitionResult {
  /**
   * Stop before the end: the incoming scene comes off the stage untouched
   * otherwise (returned, for the caller to keep — its containers may be
   * mid-tween), the outgoing root gets its transform back, nothing is swapped.
   * Null once the transition has ended (or was aborted already).
   */
  abort(): SlideScene | null
  /** Resolves when the timeline ends and the swap has run, or right after an abort. */
  done: Promise<void>
}

/**
 * Start a slide transition. Returns immediately with a handle; the animation
 * and the swap happen asynchronously.
 *
 * While the transition runs the SceneGraph's root is still the OUTGOING slide —
 * any Y.Doc mutation applied through SceneGraph in that window targets the
 * outgoing slide's nodes. Present mode doesn't edit, so that's a non-issue.
 */
export function playTransition(args: PlayTransitionArgs): PlayTransitionResult {
  const { sceneGraph, incoming, transition, onSwapped } = args

  const outgoingRoot = sceneGraph.getRoot()
  const app = sceneGraph.getApp()

  // Snapshot the outgoing root's baseline transform BEFORE the timeline mutates
  // it. The transition tweens this root (slide/push/fade/zoom all animate
  // position / scale / rotation / alpha), and on abort the OUTGOING root stays
  // as the SceneGraph root — so without restoring this baseline a mid-flight
  // abort (spam arrow keys) leaves the surviving slide frozen offset/dimmed. We
  // restore to the captured values, NOT to identity, because the slide root
  // carries a legitimate viewport-fit transform that identity would clobber.
  const outgoingBaseline = {
    x: outgoingRoot.x,
    y: outgoingRoot.y,
    scaleX: outgoingRoot.scale.x,
    scaleY: outgoingRoot.scale.y,
    rotation: outgoingRoot.rotation,
    alpha: outgoingRoot.alpha,
    pivotX: outgoingRoot.pivot.x,
    pivotY: outgoingRoot.pivot.y,
  }

  const incomingRoot: Container = incoming.root
  const incomingNodes = incoming.nodes

  // Magic Move pairing — first match by author-supplied `name` (so users
  // can deliberately bridge two objects across slides without sharing a
  // nanoid), then fall back to obj.id (so pasted / duplicated objects
  // still pair when no explicit name was set).
  let magicPairs: MagicMoveObjectPair[] | undefined
  if (transition.kind === 'magic') {
    magicPairs = []
    // Build a name-keyed lookup of outgoing objects so each incoming can
    // resolve its pair in O(1).
    const outgoingByName = new Map<string, { id: string; container: Container }>()
    const outgoingIds = sceneGraph.getMountedIds()
    for (const id of outgoingIds) {
      const node = sceneGraph.getNode(id)
      if (node === undefined) continue
      const name =
        typeof node.data.name === 'string' && node.data.name !== '' ? node.data.name : null
      if (name === null) continue
      outgoingByName.set(name, { id, container: node.container })
    }
    for (const node of incomingNodes) {
      const incomingName =
        typeof node.data.name === 'string' && node.data.name !== '' ? node.data.name : null
      if (incomingName !== null) {
        const byName = outgoingByName.get(incomingName)
        if (byName !== undefined) {
          magicPairs.push({
            id: incomingName,
            outgoing: byName.container as unknown as MagicMoveObjectPair['outgoing'],
            incoming: node.container as unknown as MagicMoveObjectPair['incoming'],
          })
          continue
        }
      }
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

  // A Magic Move fades the outgoing slide's objects themselves (matched ones
  // hand over to their incoming twin, unmatched ones fade out): their alphas,
  // to give them back on an abort, which leaves the outgoing slide on stage.
  const outgoingAlpha = new Map<Container, number>()
  if (magicPairs !== undefined)
    for (const id of sceneGraph.getMountedIds()) {
      const c = sceneGraph.getContainer(id)
      if (c !== undefined) outgoingAlpha.set(c, c.alpha)
    }

  // Parent incoming on the same stage so it renders concurrently with outgoing.
  app.stage.addChild(incomingRoot)

  let aborted = false
  let ended = false
  let compiled: CompiledTransition | undefined

  let resolveDone: () => void = () => undefined
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve
    try {
      compiled = compileSlideTransition(
        {
          outgoing: outgoingRoot as unknown as MagicMoveObjectPair['outgoing'],
          incoming: incomingRoot as unknown as MagicMoveObjectPair['incoming'],
          slideSize: { width: SLIDE_WIDTH, height: SLIDE_HEIGHT },
          ...(magicPairs !== undefined ? { magicPairs } : {}),
        },
        transition,
      )
    } catch (err) {
      console.error('[playTransition] compileSlideTransition threw', err)
      // No animation: show the incoming slide at once.
      ended = true
      onSwapped?.(sceneGraph.swapSlideScene(incoming))
      resolve()
      return
    }

    const { timeline, dispose } = compiled

    // P12b: with autoStart:false, GSAP-driven property changes don't
    // reach the screen unless someone calls renderer.render(). Hook the
    // timeline's per-frame onUpdate to the render scheduler.
    {
      const scheduler = getDefaultRenderScheduler()
      if (scheduler !== null) {
        timeline.eventCallback('onUpdate', () => scheduler.markDirty())
      }
    }

    timeline.eventCallback('onComplete', () => {
      dispose()
      if (aborted) {
        resolve()
        return
      }
      ended = true
      // The incoming scene becomes the scene graph's own; the outgoing one
      // comes back intact for the caller (the slide cache) to keep or destroy.
      onSwapped?.(sceneGraph.swapSlideScene(incoming))
      resolve()
    })

    try {
      timeline.play()
    } catch (err) {
      console.error('[playTransition] timeline.play threw', err)
      dispose()
      ended = true
      onSwapped?.(sceneGraph.swapSlideScene(incoming))
      resolve()
    }
  })

  return {
    abort(): SlideScene | null {
      if (aborted || ended) return null
      aborted = true
      // Kill the GSAP timeline so no further onUpdate callbacks fire against
      // either scene.
      if (compiled !== undefined) {
        compiled.timeline.kill()
        compiled.dispose()
      }
      // Restore the outgoing root's pre-transition transform. It survives the
      // abort as the SceneGraph root, so undo the partial tween or it stays
      // frozen mid-transition (offset / scaled / dimmed) on screen.
      if (!outgoingRoot.destroyed) {
        outgoingRoot.position.set(outgoingBaseline.x, outgoingBaseline.y)
        outgoingRoot.scale.set(outgoingBaseline.scaleX, outgoingBaseline.scaleY)
        outgoingRoot.rotation = outgoingBaseline.rotation
        outgoingRoot.alpha = outgoingBaseline.alpha
        outgoingRoot.pivot.set(outgoingBaseline.pivotX, outgoingBaseline.pivotY)
      }
      // A Magic Move faded the outgoing slide's objects: the scene graph's
      // own nodes, shown again now.
      for (const [c, alpha] of outgoingAlpha) if (!c.destroyed) c.alpha = alpha
      getDefaultRenderScheduler()?.markDirty()
      // The incoming scene is the caller's again (its cache restores it).
      if (incomingRoot.parent !== null) incomingRoot.parent.removeChild(incomingRoot)
      resolveDone()
      return incoming
    },
    done,
  }
}
