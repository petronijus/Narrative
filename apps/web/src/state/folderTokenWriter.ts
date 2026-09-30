/**
 * state/folderTokenWriter.ts — how the editor changes a folder's design
 * tokens (A2.12): through the server (routes/tokens.ts → services/tokens.ts,
 * the code the `token.*` commands run), never by writing the folder
 * document itself. The server writes the document through the sync server
 * and carries a change into every deck and component master of the folder,
 * so it comes back to this page as a remote update like a collaborator's.
 *
 * Until it does, the page shows what the user asked for:
 *
 *   - a pending change overlays the document's tokens (`overlayTokens`)
 *     until the document shows it, so a swatch follows the colour picker;
 *   - changes to one token are coalesced — one request in flight per token,
 *     everything changed meanwhile goes out as ONE follow-up request. A
 *     colour-picker drag sends a handful of requests, not hundreds, and each
 *     of them re-styles the folder's decks on the server;
 *   - `whenTokens` waits for the document to reach a state, for callers that
 *     go on to run a document command with the new tokens (the Inspector's
 *     text-style actions).
 *
 * A change is validated here with the store's own parser (`parseTokenPatch`), so an
 * invalid value fails at once, and the overlay and the wait compare against
 * the values the server stores (normalised, e.g. `#ABC` → `#aabbcc`).
 */

import type * as Y from 'yjs'
import {
  InvalidTokenFields,
  parseTokenPatch,
  type EditableTokenCategory,
  type TokenCategory,
} from '@narrative/commands'
import { readFolderTokens, type FolderTokensSnapshot } from '@narrative/slide-model'
import type { ApiClient } from '../api/client.js'

export type TokenApi = Pick<ApiClient, 'createToken' | 'updateToken' | 'deleteToken'>

/** A change not yet shown by the folder document: the fields as stored (`undefined` = removed). */
export interface PendingTokenChange {
  category: EditableTokenCategory
  id: string
  fields: Record<string, unknown>
}

/** How long a caller waits for the folder document to show a change the server made. */
export const TOKEN_SYNC_TIMEOUT_MS = 15_000

/** The folder document did not show a change within {@link TOKEN_SYNC_TIMEOUT_MS}. */
export class TokenSyncTimeout extends Error {
  constructor() {
    super('The folder did not update in time; check the connection and try again')
    this.name = 'TokenSyncTimeout'
  }
}

/** A change the command schema refuses; `message` names the fields. */
export class InvalidTokenChange extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidTokenChange'
  }
}

