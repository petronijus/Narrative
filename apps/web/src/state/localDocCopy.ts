/**
 * state/localDocCopy.ts — one document's local copy and its epoch claim,
 * next to its HocuspocusProvider (ADR 0017).
 *
 * The three places that open a Yjs document from the sync server (the deck
 * in SlideDocProvider, the folder tokens in FolderDocProvider, component
 * masters in componentDocCache) do the same:
 *
 *   const copy = openDocumentCopy({ doc, documentName, user, onRebuild })
 *   copy.whenReady(() => {
 *     const provider = new HocuspocusProvider({ …, token: copy.token })
 *     copy.attach(provider)
 *   })
 *   …
 *   copy.close()            // before provider.destroy() / doc.destroy()
 *
 * `whenReady` runs its callback once a stored copy, if there is one, is in
 * the document — applied as one update with {@link LOCAL_COPY_ORIGIN} before
 * the provider exists, so the provider never uploads it and its first sync
 * step carries the copy's state vector (the server sends only what changed).
 * An open without a stored copy runs it synchronously: the connection starts
 * exactly when it did before local copies.
 *
 * What it writes, and when it confirms a stored copy: only states the server
 * confirmed — the provider synced and every local update acknowledged
 * (`unsyncedChanges` back at 0 after the sync), on a connection whose epoch
 * the server told, for the user who is signed in now — so a copy never
 * holds anything the server lacks (a read-only connection's rejected writes,
 * an edit not yet acknowledged). A document opened without a copy writes a
 * base first; after that, and after opening one, writes are increments on
 * top of the stored base. The first write after a sync goes at the next idle
 * moment, later ones debounced; flushed when the document closes or the page
 * is hidden.
 *
 * A copy that holds what the server does not (it should never — a planted or
 * damaged copy) is foreign: when the server's first sync step shows items of
 * the copy it lacks, the provider is detached at once — before it answers,
 * so none of it is sent — the copy deleted and the document rebuilt; a
 * read-only connection that answers "not applied" to a session that made no
 * edits of its own means the same.
 *
 * The epoch claim (`token`) runs for every document, copy or not: it names
 * the epoch of the content the Y.Doc holds, so a tab that stayed open across
 * a replaced document or a restored database is refused too.
 *
 * Refusals: any refusal deletes the copy; a `stale-document` refusal, or a
 * refusal before the document's first sync while it shows a copy, calls
 * `onRebuild` — the caller throws the document away and starts again with
 * an empty one (which reads no copy: it was deleted).
 *
 * Whose copies: {@link setLocalCopyUser}, from the AuthProvider. A change of
 * user (sign-out, another account, another tab's session) stops every open
 * session's writes for good, in this tab and in the store.
 */

import * as Y from 'yjs'
import type { HocuspocusProvider } from '@hocuspocus/provider'
import {
  STALE_DOCUMENT_REASON,
  connectToken,
  isDocumentEpoch,
  parseDocumentEpochMessage,
  perfCount,
  type DocumentEpoch,
} from '@narrative/shared'
import {
  confirmLocalDoc,
  deleteLocalDoc,
  hasLocalDoc,
  localDocsDisabledOnDevice,
  readLocalDoc,
  setLocalDocStoreUser,
  writeLocalDoc,
} from './localDocStore.js'

/**
 * Origin of the transaction that puts a stored copy into a document. Not
 * tracked by any UndoManager (they track LOCAL_ORIGIN only), and applied as
 * a remote transaction: it is the server's state, cached.
 */
export const LOCAL_COPY_ORIGIN = Symbol('local-copy')

/** How long an open waits for its stored copy before it connects without it. */
export const LOCAL_COPY_READ_TIMEOUT_MS = 1_500
/** Quiet time after the last change before a confirmed state is written. */
export const LOCAL_COPY_DEBOUNCE_MS = 1_000
/** Longest a confirmed state waits while changes keep coming. */
export const LOCAL_COPY_MAX_WAIT_MS = 10_000

