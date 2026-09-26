/**
 * state/origins.ts
 *
 * Named Yjs transaction origins for writes the editor makes that are NOT
 * user actions. Every transaction should say who made it: the undo
 * manager (`createUndoManager` in slide-model) tracks only `LOCAL_ORIGIN`,
 * and observability classifies updates by origin. An anonymous
 * `doc.transact(fn)` is indistinguishable from a bug that dropped a user
 * edit out of undo history, so deliberately untracked writes get a name.
 *
 * Nested `doc.transact` calls keep the OUTERMOST origin, so wrapping
 * slide-model mutations (which pass `LOCAL_ORIGIN` themselves) in a
 * transaction with one of these origins re-attributes all of them.
 */

/**
 * A folder text-style token changed and `TextStylePropagator` is copying
 * the new values onto the linked text in the open deck.
 *
 * Deliberately NOT on the deck's undo stack: the write mirrors the folder
 * token, it is not an edit of this deck. If Mod+Z could revert it, the
 * deck would silently drift from its token — the token still says 32 px,
 * the linked text goes back to 28 px, and nothing re-syncs it until the
 * token changes again. Undoing a token change belongs to whoever changed
 * the token, in the folder.
 *
 * Temporary home: propagation is a browser-side effect today (a deck only
 * catches up when someone opens it). Phase A2 of the agentic-layer plan
 * (`docs/plans/agentic-layer.md`) moves it server-side, where it gets its
 * own origin alongside the agent origins.
 */
export const TOKEN_PROPAGATION_ORIGIN = Symbol('token-propagation')