/** Structural equality of stored token values (key order does not matter). */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const ka = Object.keys(a)
  const kb = Object.keys(b)
  if (ka.length !== kb.length) return false
  return ka.every((k) =>
    sameValue((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
  )
}

/** Whether a token shows every field of a change. */
export function showsChange(token: object | undefined, fields: Record<string, unknown>): boolean {
  if (token === undefined) return false
  const stored = token as Record<string, unknown>
  return Object.entries(fields).every(([k, v]) => sameValue(stored[k], v))
}

/** The document's tokens with the pending changes applied over them. */
export function overlayTokens(
  tokens: FolderTokensSnapshot,
  pending: ReadonlyArray<PendingTokenChange>,
): FolderTokensSnapshot {
  if (pending.length === 0) return tokens
  const out: FolderTokensSnapshot = {
    colors: { ...tokens.colors },
    textStyles: { ...tokens.textStyles },
    effectStyles: { ...tokens.effectStyles },
  }
  for (const change of pending) {
    const category = out[change.category] as unknown as Record<string, Record<string, unknown>>
    const token = category[change.id]
    // A token deleted meanwhile stays deleted.
    if (token === undefined) continue
    const merged: Record<string, unknown> = { ...token }
    for (const [k, v] of Object.entries(change.fields)) {
      if (v === undefined) delete merged[k]
      else merged[k] = v
    }
    category[change.id] = merged
  }
  return out
}

/**
 * The stored form of a change (as `token.update` parses it: normalised, a
 * `null` turned into `undefined` = removed). Throws {@link InvalidTokenChange}.
 */
export function storedFields(
  category: EditableTokenCategory,
  _tokenId: string,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  try {
    return parseTokenPatch(category, patch)
  } catch (err) {
    if (err instanceof InvalidTokenFields) throw new InvalidTokenChange(err.message)
    throw err
  }
}

interface Slot {
  category: EditableTokenCategory
  id: string
  /** Everything changed and not yet shown by the document, as sent (`null` = remove). */
  shown: Record<string, unknown>
  /** Changed after the request in flight left; goes out next, as one request. */
  queued: Record<string, unknown> | null
  queuedWaiters: Array<{ resolve: () => void; reject: (e: unknown) => void }>
  inFlight: boolean
}

export class FolderTokenWriter {
  private readonly slots = new Map<string, Slot>()
  private disposed = false

  constructor(
    private readonly api: TokenApi,
    private readonly folderId: string,
    private readonly doc: Y.Doc,
    /** Called whenever the pending changes change (the provider re-renders with the overlay). */
    private readonly onPendingChange: () => void,
  ) {}

  /** The changes the document does not show yet, for {@link overlayTokens}. */
  pending(): PendingTokenChange[] {
    const out: PendingTokenChange[] = []
    for (const slot of this.slots.values()) {
      out.push({
        category: slot.category,
        id: slot.id,
        fields: storedFields(slot.category, slot.id, slot.shown),
      })
    }
    return out
  }

  /**
   * Resolve with the document's tokens once `predicate` holds for them (at
   * once if it already does); reject with {@link TokenSyncTimeout}.
   */
  whenTokens(
    predicate: (tokens: FolderTokensSnapshot) => boolean,
    timeoutMs = TOKEN_SYNC_TIMEOUT_MS,
  ): Promise<FolderTokensSnapshot> {
    const now = readFolderTokens(this.doc)
    if (predicate(now)) return Promise.resolve(now)
    const tokensMap = this.doc.getMap<unknown>('tokens')
    return new Promise((resolve, reject) => {
      const check = () => {
        const tokens = readFolderTokens(this.doc)
        if (!predicate(tokens)) return
        done()
        resolve(tokens)
      }
      const timer = setTimeout(() => {
        done()
        reject(new TokenSyncTimeout())
      }, timeoutMs)
      const done = () => {
        clearTimeout(timer)
        tokensMap.unobserveDeep(check)
      }
      tokensMap.observeDeep(check)
    })
  }

  /** Add a token; resolves with its id once the folder document has it. */
  async create(category: EditableTokenCategory, fields: Record<string, unknown>): Promise<string> {
    const tokenId = await this.api.createToken(this.folderId, category, fields)
    await this.whenTokens((t) => t[category][tokenId] !== undefined)
    return tokenId
  }

  /**
   * Change a token (`null` removes an optional field). Shown at once;
   * resolves when the document shows it — also when a later change to the
   * same token was merged into the request that carried it. Rejects when
   * the change is invalid ({@link InvalidTokenChange}, nothing sent) or
   * the server refuses it (the overlay is dropped: the document is right).
   */
  update(
    category: EditableTokenCategory,
    id: string,
    patch: Record<string, unknown>,
  ): Promise<void> {
    if (Object.keys(patch).length === 0) return Promise.resolve()
    // An invalid change is refused before anything is shown or sent.
    try {
      storedFields(category, id, patch)
    } catch (err) {
      return Promise.reject(err)
    }
    const key = `${category}:${id}`
    const existing = this.slots.get(key)
    const slot: Slot = existing ?? {
      category,
      id,
      shown: {},
      queued: null,
      queuedWaiters: [],
      inFlight: false,
    }
    if (existing === undefined) this.slots.set(key, slot)
    slot.shown = { ...slot.shown, ...patch }
    slot.queued = { ...(slot.queued ?? {}), ...patch }
    const settled = new Promise<void>((resolve, reject) => {
      slot.queuedWaiters.push({ resolve, reject })
    })
    this.onPendingChange()
    if (!slot.inFlight) void this.pump(key, slot)
    return settled
  }

  /** Remove a token. */
  async remove(category: TokenCategory, id: string): Promise<void> {
    await this.api.deleteToken(this.folderId, category, id)
    const slot = this.slots.get(`${category}:${id}`)
    if (slot !== undefined && !slot.inFlight) {
      this.slots.delete(`${category}:${id}`)
      this.onPendingChange()
    }
    await this.whenTokens((t) => t[category][id] === undefined).catch(() => undefined)
  }

  /** Stop reporting pending changes (the provider unmounted); requests in flight finish. */
  dispose(): void {
    this.disposed = true
  }

  private async pump(key: string, slot: Slot): Promise<void> {
    while (slot.queued !== null) {
      const patch = slot.queued
      const waiters = slot.queuedWaiters
      slot.queued = null
      slot.queuedWaiters = []
      slot.inFlight = true
      try {
        await this.api.updateToken(this.folderId, slot.category, slot.id, patch)
        const fields = storedFields(slot.category, slot.id, patch)
        try {
          await this.whenTokens((t) => showsChange(t[slot.category][slot.id], fields))
        } catch {
          // The server applied it; the document shows something else (a
          // collaborator changed the token since) or is not connected. The
          // document is the truth either way.
        }
        waiters.forEach((w) => w.resolve())
      } catch (err) {
        // Refused: nothing of this request was stored. Later changes still go out.
        waiters.forEach((w) => w.reject(err))
        for (const k of Object.keys(patch)) if (slot.queued?.[k] === undefined) delete slot.shown[k]
      } finally {
        slot.inFlight = false
      }
    }
    // Nothing more to send: the document shows (or has overruled) every change.
    this.slots.delete(key)
    if (!this.disposed) this.onPendingChange()
  }
}
