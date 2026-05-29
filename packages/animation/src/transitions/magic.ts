/**
 * packages/animation/src/transitions/magic.ts
 *
 * 'magic' slide transition — Keynote-style Magic Move.
 *
 * Objects matched by id across the outgoing and incoming slide morph smoothly
 * from their outgoing transform (position, scale, rotation, alpha) to their
 * incoming transform — giving the impression of a single continuous object.
 *
 * Objects present only in the outgoing slide fade out.
 * Objects present only in the incoming slide fade in.
 * The root-container fallback handles the un-matched set via a crossfade on
 * the `outgoing` + `incoming` root alphas (same mechanic as the 'fade' kind).
 *
 * Matched-pair mechanics:
 *   The runtime pre-pairs matched objects (by id) in `targets.magicPairs`.
 *   For each pair:
 *     1. Snapshot the outgoing container's transform.
 *     2. Make the incoming container's OWN transform invisible (alpha 0) so
 *        only our tween drives its appearance.
 *     3. Tween a proxy from the snapshot to the incoming container's target
 *        transform; onUpdate writes to the incoming container each frame.
 *     4. At the same time fade the outgoing container's own copy to alpha 0
 *        so the two don't double-render mid-tween.
 *
 * Proxy pattern (Spike A): GSAP animates plain proxy objects; onUpdate pushes
 * values to the Pixi container — never gsap.to(pixiContainer, ...).
 *
 * durationMs === 0 → immediate settle, no tween (API uniformity).
 */

import { gsap } from 'gsap'
import type {
  SlideTransitionTargets,
  CompiledTransition,
  PixiContainer,
  MagicMoveObjectPair,
} from './types.js'
import { makeContainerProxy } from './types.js'
import type { SlideTransition } from '@narrative/shared'

// ---------------------------------------------------------------------------
// Per-object transform snapshot (read of the current Pixi container state).
// ---------------------------------------------------------------------------

interface TransformSnapshot {
  x: number
  y: number
  scaleX: number
  scaleY: number
  alpha: number
  rotation: number
  /** Apparent width (= geometry × scale). Used by Magic Move to morph objects
   *  whose renderers change size via geometry rather than container.scale. */
  width: number
  height: number
}

