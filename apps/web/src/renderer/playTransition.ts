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
import type { SlideBackground, SlideObject, SlideTransition } from '@narrative/shared'
import {
  compileSlideTransition,
  type CompiledTransition,
  type MagicMoveObjectPair,
} from '@narrative/animation'
import { getRenderer } from './objectRenderers/index.js'
import { SLIDE_WIDTH, SLIDE_HEIGHT } from './constants.js'
import type { SceneGraph } from './SceneGraph.js'
import { getDefaultRenderScheduler } from './RenderScheduler.js'
import { applyBackground } from './ArtboardBackground.js'
import { getDefaultImageUrlResolver } from './imageUrl.js'
import { getDefaultResourceManager } from './ResourceManager.js'

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface PlayTransitionArgs {
  sceneGraph: SceneGraph
  /** Parsed objects of the incoming slide (plain snapshot from Y.Doc). */
  incomingObjects: SlideObject[]
  /** Transition config — kind, durationMs, direction. */
  transition: SlideTransition
  /**
   * Incoming slide's artboard background. When set, the transition
   * paints it onto a dedicated container inside `incomingRoot` so the
   * GSAP timeline animates it together with the slide's objects. Without
   * this, the OLD slide's background container (which still sits as
   * child 0 of the outgoing root) stays visible until adoptSlideRoot
   * runs at `onComplete` — causing a noticeable "background snaps,
   * objects faded" desync.
   *
   * Undefined means "no incoming background to paint" — the post-
   * adoption `applyBackground` call in Canvas.tsx will populate the
   * fresh SceneGraph.backgroundContainer in that case.
   */
  incomingBackground?: SlideBackground
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
  const { sceneGraph, incomingObjects, transition, incomingBackground } = args

  const outgoingRoot = sceneGraph.getRoot()
  const app = sceneGraph.getApp()

  // Snapshot the outgoing root's baseline transform BEFORE the timeline mutates
  // it. The transition tweens this root (slide/push/fade/zoom all animate
  // position / scale / rotation / alpha), and on abort the incoming root is
  // destroyed while the OUTGOING root stays as the SceneGraph root — so without
  // restoring this baseline a mid-flight abort (spam arrow keys) leaves the
  // surviving slide frozen offset/dimmed. We restore to the captured values,
  // NOT to identity, because the slide root carries a legitimate viewport-fit
  // transform that identity would clobber.
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

  // Build the incoming root off-stage, mount each slide object via the
  // registered renderer (same code path SceneGraph.addObject uses).
  const incomingRoot = new Container()

  // Background goes in FIRST so it sits at child index 0 — same z-order
  // convention as SceneGraph.ensureBackgroundContainer for the outgoing
  // root. The GSAP timeline animates incomingRoot as a whole, so the
  // background fades / slides / morphs in lock-step with the objects.
  // Without this, the new slide's background only appears at
  // onComplete (after adoptSlideRoot runs Canvas's applyBackground
  // effect), producing the "background lags the transition" symptom.
  let incomingBgContainer: Container | undefined
  if (incomingBackground !== undefined) {
    incomingBgContainer = new Container()
    incomingBgContainer.eventMode = 'none'
    incomingRoot.addChild(incomingBgContainer)
    const resolver = (() => {
      try {
        return getDefaultImageUrlResolver()
      } catch {
        return null
      }
    })()
    const rm = (() => {
      try {
        return getDefaultResourceManager()
      } catch {
        return null
      }
    })()
    void applyBackground({
      container: incomingBgContainer,
      background: incomingBackground,
      width: SLIDE_WIDTH,
      height: SLIDE_HEIGHT,
      ...(resolver !== null
        ? { resolveAssetUrl: (assetId) => resolver({ assetId, variant: 'display' }) }
        : {}),
      ...(rm !== null
        ? {
            acquireTexture: (url) => rm.acquireTexture(url),
            releaseTexture: (url) => rm.releaseTexture(url),
          }
        : {}),
    })
  }

  const incomingNodes: Array<{ id: string; container: Container; data: SlideObject }> = []
  for (const obj of incomingObjects) {
    const renderer = getRenderer(obj.type)
    if (renderer === undefined) continue
    const container = renderer.mount(obj)
    incomingRoot.addChild(container)
    incomingNodes.push({ id: obj.id, container, data: obj })
  }

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

  // Parent incoming on the same stage so it renders concurrently with outgoing.
  app.stage.addChild(incomingRoot)

  let aborted = false
  let compiled: CompiledTransition | undefined

  const done = new Promise<void>((resolve) => {
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
      // Adopt incoming as the new SceneGraph root. Destroys outgoing root +
      // children, clears node bookkeeping, installs incoming + its node map.
      // Pass the bgContainer we built so SceneGraph rebinds to it instead
      // of nulling — that keeps subsequent Canvas applyBackground calls
      // (when the slide-change effect re-runs) operating on the already-
      // painted, transition-survived container.
      sceneGraph.adoptSlideRoot(incomingRoot, incomingNodes, incomingBgContainer)
      resolve()
    })

    try {
      timeline.play()
    } catch (err) {
      console.error('[playTransition] timeline.play threw', err)
      dispose()
      resolve()
    }
  })

  return {
    abort(): void {
      if (aborted) return
      aborted = true
      // Kill the GSAP timeline so no further onUpdate callbacks fire against
      // the outgoing scene — the caller is about to swap activeSlideId and
      // the reconciler will destroy the containers we were tweening.
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
        getDefaultRenderScheduler()?.markDirty()
      }
      // P12g: route every incoming node through its renderer's
      // destroy hook BEFORE destroying the root. A bare
      // `incomingRoot.destroy({ children: true })` bypasses
      // renderer-side cleanup — most importantly,
      // videoRenderer.destroy()'s `stopPolling()` and texture release.
      // Without this, every aborted transition with a pending video
      // poster left a 5 s setInterval timer firing against a destroyed
      // container.
      for (const node of incomingNodes) {
        const renderer = getRenderer(node.data.type)
        if (renderer !== undefined && !node.container.destroyed) {
          try {
            renderer.destroy(node.container)
          } catch (err) {
            console.error('[playTransition] renderer.destroy threw on abort', err)
          }
        }
      }
      if (!incomingRoot.destroyed) {
        incomingRoot.destroy({ children: true })
      }
    },
    done,
  }
}
