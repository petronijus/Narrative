/**
 * stylePack/change.ts — what a change to a folder's style pack replaced
 * (A4.3), as the merge patch that puts it back: `style.pack.edit` returns
 * it as `previous`, and an update with it undoes the change. Shared by the
 * server's service and the test fakes, so both answer the same.
 */

const BY_ID = new Set(['layouts', 'components'])

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * The exact inverse of merge patch `patch` on `before`: for each key it
 * names, null where the key was absent (so it is removed again), the
 * inverse of the nested patch where both are objects, else the old value.
 */
function inverseMergePatch(
  before: unknown,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const base = isPlainObject(before) ? before : {}
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(patch)) {
    if (!(key in base)) out[key] = null
    else if (isPlainObject(value) && isPlainObject(base[key]))
      out[key] = inverseMergePatch(base[key], value)
    else out[key] = base[key]
  }
  return out
}

/**
 * The undo patch of applying merge patch `patch` to `current`. A part
 * `layouts` / `components` the patch touches comes back whole (an array
 * replaces the part), every other part as the exact inverse of the patch.
 */
export function previousOfUpdate(
  current: Record<string, unknown> | null,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const previous: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(patch)) {
    const before = current?.[key]
    if (before === undefined) previous[key] = null
    else if (BY_ID.has(key)) previous[key] = before
    else if (isPlainObject(value) && isPlainObject(before))
      previous[key] = inverseMergePatch(before, value)
    else previous[key] = before
  }
  return previous
}