/** Hocuspocus message types the session reads (provider types.ts). */
const MESSAGE_SYNC = 0
const MESSAGE_SYNC_STATUS = 8
const SYNC_STEP_1 = 0

// ---------------------------------------------------------------------------
// Whose copies — set by the AuthProvider (state/AuthContext.tsx)
// ---------------------------------------------------------------------------

let currentUser: string | null = null

/** Every open session, so a change of user can stop their writes. */
const sessions = new Set<{ user: string | null; stopWrites(): void }>()

/**
 * The signed-in user, or null (signed out, not known yet, unknown): copies
 * are kept for them only. Any change stops the writes of every session
 * opened for someone else — a sign-out, a sign-in as another person, another
 * tab's session — and the store refuses writes for anyone but `sub`.
 */
export function setLocalCopyUser(sub: string | null): void {
  currentUser = sub
  setLocalDocStoreUser(sub)
  for (const session of sessions) if (session.user !== sub) session.stopWrites()
}

/** The user copies are kept for now (tests, diagnostics). */
export function localCopyUser(): string | null {
  return currentUser
}

/**
 * Pages that keep no copy of anything they open: the render pages
 * (`/deck/:id/render`, the component render page, frozen renders) show what
 * the server holds — for the deck, its folder's tokens and the component
 * masters alike.
 */
export function isNoCopyPage(pathname: string): boolean {
  return /\/render\/?$/.test(pathname)
}

/**
 * Whose copy a document opened from a page with this query string keeps:
 * the signed-in user's, or null — signed out, a share-link visit (a
 * `share_token` in the URL: anonymous, and possibly a shared machine), a
 * render page, or copies turned off on this device.
 */
export function localCopyUserFor(
  search: string,
  pathname: string = typeof window === 'undefined' ? '' : window.location.pathname,
): string | null {
  if (currentUser === null) return null
  if (isNoCopyPage(pathname)) return null
  if (new URLSearchParams(search).get('share_token') !== null) return null
  if (localDocsDisabledOnDevice()) return null
  return currentUser
}

// ---------------------------------------------------------------------------
// The session
// ---------------------------------------------------------------------------

export interface DocumentCopyOptions {
  doc: Y.Doc
  /** The sync server's name of the document (`<deckId>`, `folder:<id>`, `component:<id>`). */
  documentName: string
  /** Whose copy to read and write; null: none (the epoch claim still runs). */
  user: string | null
  /** The document must be thrown away and opened again empty (see the module comment). */
  onRebuild: () => void
}

export interface DocumentCopy {
  /**
   * Run `start` (create the provider) once the stored copy, if any, is in
   * the document — synchronously when there is none to read; never after
   * `close()`.
   */
  whenReady(start: () => void): void
  /** The provider's `token`: claims the epoch of the content the document holds. */
  readonly token: () => string
  /** Closed (or rebuilt): create nothing more for this document. */
  readonly closed: boolean
  /** Whether the document shows a stored copy no sync of this session has confirmed yet. */
  readonly showsUnconfirmedCopy: boolean
  /** Whether a refusal with this reason makes the document rebuild (`onRebuild`). */
  rebuildsOn(reason: string): boolean
  /** Bind to the document's provider once it exists. */
  attach(provider: HocuspocusProvider): void
  /** Write the last confirmed state (unless `flush: false`) and stop. Idempotent. */
  close(opts?: { flush?: boolean }): void
}

type IdleHandle = { cancel(): void }

function whenIdle(fn: () => void): IdleHandle {
  if (typeof window.requestIdleCallback === 'function') {
    const id = window.requestIdleCallback(fn, { timeout: 2_000 })
    return { cancel: () => window.cancelIdleCallback(id) }
  }
  const id = window.setTimeout(fn, 0)
  return { cancel: () => window.clearTimeout(id) }
}

/** The payload of the provider's 'message' event (HocuspocusProvider.onMessage). */
interface ProviderMessage {
  message: {
    readVarString(): string
    readVarUint(): number
    readVarUint8Array(): Uint8Array
  }
}