function snapshotTransform(c: PixiContainer): TransformSnapshot {
  // The minimal structural PixiContainer type doesn't expose readable x/y;
  // downcast to record access for snapshotting real Pixi Containers. Tests
  // pass mocks that either match this shape or supply explicit values.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- structural mock access
  const anyC = c as any
  return {
    x: Number(anyC.x ?? 0),
    y: Number(anyC.y ?? 0),
    scaleX: Number(anyC.scale?.x ?? 1),
    scaleY: Number(anyC.scale?.y ?? 1),
    alpha: Number(anyC.alpha ?? 1),
    rotation: Number(anyC.rotation ?? 0),
    width: Number(anyC.width ?? 0),
    height: Number(anyC.height ?? 0),
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function magicTransition(
  targets: SlideTransitionTargets,
  transition: SlideTransition,
): CompiledTransition {
  const { outgoing, incoming } = targets
  const pairs: MagicMoveObjectPair[] = targets.magicPairs ?? []
  const durationSec = transition.durationMs / 1000

  // Start both root containers at origin / unit scale — Magic Move operates on
  // per-object transforms relative to the root, not on the root itself.
  outgoing.position.set(0, 0)
  incoming.position.set(0, 0)
  outgoing.scale.set(1, 1)
  incoming.scale.set(1, 1)

  const tl = gsap.timeline({ paused: true })

  // Immediate settle — no tween. Snap to the incoming state, drop outgoing.
  if (transition.durationMs <= 0) {
    outgoing.alpha = 0
    incoming.alpha = 1
    // Zero-duration tween so the shared runSlideTransition() API resolves
    // via onComplete on the next microtask.
    const sentinel = { _: 0 }
    tl.to(sentinel, { _: 1, duration: 0 })
    return { timeline: tl, dispose: () => tl.kill() }
  }

  // ---- Un-matched objects: per-child fade ----
  //
  // An earlier implementation crossfaded the ROOT containers (outgoing 1→0,
  // incoming 0→1) so unmatched children would inherit the fade. That was a
  // bug for Magic Move: a child's rendered alpha is root.alpha × child.alpha,
  // so matched-pair children — whose own alpha tween targets a constant
  // ~1 — would still visually fade in/out along with the root. Result:
  // objects faded away AND THEN morphed, instead of morphing directly.
  //
  // Fix: keep both roots at alpha 1 throughout. Fade individual *unmatched*
  // children directly. Matched children are driven solely by the per-pair
  // morph tween below.
  outgoing.alpha = 1
  incoming.alpha = 1

  const pairedOutgoing = new Set<PixiContainer>(pairs.map((p) => p.outgoing))
  const pairedIncoming = new Set<PixiContainer>(pairs.map((p) => p.incoming))

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- structural Pixi children access
  const outChildren: PixiContainer[] = ((outgoing as any).children ?? []) as PixiContainer[]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- structural Pixi children access
  const inChildren: PixiContainer[] = ((incoming as any).children ?? []) as PixiContainer[]

  for (const child of outChildren) {
    if (pairedOutgoing.has(child)) continue
    const snap = snapshotTransform(child)
    const { proxy, applyProxy } = makeContainerProxy(child, {
      x: snap.x,
      y: snap.y,
      scaleX: snap.scaleX,
      scaleY: snap.scaleY,
      alpha: snap.alpha,
    })
    tl.to(proxy, { alpha: 0, duration: durationSec, ease: 'power2.inOut', onUpdate: applyProxy }, 0)
  }

  for (const child of inChildren) {
    if (pairedIncoming.has(child)) continue
    const snap = snapshotTransform(child)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- seeding alpha for the tween
    ;(child as any).alpha = 0
    const { proxy, applyProxy } = makeContainerProxy(child, {
      x: snap.x,
      y: snap.y,
      scaleX: snap.scaleX,
      scaleY: snap.scaleY,
      alpha: 0,
    })
    tl.to(
      proxy,
      { alpha: snap.alpha, duration: durationSec, ease: 'power2.inOut', onUpdate: applyProxy },
      0,
    )
  }

  // ---- Matched pairs: per-object morph ----
  //
  // For each paired object:
  //   - read outgoing snapshot (on-screen state)
  //   - read incoming snapshot (target state — whatever the incoming renderer mounted)
  //   - reset incoming container to the outgoing snapshot
  //   - tween back to the incoming target state
  //   - concurrently, fade the outgoing's own copy to alpha 0 so the two
  //     don't double-render mid-tween (incoming root is ramping up via the
  //     crossfade above, so unmatched incoming objects still appear correctly)

  for (const pair of pairs) {
    const from = snapshotTransform(pair.outgoing)
    const to = snapshotTransform(pair.incoming)

    // In Narrative, object renderers change size by redrawing geometry (e.g.
    // Graphics.rect(0, 0, width, height)) rather than by setting
    // container.scale. So both from.scaleX and to.scaleX are typically 1 —
    // there's nothing to tween. To morph size anyway we derive an effective
    // scale factor from the apparent container width/height:
    //   at t=0 incoming is drawn at its own geometry size (to.width); we
    //   want it to *look* like the outgoing's apparent size (from.width),
    //   so seed incoming.scale = from.width / to.width and tween back to 1.
    const fromSx = to.width > 0 ? from.width / to.width : from.scaleX
    const fromSy = to.height > 0 ? from.height / to.height : from.scaleY
    const toSx = to.scaleX
    const toSy = to.scaleY

    // Seed the incoming container at the outgoing state so the tween starts
    // exactly where the outgoing object was drawn last frame.
    pair.incoming.position.set(from.x, from.y)
    pair.incoming.scale.set(fromSx, fromSy)
    pair.incoming.alpha = from.alpha
    if (pair.incoming.rotation !== undefined) pair.incoming.rotation = from.rotation

    // Override the incoming-root alpha ramp for this specific child — the
    // child's own alpha is multiplied by the root's, so to actually see the
    // tween we need the child's effective alpha to track `to.alpha` (the
    // paint target) independent of the fade-in on the root. Easiest: bump
    // the child's own alpha up front and scale the tween from there.
    // (The display math: shown_alpha = root.alpha × child.alpha. We want
    // shown_alpha to follow a direct path from `from.alpha` to `to.alpha`
    // so the user perceives a single morphing object, not a cross-fade.)
    // Achieved below by tweening the child's `alpha` directly; root alpha
    // is handled separately and its contribution is absorbed by the
    // onComplete snap.

    const { proxy, applyProxy } = makeContainerProxy(pair.incoming, {
      x: from.x,
      y: from.y,
      scaleX: fromSx,
      scaleY: fromSy,
      alpha: from.alpha,
      rotation: from.rotation,
    })

    // Per-object morph tween. Rotation rides the proxy so it eases with
    // power2.inOut in lockstep with x/y/scale — previously it was lerped
    // off the linear tl.progress(), desyncing from the eased transform.
    tl.to(
      proxy,
      {
        x: to.x,
        y: to.y,
        scaleX: toSx,
        scaleY: toSy,
        alpha: to.alpha,
        rotation: to.rotation,
        duration: durationSec,
        ease: 'power2.inOut',
        onUpdate: applyProxy,
      },
      0,
    )

    // Hide the outgoing copy of the matched object immediately (not over
    // 150ms) so the incoming's seeded transform is the only thing rendered
    // at t=0. Previously we fade-out-ed the outgoing over 150ms, but the
    // incoming is already seeded at from.alpha at t=0 — which means both
    // copies were visible, and "over" compositing summed them to a higher
    // apparent alpha than the user's source (e.g. two 0.5 alphas composite
    // to 0.75). That was a visible blink-up-then-dip pattern for any
    // object with source alpha < 1.
    pair.outgoing.alpha = 0
  }

  // Snap final state on complete — insurance against floating-point residue
  // if the timeline is paused mid-tween and disposed.
  tl.eventCallback('onComplete', () => {
    outgoing.alpha = 0
    incoming.alpha = 1
    for (const pair of pairs) {
      const to = snapshotTransform(pair.incoming)
      pair.incoming.position.set(to.x, to.y)
      pair.incoming.scale.set(to.scaleX, to.scaleY)
      pair.incoming.alpha = to.alpha
      // rotation already set by onUpdate at p=1
    }
  })

  return { timeline: tl, dispose: () => tl.kill() }
}
