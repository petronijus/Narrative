/**
 * ui/commandPatch.ts — an editor patch as the update commands read it.
 *
 * The editor deletes a field by writing `undefined` ("fall back to the
 * default"); JSON has no `undefined`, so the commands (`object.update`,
 * `table.style.*`, `text.setBoxTypography`) take `null` as "clear". Every
 * other value passes unchanged.
 */
export function forCommand(patch: object): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(patch).map(([key, value]) => [key, value === undefined ? null : value]),
  )
}
