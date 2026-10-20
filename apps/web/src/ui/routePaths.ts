/**
 * ui/routePaths.ts — paths of pages linked from more than one place.
 *
 * Their own module so the route table (App.tsx) can name them without
 * importing the account menu — and with it the dropdown menu primitives —
 * into the entry chunk every route loads (docs/plans/performance.md → L1).
 */

export const ACCESS_TOKENS_PATH = '/settings/access-tokens'
export const ADMIN_PATH = '/admin'
