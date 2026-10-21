/**
 * state/localDocStore.ts — where the browser keeps its local copies of Yjs
 * documents (ADR 0017).
 *
 * A copy is a cache of state the server confirmed (state/localDocCopy.ts
 * decides when); this module only stores, reads, evicts and clears them.
 *
 * One IndexedDB database per origin, three object stores, all keyed by
 * `<user sub> NUL <document name>` so two people using one browser never
 * read each other's copies:
 *
 *   meta   key → { user, documentName, format, epoch, sizes, confirmedAt, openedAt }
 *   bases  key → a full `Y.encodeStateAsUpdate`
 *   tails  auto-increment → { key, update }, index `key` — increments
 *          written after the base, applied after it in id order
 *
 * The base and the meta are separate so appending a tail never rewrites a
 * multi-megabyte base. A synchronous index in localStorage
 * (`narrative:local-docs:v1:<sub>` → document names) lets an open without a
 * copy start its connection at once, without waiting for IndexedDB.
 *
 * Every failure — no IndexedDB (an embedded view), one that throws or never
 * opens (an old private mode, a locked profile), no localStorage — turns the
 * store off for the page: reads find nothing, writes do nothing, and the
 * editor works exactly as it does without copies.
 */

import { isDocumentEpoch, type DocumentEpoch } from '@narrative/shared'

/** Bumped when the stored layout changes: copies of another format are deleted, never migrated. */
export const LOCAL_DOC_FORMAT = 2

const DB_NAME = 'narrative-local-docs'
const DB_VERSION = 1
const META = 'meta'
const BASES = 'bases'
const TAILS = 'tails'
const INDEX_PREFIX = `narrative:local-docs:v${LOCAL_DOC_FORMAT}:`
/** Every index of an earlier format (deleted when seen). */
const INDEX_FAMILY = 'narrative:local-docs:v'
/** The per-device switch: copies are not kept on this device (ADR 0017, point 5). */
const DEVICE_OFF_KEY = 'narrative:local-docs:off'

/** How long opening the database may take before copies are off for the page. */
const OPEN_TIMEOUT_MS = 3_000
/** A copy the server has not confirmed for this long is deleted (ADR 0017, point 5). */
export const LOCAL_DOC_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000
/** Per-user caps (ADR 0017, point 6). */
export const LOCAL_DOC_MAX_DOCUMENTS = 64
export const LOCAL_DOC_MAX_BYTES = 256 * 1024 * 1024

export interface LocalDocMeta {
  key: string
  user: string
  documentName: string
  format: number
  /** The server's epoch of the document the copy came from (`<generation>.<docEpoch>`). */
  epoch: DocumentEpoch
  baseBytes: number
  tailBytes: number
  tailCount: number
  /** When the server last confirmed this state (ms since the epoch). */
  confirmedAt: number
  /** When the copy was last opened or written. */
  openedAt: number
}

export interface LocalDocRead {
  epoch: DocumentEpoch
  /** The base first, then the tails in the order they were written. */
  updates: Uint8Array[]
  confirmedAt: number
}

interface TailRecord {
  key: string
  update: Uint8Array
}

/** A Uint8Array from any realm (IndexedDB may hand back another realm's, e.g. in tests). */
function isBytes(value: unknown): value is Uint8Array {
  return Object.prototype.toString.call(value) === '[object Uint8Array]'
}

function copyKey(user: string, documentName: string): string {
  return `${user}\u0000${documentName}`
}

// ---------------------------------------------------------------------------
// The synchronous index (localStorage)
// ---------------------------------------------------------------------------

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

function readIndex(user: string): Set<string> {
  const ls = storage()
  if (ls === null) return new Set()
  try {
    const raw = ls.getItem(INDEX_PREFIX + user)
    if (raw === null) return new Set()
    const parsed: unknown = JSON.parse(raw)
    return new Set(Array.isArray(parsed) ? parsed.filter((n) => typeof n === 'string') : [])
  } catch {
    return new Set()
  }
}

function writeIndex(user: string, names: Set<string>): void {
  const ls = storage()
  if (ls === null) return
  try {
    if (names.size === 0) ls.removeItem(INDEX_PREFIX + user)
    else ls.setItem(INDEX_PREFIX + user, JSON.stringify([...names]))
  } catch {
    // A full localStorage: the copy is there but an open will not look for it.
  }
}

function indexAdd(user: string, documentName: string): void {
  const names = readIndex(user)
  if (names.has(documentName)) return
  names.add(documentName)
  writeIndex(user, names)
}

function indexRemove(user: string, documentName: string): void {
  const names = readIndex(user)
  if (!names.delete(documentName)) return
  writeIndex(user, names)
}

