/**
 * animation/instanceTargetIds.ts
 *
 * M16 P8 — Synthetic target-id format for ComponentInstance leaves.
 *
 * Pure helpers — no Pixi, no Yjs, no React. Both the renderer-side
 * targetResolver (which needs Pixi to actually resolve) and the merger
 * in `buildMergedAnimationSteps.ts` (pure, used in tests + SSR) build
 * + parse the id through these helpers, so the format stays
 * single-sourced.
 *
 * Format:
 *   `instance:<instanceId>:<masterLeafId>`
 *     - instanceId   — id of the ComponentInstance node on the slide.
 *     - masterLeafId — id of a leaf inside the master tree (preserved
 *                      by reconcileChildren in P6 across master edits).
 *
 * Why colons:
 *   instance + leaf ids are nanoid (URL-safe), so neither contains a
 *   colon. The parser splits on the FIRST colon after the prefix so
 *   any future leaf-id format that does carry a colon still routes
 *   correctly (the leaf id is everything past the first separator).
 */

const INSTANCE_TARGET_PREFIX = 'instance:'

/** Build a synthetic target id for a leaf inside a ComponentInstance. */
export function makeInstanceLeafTargetId(instanceId: string, leafId: string): string {
  return `${INSTANCE_TARGET_PREFIX}${instanceId}:${leafId}`
}

export interface ParsedInstanceTargetId {
  instanceId: string
  leafId: string
}

/**
 * Parse `instance:<instanceId>:<leafId>` back into its parts. Returns
 * null when the id doesn't carry the prefix or either segment is
 * empty — callers fall back to plain SceneGraph resolution.
 */
export function parseInstanceTargetId(id: string): ParsedInstanceTargetId | null {
  if (!id.startsWith(INSTANCE_TARGET_PREFIX)) return null
  const rest = id.slice(INSTANCE_TARGET_PREFIX.length)
  const colon = rest.indexOf(':')
  if (colon <= 0 || colon === rest.length - 1) return null
  const instanceId = rest.slice(0, colon)
  const leafId = rest.slice(colon + 1)
  return { instanceId, leafId }
}