export function openDocumentCopy(opts: DocumentCopyOptions): DocumentCopy {
  const { doc, documentName, user, onRebuild } = opts

  let closed = false
  let provider: HocuspocusProvider | null = null
  /** Epoch of what the document holds: a copy's, or the one a connection was told. */
  let contentEpoch: DocumentEpoch | null = null
  /** Epoch the current connection was told (null until then, and after it closes). */
  let connectionEpoch: DocumentEpoch | null = null
  let fromCopy = false
  /** The copy's state vector, as applied (what the copy, not this session, brought). */
  let copyVector: Map<number, number> | null = null
  /**
   * The server has shown the copy is a subset of its document: its first
   * sync step lacked nothing of the copy, and it applied (acknowledged) what
   * the client answered. Until then the copy is checked (`onMessage`).
   */
  let copyVerified = false
  let syncedOnce = false
  /** The stored copy was confirmed unchanged (or rewritten) since the sync. */
  let confirmedSinceSync = false
  /** Updates this session made itself (not the server's, not the copy's). */
  let ownUpdates = 0
  /** Writes are off for this document (refused, another user, or the store turned itself off). */
  let writesOff = user === null
  /** The state vector the stored copy holds since this session's last write; null → write a base. */
  let writtenVector: Uint8Array | null = null
  /** Changed since the last write. */
  let dirty = false
  /** Something was written in this session (later writes are debounced). */
  let wroteThisSession = false
  let debounce: number | null = null
  let maxWait: number | null = null
  let idle: IdleHandle | null = null

  const cleanups: Array<() => void> = []

  /** This session may still write for `user`: the user signed in now is `user`. */
  const mayWrite = (): boolean => !writesOff && !closed && user !== null && user === currentUser

  const confirmed = (): boolean =>
    provider !== null &&
    provider.synced &&
    !provider.hasUnsyncedChanges &&
    connectionEpoch !== null &&
    connectionEpoch === contentEpoch

  const clearTimers = (): void => {
    if (debounce !== null) window.clearTimeout(debounce)
    if (maxWait !== null) window.clearTimeout(maxWait)
    debounce = null
    maxWait = null
    idle?.cancel()
    idle = null
  }

  /** Write the document's state now if it is confirmed and changed. */
  const writeNow = (): void => {
    if (!mayWrite() || !dirty || !confirmed()) return
    const epoch = contentEpoch
    if (epoch === null || user === null) return
    const started = performance.now()
    const vector = Y.encodeStateVector(doc)
    const base = writtenVector === null ? Y.encodeStateAsUpdate(doc) : undefined
    const tail = writtenVector === null ? undefined : Y.encodeStateAsUpdate(doc, writtenVector)
    dirty = false
    wroteThisSession = true
    confirmedSinceSync = true
    // Writes may overlap (a close while one is pending): IndexedDB runs
    // transactions of one scope in order, and a later tail is a superset.
    perfCount(base !== undefined ? 'local.copy.write.base' : 'local.copy.write.tail')
    // What the write costs the main thread (the encode; IndexedDB copies off it).
    perfCount('local.copy.write.encodeMs', Math.round(performance.now() - started))
    void writeLocalDoc({
      user,
      documentName,
      epoch,
      ...(base !== undefined ? { base } : {}),
      ...(tail !== undefined ? { tail } : {}),
    }).then((result) => {
      if (result === 'off') {
        writesOff = true
        return
      }
      if (result === 'needs-base') {
        // The stored base is gone, of another epoch (another tab, a new
        // generation), too big with its tails, or the tails are many: the
        // next write is a full state.
        writtenVector = null
        dirty = true
      } else {
        writtenVector = vector
      }
      if (dirty) schedule()
    })
  }

  /**
   * The state is confirmed: write it if it changed, else (once per sync)
   * tell the store the server confirmed the stored copy as it is.
   */
  const settle = (): void => {
    if (!syncedOnce || !mayWrite() || !confirmed()) return
    if (dirty) {
      schedule()
      return
    }
    if (confirmedSinceSync || writtenVector === null || user === null) return
    confirmedSinceSync = true
    void confirmLocalDoc(user, documentName)
  }

  const schedule = (): void => {
    if (!mayWrite()) return
    if (debounce !== null) window.clearTimeout(debounce)
    const fire = (): void => {
      clearTimers()
      idle = whenIdle(() => {
        idle = null
        writeNow()
      })
    }
    // The first write after the sync goes at the next idle moment: a sync is
    // a finished burst, and an open should be done with it while the rest of
    // the open (thumbnails, rasters) still runs, not a second later.
    if (syncedOnce && !wroteThisSession) {
      fire()
      return
    }
    debounce = window.setTimeout(fire, LOCAL_COPY_DEBOUNCE_MS)
    if (maxWait === null) maxWait = window.setTimeout(fire, LOCAL_COPY_MAX_WAIT_MS)
  }

  const onUpdate = (_update: Uint8Array, origin: unknown): void => {
    if (origin === LOCAL_COPY_ORIGIN) return
    if (origin !== provider) ownUpdates++
    dirty = true
    schedule()
  }
  doc.on('update', onUpdate)
  cleanups.push(() => doc.off('update', onUpdate))

  const onPageHide = (): void => writeNow()
  window.addEventListener('pagehide', onPageHide)
  cleanups.push(() => window.removeEventListener('pagehide', onPageHide))

  const stopWrites = (): void => {
    writesOff = true
    clearTimers()
  }
  const registration = { user, stopWrites }
  sessions.add(registration)
  cleanups.push(() => sessions.delete(registration))

  const rebuild = (): void => {
    if (closed) return
    session.close({ flush: false })
    onRebuild()
  }

  /** The copy is not a subset of the server's document: drop it, send none of it. */
  const foreign = (why: string): void => {
    if (closed) return
    perfCount('local.copy.foreign')
    if (import.meta.env.DEV) console.warn(`[local-docs] a stored copy is foreign (${why})`)
    // Detached before the provider answers the message being handled: its
    // reply (the copy's surplus) is never sent.
    provider?.detach()
    if (user !== null) void deleteLocalDoc(user, documentName)
    rebuild()
  }

  /** Items of the copy (not of this session) the server's state vector lacks. */
  const copyHasSurplus = (serverVector: Map<number, number>): boolean => {
    if (copyVector === null) return false
    for (const [client, clock] of copyVector) {
      if (client === doc.clientID) continue
      if (clock > (serverVector.get(client) ?? 0)) return true
    }
    return false
  }

  const ready: Promise<void> | null =
    user === null || !hasLocalDoc(user, documentName)
      ? null
      : (async () => {
          let timedOut = false
          const read = await Promise.race([
            readLocalDoc(user, documentName),
            new Promise<null>((resolve) =>
              window.setTimeout(() => {
                timedOut = true
                resolve(null)
              }, LOCAL_COPY_READ_TIMEOUT_MS),
            ),
          ])
          if (closed || read === null || timedOut || !isDocumentEpoch(read.epoch)) {
            if (timedOut) perfCount('local.copy.read.timeout')
            return
          }
          // Read for someone who is not signed in any more: show nothing.
          if (user !== currentUser) return
          try {
            // One update, so one transaction and one render of the whole copy;
            // a remote one (`applyUpdate` is not local), in no undo history.
            const update =
              read.updates.length === 1 ? read.updates[0]! : Y.mergeUpdates(read.updates)
            Y.applyUpdate(doc, update, LOCAL_COPY_ORIGIN)
          } catch (err) {
            // A copy that does not decode: whatever part of it went in cannot
            // be trusted. Delete it and open the document again, empty.
            if (import.meta.env.DEV) console.warn('[local-docs] a stored copy failed to apply', err)
            void deleteLocalDoc(user, documentName)
            rebuild()
            return
          }
          perfCount('local.copy.applied')
          contentEpoch = read.epoch
          fromCopy = true
          copyVector = Y.decodeStateVector(Y.encodeStateVector(doc))
          // The next write is an increment on top of what is stored.
          writtenVector = Y.encodeStateVector(doc)
        })()

  const session: DocumentCopy = {
    whenReady(start: () => void): void {
      if (ready === null) {
        if (!closed) start()
        return
      }
      void ready.then(() => {
        if (!closed) start()
      })
    },
    token: () => connectToken(contentEpoch),
    get closed() {
      return closed
    },
    get showsUnconfirmedCopy() {
      return fromCopy && !syncedOnce
    },
    rebuildsOn(reason: string): boolean {
      return !closed && (reason === STALE_DOCUMENT_REASON || (fromCopy && !syncedOnce))
    },

    attach(p: HocuspocusProvider): void {
      if (closed || provider !== null) return
      provider = p
      const onOpen = (): void => {
        // A new connection: it is told its epoch again before anything is written.
        connectionEpoch = null
      }
      const onStateless = ({ payload }: { payload: string }): void => {
        const message = parseDocumentEpochMessage(payload)
        if (message === null || message.documentName !== documentName) return
        connectionEpoch = message.epoch
        // The server accepted this connection's claim (or it claimed none):
        // from now on the document holds that epoch's content.
        contentEpoch = message.epoch
        settle()
      }
      const onMessage = ({ message }: ProviderMessage): void => {
        // Only while a stored copy is in the document and not yet verified.
        // (The server answers the client's first step with its step 2, then
        // its own step 1, then acknowledges the client's answer: `synced`
        // comes before the checks below, so they do not wait for it.)
        if (copyVector === null || copyVerified || closed) return
        try {
          message.readVarString()
          const type = message.readVarUint()
          if (type === MESSAGE_SYNC && message.readVarUint() === SYNC_STEP_1) {
            const serverVector = Y.decodeStateVector(message.readVarUint8Array())
            if (copyHasSurplus(serverVector)) foreign('the server lacks items of it')
          } else if (type === MESSAGE_SYNC_STATUS) {
            // A varInt of 0 or 1 is one byte equal to it, as a varUint reads it.
            const applied = message.readVarUint() === 1
            if (applied) copyVerified = true
            // "Not applied" to a session that sent nothing of its own: what it
            // sent was the copy's (a read-only connection drops it).
            else if (ownUpdates === 0) foreign('the server did not apply it')
          }
        } catch {
          // Not a message this session reads.
        }
      }
      const onSynced = ({ state }: { state: boolean }): void => {
        if (!state) return
        syncedOnce = true
        fromCopy = false
        confirmedSinceSync = false
        settle()
      }
      const onUnsynced = (): void => settle()
      const onFailed = ({ reason }: { reason: string }): void => {
        const again = session.rebuildsOn(reason)
        stopWrites()
        if (user !== null) void deleteLocalDoc(user, documentName)
        perfCount('local.copy.refused')
        if (again) rebuild()
      }
      p.on('open', onOpen)
      p.on('stateless', onStateless)
      p.on('message', onMessage)
      p.on('synced', onSynced)
      p.on('unsyncedChanges', onUnsynced)
      p.on('authenticationFailed', onFailed)
      cleanups.push(() => {
        p.off('open', onOpen)
        p.off('stateless', onStateless)
        p.off('message', onMessage)
        p.off('synced', onSynced)
        p.off('unsyncedChanges', onUnsynced)
        p.off('authenticationFailed', onFailed)
      })
    },

    close({ flush = true } = {}): void {
      if (closed) return
      if (flush) writeNow()
      closed = true
      clearTimers()
      for (const cleanup of cleanups.splice(0)) cleanup()
    },
  }

  const onDestroy = (): void => session.close()
  doc.on('destroy', onDestroy)
  cleanups.push(() => doc.off('destroy', onDestroy))

  return session
}

/** Close every open session's writes (sign-out; a session change in another tab). */
export function stopAllLocalCopyWrites(): void {
  for (const session of sessions) session.stopWrites()
}