/** The users with an index entry (every key under the prefix). */
function indexedUsers(): string[] {
  const ls = storage()
  if (ls === null) return []
  const users: string[] = []
  const stale: string[] = []
  try {
    for (let i = 0; i < ls.length; i++) {
      const k = ls.key(i)
      if (k === null) continue
      if (k.startsWith(INDEX_PREFIX)) users.push(k.slice(INDEX_PREFIX.length))
      else if (k.startsWith(INDEX_FAMILY)) stale.push(k)
    }
    for (const k of stale) ls.removeItem(k)
  } catch {
    return []
  }
  return users
}

/**
 * Whether the index names a copy of `documentName` for `user` — synchronous,
 * so an open without one connects at once. The copy itself may still be
 * missing (evicted by the browser); a read then finds nothing.
 */
export function hasLocalDoc(user: string, documentName: string): boolean {
  if (disabled || localDocsDisabledOnDevice()) return false
  return readIndex(user).has(documentName)
}

/** The names of `user`'s indexed copies (pruning, diagnostics). */
export function indexedLocalDocs(user: string): string[] {
  return [...readIndex(user)]
}

// ---------------------------------------------------------------------------
// Whose writes — the signed-in user (state/localDocCopy.ts setLocalCopyUser)
// ---------------------------------------------------------------------------

let storeUser: string | null = null
/** Bumped with every change of user: a write begun before one is dropped. */
let storeGeneration = 0

/**
 * The user the store writes for now (null: nobody). Writes for anyone else,
 * and writes begun under a previous user, are refused at the moment their
 * IndexedDB transaction would start — after a sign-out's clear, nothing of a
 * session that was open before it lands.
 */
export function setLocalDocStoreUser(user: string | null): void {
  if (user === storeUser) return
  storeUser = user
  storeGeneration++
}

function writesAllowed(user: string, generation: number): boolean {
  return user === storeUser && generation === storeGeneration && !localDocsDisabledOnDevice()
}

// ---------------------------------------------------------------------------
// The per-device switch
// ---------------------------------------------------------------------------

/** Whether copies are turned off on this device (the person chose so). */
export function localDocsDisabledOnDevice(): boolean {
  try {
    return storage()?.getItem(DEVICE_OFF_KEY) === '1'
  } catch {
    return false
  }
}

/**
 * Turn copies off (or on again) on this device. Off also deletes every copy
 * kept here. A page reload applies it to documents already open.
 */
export async function setLocalDocsDisabledOnDevice(off: boolean): Promise<void> {
  const ls = storage()
  try {
    if (off) ls?.setItem(DEVICE_OFF_KEY, '1')
    else ls?.removeItem(DEVICE_OFF_KEY)
  } catch {
    // A full or missing localStorage keeps copies off anyway (no index).
  }
  if (off) {
    storeGeneration++
    await clearLocalDocs()
  }
}

// ---------------------------------------------------------------------------
// The database
// ---------------------------------------------------------------------------

let disabled = false
let dbPromise: Promise<IDBDatabase | null> | null = null

/** Turn copies off for the rest of the page's life (a failing database). */
function disable(reason: unknown): void {
  if (!disabled && import.meta.env.DEV) {
    console.warn('[local-docs] local document copies are off for this page:', reason)
  }
  disabled = true
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'))
  })
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onabort = () => reject(tx.error ?? new DOMException('aborted', 'AbortError'))
    tx.onerror = () => {
      // Reported again by onabort; keep the event from reaching window.onerror.
    }
  })
}

function openDb(): Promise<IDBDatabase | null> {
  if (disabled) return Promise.resolve(null)
  if (dbPromise !== null) return dbPromise
  dbPromise = new Promise<IDBDatabase | null>((resolve) => {
    let settled = false
    const finish = (db: IDBDatabase | null, reason?: unknown): void => {
      if (settled) {
        db?.close()
        return
      }
      settled = true
      window.clearTimeout(timer)
      if (db === null) disable(reason)
      resolve(db)
    }
    const timer = window.setTimeout(() => finish(null, 'open timed out'), OPEN_TIMEOUT_MS)
    let req: IDBOpenDBRequest
    try {
      if (typeof indexedDB === 'undefined') {
        finish(null, 'no IndexedDB')
        return
      }
      req = indexedDB.open(DB_NAME, DB_VERSION)
    } catch (err) {
      finish(null, err)
      return
    }
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(META)) {
        db.createObjectStore(META, { keyPath: 'key' }).createIndex('user', 'user')
      }
      if (!db.objectStoreNames.contains(BASES)) db.createObjectStore(BASES)
      if (!db.objectStoreNames.contains(TAILS)) {
        db.createObjectStore(TAILS, { autoIncrement: true }).createIndex('key', 'key')
      }
    }
    req.onsuccess = () => {
      const db = req.result
      // Another tab upgrading or deleting the database: let it.
      db.onversionchange = () => {
        db.close()
        dbPromise = null
      }
      finish(db)
    }
    req.onerror = () => finish(null, req.error)
    req.onblocked = () => finish(null, 'open blocked')
  })
  return dbPromise
}

async function deleteKey(tx: IDBTransaction, key: string): Promise<void> {
  tx.objectStore(META).delete(key)
  tx.objectStore(BASES).delete(key)
  const tailKeys = await request(tx.objectStore(TAILS).index('key').getAllKeys(key))
  for (const k of tailKeys) tx.objectStore(TAILS).delete(k)
}

function isQuotaError(err: unknown): boolean {
  return (
    err instanceof DOMException &&
    (err.name === 'QuotaExceededError' || err.name === 'NS_ERROR_DOM_QUOTA_REACHED')
  )
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * The copy of `documentName` for `user`, or null — none, another format, too
 * old (deleted on the way), or the store is off. Never rejects.
 */
export async function readLocalDoc(
  user: string,
  documentName: string,
): Promise<LocalDocRead | null> {
  const db = await openDb()
  if (db === null) return null
  const key = copyKey(user, documentName)
  try {
    const tx = db.transaction([META, BASES, TAILS], 'readonly')
    const [meta, base, tails] = await Promise.all([
      request(tx.objectStore(META).get(key) as IDBRequest<LocalDocMeta | undefined>),
      request(tx.objectStore(BASES).get(key) as IDBRequest<Uint8Array | undefined>),
      request(tx.objectStore(TAILS).index('key').getAll(key) as IDBRequest<TailRecord[]>),
    ])
    const usable =
      meta !== undefined &&
      isBytes(base) &&
      meta.user === user &&
      meta.documentName === documentName &&
      meta.format === LOCAL_DOC_FORMAT &&
      isDocumentEpoch(meta.epoch) &&
      Date.now() - meta.confirmedAt <= LOCAL_DOC_MAX_AGE_MS
    if (!usable) {
      if (meta !== undefined || base !== undefined) await deleteLocalDoc(user, documentName)
      else indexRemove(user, documentName)
      return null
    }
    void touch(db, key)
    return {
      epoch: meta.epoch,
      updates: [base, ...tails.map((t) => t.update).filter(isBytes)],
      confirmedAt: meta.confirmedAt,
    }
  } catch (err) {
    if (import.meta.env.DEV) console.warn('[local-docs] read failed', err)
    return null
  }
}

/** Record that a copy was opened (the eviction order). */
async function touch(db: IDBDatabase, key: string): Promise<void> {
  await updateMeta(db, key, (meta) => ({ ...meta, openedAt: Date.now() }))
}

async function updateMeta(
  db: IDBDatabase,
  key: string,
  change: (meta: LocalDocMeta) => LocalDocMeta,
): Promise<void> {
  try {
    const tx = db.transaction(META, 'readwrite')
    const meta = await request(
      tx.objectStore(META).get(key) as IDBRequest<LocalDocMeta | undefined>,
    )
    if (meta !== undefined) tx.objectStore(META).put(change(meta))
    await done(tx)
  } catch {
    // The eviction order and the age limit are details; nothing to tell anyone.
  }
}

/**
 * The server confirmed the stored copy as it is (a sync that brought nothing
 * new): the 30-day limit counts from now.
 */
export async function confirmLocalDoc(user: string, documentName: string): Promise<void> {
  const generation = storeGeneration
  if (!writesAllowed(user, generation)) return
  const db = await openDb()
  if (db === null || !writesAllowed(user, generation)) return
  const now = Date.now()
  await updateMeta(db, copyKey(user, documentName), (meta) => ({
    ...meta,
    confirmedAt: now,
    openedAt: now,
  }))
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

export interface LocalDocWrite {
  user: string
  documentName: string
  epoch: DocumentEpoch
  /** A full state: replaces the base and drops every tail. */
  base?: Uint8Array
  /** An increment on top of what is stored. */
  tail?: Uint8Array
}

/** What a write did, so the writer knows whether its next write may be a tail. */
export type LocalDocWriteResult = 'written' | 'needs-base' | 'off'

/**
 * Store a confirmed state. A tail is written only on top of a base of the
 * same epoch ('needs-base' otherwise — the writer then writes a base); past
 * {@link MAX_TAILS} the caller is told to write a base too. On a full disk
 * the other copies' oldest half is evicted and the write tried once more,
 * then the store turns itself off. Never rejects.
 */
export async function writeLocalDoc(write: LocalDocWrite): Promise<LocalDocWriteResult> {
  // Captured now: a change of user while this write waits for the database
  // makes it a write for someone who is not signed in any more.
  const generation = storeGeneration
  if (!writesAllowed(write.user, generation)) return 'off'
  // One document larger than the whole cap is not kept at all.
  if (write.base !== undefined && write.base.byteLength > LOCAL_DOC_MAX_BYTES) {
    await deleteLocalDoc(write.user, write.documentName)
    return 'off'
  }
  const db = await openDb()
  if (db === null) return 'off'
  try {
    return await attemptWrite(db, write, generation)
  } catch (err) {
    if (!isQuotaError(err)) {
      if (import.meta.env.DEV) console.warn('[local-docs] write failed', err)
      return 'needs-base'
    }
    await evict(db, write.user, copyKey(write.user, write.documentName), 'half')
    try {
      return await attemptWrite(db, write, generation)
    } catch (again) {
      disable(again)
      return 'off'
    }
  }
}

/** Tails a copy may collect before its next write must be a base. */
export const MAX_TAILS = 64

async function attemptWrite(
  db: IDBDatabase,
  write: LocalDocWrite,
  generation: number,
): Promise<LocalDocWriteResult> {
  const { user, documentName, epoch } = write
  const key = copyKey(user, documentName)
  const now = Date.now()
  // Checked again right before the transaction: a sign-out's clear queued
  // before it has run first, and nothing of this write lands after it.
  if (!writesAllowed(user, generation)) return 'off'
  const tx = db.transaction([META, BASES, TAILS], 'readwrite')
  const meta = await request(tx.objectStore(META).get(key) as IDBRequest<LocalDocMeta | undefined>)
  let result: LocalDocWriteResult = 'written'
  if (write.base !== undefined) {
    const tailKeys = await request(tx.objectStore(TAILS).index('key').getAllKeys(key))
    for (const k of tailKeys) tx.objectStore(TAILS).delete(k)
    tx.objectStore(BASES).put(write.base, key)
    const next: LocalDocMeta = {
      key,
      user,
      documentName,
      format: LOCAL_DOC_FORMAT,
      epoch,
      baseBytes: write.base.byteLength,
      tailBytes: 0,
      tailCount: 0,
      confirmedAt: now,
      openedAt: now,
    }
    tx.objectStore(META).put(next)
  } else if (write.tail !== undefined) {
    const tooBig =
      meta !== undefined &&
      meta.baseBytes + meta.tailBytes + write.tail.byteLength > LOCAL_DOC_MAX_BYTES
    if (meta === undefined || meta.epoch !== epoch || meta.format !== LOCAL_DOC_FORMAT || tooBig) {
      // A tail with nothing of its epoch under it, or one that would take the
      // copy past the byte cap: the writer compacts into a base instead.
      tx.abort()
      await done(tx).catch(() => undefined)
      return 'needs-base'
    }
    tx.objectStore(TAILS).add({ key, update: write.tail } satisfies TailRecord)
    const next: LocalDocMeta = {
      ...meta,
      tailBytes: meta.tailBytes + write.tail.byteLength,
      tailCount: meta.tailCount + 1,
      confirmedAt: now,
      openedAt: now,
    }
    tx.objectStore(META).put(next)
    if (next.tailCount >= MAX_TAILS) result = 'needs-base'
  }
  await done(tx)
  indexAdd(user, documentName)
  // The caps hold for tails as for bases (security review L3): every write
  // checks the user's total, evicting the least recently opened others.
  await evict(db, user, key, 'caps')
  return result
}

/**
 * Evict `user`'s copies other than `keep`: 'caps' — the expired ones, then
 * the least recently opened beyond the per-user caps; 'half' — also the
 * oldest half of the rest (a full disk).
 */
async function evict(
  db: IDBDatabase,
  user: string,
  keep: string,
  mode: 'caps' | 'half',
): Promise<void> {
  try {
    const metas = await request(
      db.transaction(META, 'readonly').objectStore(META).index('user').getAll(user) as IDBRequest<
        LocalDocMeta[]
      >,
    )
    const now = Date.now()
    const doomed = new Set<string>()
    for (const m of metas) {
      if (m.key !== keep && now - m.confirmedAt > LOCAL_DOC_MAX_AGE_MS) doomed.add(m.key)
    }
    // Newest first; the copy being written always counts as the newest.
    const rank = (m: LocalDocMeta): number => (m.key === keep ? Infinity : m.openedAt)
    const live = metas.filter((m) => !doomed.has(m.key)).sort((a, b) => rank(b) - rank(a))
    let bytes = 0
    live.forEach((m, i) => {
      bytes += m.baseBytes + m.tailBytes
      const over = i >= LOCAL_DOC_MAX_DOCUMENTS || bytes > LOCAL_DOC_MAX_BYTES
      if (over && m.key !== keep) doomed.add(m.key)
    })
    if (mode === 'half') {
      const others = live.filter((m) => m.key !== keep && !doomed.has(m.key))
      for (const m of others.slice(Math.floor(others.length / 2))) doomed.add(m.key)
    }
    if (doomed.size === 0) return
    const tx = db.transaction([META, BASES, TAILS], 'readwrite')
    for (const key of doomed) await deleteKey(tx, key)
    await done(tx)
    for (const m of metas) if (doomed.has(m.key)) indexRemove(user, m.documentName)
  } catch {
    // Eviction is best-effort; the caps are checked again on the next write.
  }
}

// ---------------------------------------------------------------------------
// Deleting
// ---------------------------------------------------------------------------

/** Delete one copy (a refused connection, a stale epoch, a copy that failed to decode). */
export async function deleteLocalDoc(user: string, documentName: string): Promise<void> {
  indexRemove(user, documentName)
  const db = await openDb()
  if (db === null) return
  try {
    const tx = db.transaction([META, BASES, TAILS], 'readwrite')
    await deleteKey(tx, copyKey(user, documentName))
    await done(tx)
  } catch {
    // The index no longer names it, so no open will read it.
  }
}

/**
 * Delete the copies of `user` whose document `gone` says the user can no
 * longer open (the home page knows every folder they reach, the API every
 * deck; security review L1). Returns the names deleted.
 */
export async function pruneLocalDocs(
  user: string,
  gone: (documentName: string) => boolean,
): Promise<string[]> {
  const doomed = indexedLocalDocs(user).filter(gone)
  for (const name of doomed) await deleteLocalDoc(user, name)
  return doomed
}

/** Delete every copy of every user (signing out, no session). */
export async function clearLocalDocs(): Promise<void> {
  for (const u of indexedUsers()) writeIndex(u, new Set())
  const db = await openDb()
  if (db === null) return
  try {
    const tx = db.transaction([META, BASES, TAILS], 'readwrite')
    tx.objectStore(META).clear()
    tx.objectStore(BASES).clear()
    tx.objectStore(TAILS).clear()
    await done(tx)
  } catch {
    // Nothing indexes them any more; the next sign-in deletes them as another user's.
  }
}

/**
 * Delete the copies of every user but `user` (one session per browser at a
 * time). The index entries go at once; the stored copies — never read for
 * `user` anyway, their keys name their owner — when the page is idle, so
 * the scan does not compete with the open of the page that called it.
 */
export function retainOnlyLocalDocsOf(user: string): Promise<void> {
  for (const u of indexedUsers()) if (u !== user) writeIndex(u, new Set())
  return new Promise((resolve) => {
    const run = (): void => {
      void deleteCopiesOfOthers(user).then(resolve)
    }
    if (typeof window.requestIdleCallback === 'function') {
      window.requestIdleCallback(run, { timeout: 10_000 })
    } else {
      window.setTimeout(run, 0)
    }
  })
}

async function deleteCopiesOfOthers(user: string): Promise<void> {
  const db = await openDb()
  if (db === null) return
  try {
    const metas = await request(
      db.transaction(META, 'readonly').objectStore(META).getAll() as IDBRequest<LocalDocMeta[]>,
    )
    const others = metas.filter((m) => m.user !== user)
    if (others.length === 0) return
    const tx = db.transaction([META, BASES, TAILS], 'readwrite')
    for (const m of others) await deleteKey(tx, m.key)
    await done(tx)
  } catch {
    // Best-effort: they are unindexed already and never read for `user`.
  }
}

/** @internal Tests: forget the open database and the off switch. */
export function __resetLocalDocStoreForTests(): void {
  void dbPromise?.then((db) => db?.close())
  dbPromise = null
  disabled = false
  storeUser = null
  storeGeneration++
}

/** @internal Tests and diagnostics: the stored metas. */
export async function __listLocalDocsForTests(): Promise<LocalDocMeta[]> {
  const db = await openDb()
  if (db === null) return []
  return request(
    db.transaction(META, 'readonly').objectStore(META).getAll() as IDBRequest<LocalDocMeta[]>,
  )
}
