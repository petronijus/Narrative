/**
 * slide-model/src/observe.ts
 *
 * Observer helpers — subscribe na Y.Array changes pro React konzumenty a renderer.
 *
 * Dvě API:
 * 1. subscribeToObjects — full snapshot API (backward compat, pro UI komponenty)
 * 2. subscribeToObjectChanges — incremental diff API s per-frame batching (pro renderer)
 */

import * as Y from 'yjs'
import type { SlideObject } from '@narrative/shared'
import { yMapToPlainObject } from './bindings.js'
import type { ObjectsMutationContext } from './mutations.js'

// Backward-compat alias — functions below still accept the old MutationContext shape
type MutationContext = ObjectsMutationContext

// ---------------------------------------------------------------------------
// Full snapshot API (M2, zachováno pro backward compat)
// ---------------------------------------------------------------------------

/**
 * @deprecated Use subscribeToSlideObjects() from slideObserve.ts (M9).
 * This subscribes to a root-level objects array — only valid for legacy single-slide docs.
 * Kept for backward compat — removed in M10.
 *
 * Subscribeuje na změny objects array.
 * Callback je zavolán okamžitě se současným snapshotem,
 * pak na každou změnu (add/update/remove).
 *
 * Vrací unsubscribe funkci — zavolej při unmount.
 */
export function subscribeToObjects(
  ctx: MutationContext,
  callback: (objects: SlideObject[]) => void,
): () => void {
  // Helper pro snapshot všech objektů
  const getSnapshot = (): SlideObject[] => {
    const result: SlideObject[] = []
    for (let i = 0; i < ctx.objects.length; i++) {
      result.push(yMapToPlainObject(ctx.objects.get(i)))
    }
    return result
  }

  // Observer funkce — zavolána Yjs na každou změnu Y.Array nebo vnořených Y.Map
  const observer = () => {
    callback(getSnapshot())
  }

  // observeDeep zachytí i nested Y.Map updates (updateObject patches)
  ctx.objects.observeDeep(observer)

  // Inicializační callback se současným stavem
  callback(getSnapshot())

  // Vrátíme unsubscribe
  return () => {
    ctx.objects.unobserveDeep(observer)
  }
}

// ---------------------------------------------------------------------------
// Incremental diff API (M3)
// ---------------------------------------------------------------------------

/**
 * Popis inkrementálních změn od poslední emise.
 * Renderer konzumuje added/removed/updated a aplikuje je surgically.
 */
export interface ObjectChangeSet {
  /** Objekty přidané od poslední emise. Plain form (již konvertované). */
  added: SlideObject[]
  /** Objekty odstraněné od poslední emise. Jen ID. */
  removed: string[]
  /**
   * Objekty co se změnily. ID + patch (jen změněné fields).
   * Pokud bylo více patchů na stejný objekt v jednom frame, jsou sloučeny.
   */
  updated: Array<{ id: string; patch: Partial<SlideObject> }>
  /**
   * Aktuální full snapshot po aplikaci všech changes.
   * Renderer primárně konzumuje added/removed/updated, ale snapshot slouží
   * pro nové subscribery a initial state.
   */
  snapshot: SlideObject[]
  /**
   * P14: ids whose update / add in this batch came from a non-local
   * Y.Doc transaction (i.e. another peer wrote it). Local mutations
   * use `LOCAL_ORIGIN`; everything else (Hocuspocus sync, undo) is
   * treated as remote. Optional — observers that pre-date P14 simply
   * leave it absent. Consumers that care about peer vs self origin
   * (drag lock, presence overlays) read this set; consumers that
   * just want the diff ignore it.
   */
  remoteOriginIds?: ReadonlySet<string>
}

/**
 * Pending batch state — akumulujeme změny mezi rAF ticky.
 *
 * DŮLEŽITÉ: addedObjects ukládá plain SlideObject (ne Y.Map reference), protože
 * Y.Map může být smazán v témže batch (net-zero) a po smazání nelze číst data.
 * Plain object se přečte okamžitě v observer callback před flush.
 */
interface PendingBatch {
  /** Objekty přidané v tomto batch (key = id, value = plain object) */
  addedObjects: Map<string, SlideObject>
  /** IDs objektů odstraněných v tomto batch */
  removedIds: Set<string>
  /** Slučované patche pro updates (key = id, value = sloučený patch) */
  updatedPatches: Map<string, Partial<SlideObject>>
}

function createPendingBatch(): PendingBatch {
  return {
    addedObjects: new Map(),
    removedIds: new Set(),
    updatedPatches: new Map(),
  }
}

function isBatchEmpty(batch: PendingBatch): boolean {
  return (
    batch.addedObjects.size === 0 && batch.removedIds.size === 0 && batch.updatedPatches.size === 0
  )
}

/**
 * @deprecated Use subscribeToSlideObjects() from slideObserve.ts (M9).
 * This subscribes to a root-level objects array — only valid for legacy single-slide docs.
 * Kept for backward compat — removed in M10.
 *
 * Subscribe na incremental changes s per-frame batching (requestAnimationFrame).
 *
 * - Více mutací ve stejném rAF ticku se agregují do jednoho ObjectChangeSet.
 * - Callback se volá jednou per tick, ne per operation.
 * - Initial emission (synchronně po subscribe): { added: current, removed: [], updated: [], snapshot: current }.
 *
 * @returns unsubscribe function
 */
export function subscribeToObjectChanges(
  ctx: MutationContext,
  callback: (changes: ObjectChangeSet) => void,
): () => void {
  const { unsubscribe } = subscribeToObjectChangesWithFlush(ctx, callback)
  return unsubscribe
}

/**
 * @deprecated Use subscribeToSlideObjects() from slideObserve.ts (M9).
 * Kept for backward compat — removed in M10.
 *
 * Varianta s explicit flush (pro testing a SSR).
 * V testech můžeš spustit pending changes synchronně přes flush().
 */
export function subscribeToObjectChangesWithFlush(
  ctx: MutationContext,
  callback: (changes: ObjectChangeSet) => void,
): { unsubscribe: () => void; flush: () => void } {
  // Interní snapshot — udržujeme aktuální stav pro výpočet snapshot field a inicializaci
  // Key = id, value = plain SlideObject
  const currentSnapshot = new Map<string, SlideObject>()
  // Poslední emitovaný order — potřebný pro detekci reorderu uvnitř flush
  // (delete-all + push-all v rámci jednoho rAF ticku vypadá jako net-zero
  //  podle id setu, ale Y.Array pořadí se změní a consumery musí dostat event).
  let lastEmittedOrder: string[] = []

  // Inicializuj snapshot z aktuálního stavu doc
  for (let i = 0; i < ctx.objects.length; i++) {
    const obj = yMapToPlainObject(ctx.objects.get(i))
    currentSnapshot.set(obj.id, obj)
    lastEmittedOrder.push(obj.id)
  }

  // Pending batch — akumulují se zde changes než přijde flush
  let pending: PendingBatch = createPendingBatch()

  // rAF handle — pokud !== -1, je naplánovaný flush
  let rafHandle = -1

  // Re-entrancy guard — pokud právě dispatchujeme, nespouštíme znova
  let dispatching = false

  // Unsubscribed flag
  let unsubscribed = false

  /**
   * Flush pending batch — emituje ObjectChangeSet a čistí pending.
   * Volá se buď z rAF callbacku nebo explicitně pro testy.
   */
  const flush = (): void => {
    // Pokud unsubscribnutý nebo prázdný batch, nic neděláme
    if (unsubscribed || isBatchEmpty(pending)) {
      pending = createPendingBatch()
      rafHandle = -1
      return
    }

    // Re-entrancy guard
    if (dispatching) return
    dispatching = true

    const batchToProcess = pending
    pending = createPendingBatch()
    rafHandle = -1

    // Net-zero resolution:
    // Pokud stejné ID je v addedObjects i removedIds → přidán a hned smazán v jednom frame
    // → net-zero, žádný event, ID odstraníme ze snapshot
    const netAdded: SlideObject[] = []
    const netRemoved: string[] = []
    const netUpdated: Array<{ id: string; patch: Partial<SlideObject> }> = []

    // Zjisti net-zero sety
    const netZeroIds = new Set<string>()
    for (const id of batchToProcess.removedIds) {
      if (batchToProcess.addedObjects.has(id)) {
        // Net-zero: přidán + smazán ve stejném frame
        netZeroIds.add(id)
      }
    }

    // Zpracuj removed (bez net-zero)
    for (const id of batchToProcess.removedIds) {
      if (netZeroIds.has(id)) {
        // Net-zero: odstraň ze snapshot, žádná emise
        currentSnapshot.delete(id)
        continue
      }
      // Skutečné odstranění
      currentSnapshot.delete(id)
      netRemoved.push(id)
    }

    // Zpracuj added (bez net-zero)
    for (const [id, obj] of batchToProcess.addedObjects) {
      if (netZeroIds.has(id)) continue // net-zero, skip
      currentSnapshot.set(id, obj)
      netAdded.push(obj)
      // Pokud byl update na tento objekt v témže batch, přeskočíme —
      // renderer dostane full initial stav v added, patch je redundantní
      batchToProcess.updatedPatches.delete(id)
    }

    // Zpracuj updated — jen pro objekty co nejsou v added/removed/net-zero
    for (const [id, patch] of batchToProcess.updatedPatches) {
      if (batchToProcess.removedIds.has(id)) continue // removed, skip
      if (netZeroIds.has(id)) continue // net-zero, skip

      // Aktualizuj currentSnapshot
      const existing = currentSnapshot.get(id)
      if (existing !== undefined) {
        const updated = { ...existing, ...patch } as SlideObject
        currentSnapshot.set(id, updated)
        netUpdated.push({ id, patch })
      }
    }

    // Compute ordered snapshot z Y.Array (pro správné pořadí)
    const snapshot: SlideObject[] = []
    const currentOrder: string[] = []
    for (let i = 0; i < ctx.objects.length; i++) {
      const id = ctx.objects.get(i).get('id') as string | undefined
      if (id !== undefined) {
        const obj = currentSnapshot.get(id)
        if (obj !== undefined) {
          snapshot.push(obj)
          currentOrder.push(id)
        }
      }
    }

    // P6: detekce čistého reorderu (Y.Array má novou sekvenci id, ale
    // net-zero zjedl added/removed). Layer-order mutations používají
    // delete-all + push-all; bez této detekce consumery (React state +
    // Pixi reconciler) dostanou žádnou notifikaci a UI zůstane stale.
    let orderChanged = currentOrder.length !== lastEmittedOrder.length
    for (let i = 0; !orderChanged && i < currentOrder.length; i++) {
      if (currentOrder[i] !== lastEmittedOrder[i]) orderChanged = true
    }

    // Emituj jen pokud jsou skutečné changes (nebo reorder)
    if (netAdded.length > 0 || netRemoved.length > 0 || netUpdated.length > 0 || orderChanged) {
      callback({
        added: netAdded,
        removed: netRemoved,
        updated: netUpdated,
        snapshot,
      })
      lastEmittedOrder = currentOrder
    }

    dispatching = false
  }

  /**
   * Yjs observeDeep handler — zpracuje events a naplní pending batch.
   */
  const observer = (events: Y.YEvent<Y.AbstractType<unknown>>[]): void => {
    if (unsubscribed) return

    for (const event of events) {
      if (event.target === ctx.objects) {
        // Y.Array event — zpracuj inserty a delety
        processArrayEvent(event as Y.YArrayEvent<Y.Map<unknown>>, pending, currentSnapshot)
      } else if (event.target instanceof Y.Map) {
        // Y.Map event — zpracuj property changes na konkrétním objektu
        processMapEvent(event as Y.YMapEvent<unknown>, pending)
      }
    }

    // Naplánuj flush pokud není naplánovaný a máme changes
    if (rafHandle === -1 && !isBatchEmpty(pending)) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const raf = (globalThis as any).requestAnimationFrame as
        | ((cb: () => void) => number)
        | undefined
      if (raf !== undefined) {
        rafHandle = raf(flush)
      } else {
        // Node / SSR fallback — flush v microtask (testy používají explicitní flush())
        rafHandle = 0 // sentinel aby se neplánoval znova
        Promise.resolve().then(flush)
      }
    }
  }

  ctx.objects.observeDeep(observer)

  // Synchronní initial emission — renderer se napojí + dostane initial state bez race condition
  // Ordering: použij Y.Array pořadí
  const orderedInitial: SlideObject[] = []
  for (let i = 0; i < ctx.objects.length; i++) {
    const id = ctx.objects.get(i).get('id') as string | undefined
    if (id !== undefined) {
      const obj = currentSnapshot.get(id)
      if (obj !== undefined) {
        orderedInitial.push(obj)
      }
    }
  }

  callback({
    added: orderedInitial,
    removed: [],
    updated: [],
    snapshot: orderedInitial,
  })

  const unsubscribe = (): void => {
    unsubscribed = true
    ctx.objects.unobserveDeep(observer)
    // Zruš pending rAF
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const caf = (globalThis as any).cancelAnimationFrame as ((id: number) => void) | undefined
    if (rafHandle !== -1 && caf !== undefined) {
      caf(rafHandle)
    }
    rafHandle = -1
    pending = createPendingBatch()
  }

  return { unsubscribe, flush }
}

// ---------------------------------------------------------------------------
// Delta processors
// ---------------------------------------------------------------------------

/**
 * Zpracuje Y.YArrayEvent — extrahuje přidané a odebrané Y.Map prvky.
 *
 * Pro added: Y.Map je živý v momentě observer volání → přečteme okamžitě jako plain object.
 * Pro deleted: zjistíme ID z currentSnapshot vs aktuálního Y.Array obsahu.
 *
 * PROČ okamžitá konverze pro added:
 * Y.Map může být smazán ve stejném batch (net-zero scénář — add + delete v jednom frame).
 * Po smazání Y.Map.get() vrací undefined → yMapToPlainObject by selhal v flush.
 * Proto konvertujeme okamžitě, dokud je Y.Map živý.
 */
function processArrayEvent(
  event: Y.YArrayEvent<Y.Map<unknown>>,
  pending: PendingBatch,
  currentSnapshot: Map<string, SlideObject>,
): void {
  // ADDED: iterate changes.added — jsou to Item s ContentType(yMap)
  // Y.Map je v tomto momentě živý (observer se volá před GC)
  const added = event.changes.added
  for (const item of added) {
    // item.content je ContentType — content.type je Y.Map
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const content = (item as any).content as { type?: unknown } | undefined
    if (content && content.type instanceof Y.Map) {
      const yMap = content.type as Y.Map<unknown>
      try {
        const obj = yMapToPlainObject(yMap)
        pending.addedObjects.set(obj.id, obj)
      } catch {
        // Pokud Y.Map nemá platný type field, ignorujeme (defenzivní)
      }
    }
  }

  // DELETED: zjistíme která ID zmizela
  // Porovnáme currentSnapshot (stav před tímto batchem) s items označenými jako deleted.
  // Použijeme changes.deleted — jsou to Item s ContentType(yMap), ale Y.Map je smazán.
  // Místo čtení ze smazaného Y.Map použijeme ID z aktuálního Y.Array vs currentSnapshot.
  //
  // Přístup: projdeme changes.deleted a přečteme ID z item.content.type.
  // Smazaný Y.Map stále drží data v Yjs (CRDT je append-only, jen marker deleted=true).
  // Y.Map.get() na smazaném Y.Map stále funguje protože data jsou v _map internals.
  const deleted = event.changes.deleted
  for (const item of deleted) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const content = (item as any).content as { type?: unknown } | undefined
    if (content && content.type instanceof Y.Map) {
      const yMap = content.type as Y.Map<unknown>
      // Pro smazaný Y.Map: přečteme ID přímo z _map (interní Yjs struktura)
      // Bezpečnější alternativa: iteruj přes currentSnapshot a najdi co chybí v Y.Array
      const id = readIdFromDeletedYMap(yMap)
      if (typeof id === 'string') {
        pending.removedIds.add(id)
      }
    }
  }

  // Suppress unused currentSnapshot ref — není přímé použití zde ale je dostupný pro jiné účely
  void currentSnapshot
}

/**
 * Přečte ID z Y.Map. Funguje i pro smazané Y.Map.
 *
 * Yjs Y.Map interně ukládá data v `_map: Map<string, Item>`.
 * Po smazání Y.Map ze Y.Array jsou data stále přístupná přes internal API.
 * Používáme `_map.get('id')?.content.arr[0]` pro přístup k hodnotě.
 *
 * Fallback: pokud interní API není dostupné, vrátíme undefined.
 */
function readIdFromDeletedYMap(yMap: Y.Map<unknown>): string | undefined {
  // Nejprve zkusíme standardní .get() — může fungovat i pro smazané Y.Map
  // (Yjs nemazal data z _map, jen nastavil deleted flag na Item v parent Y.Array)
  try {
    const id = yMap.get('id')
    if (typeof id === 'string') return id
  } catch {
    // Ignorujeme
  }

  // Fallback: přistupuj přes interní _map
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const internalMap = (yMap as any)._map as Map<string, { content: { arr: unknown[] } }> | undefined
  if (internalMap !== undefined) {
    const idItem = internalMap.get('id')
    if (idItem !== undefined) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const arr = (idItem as any).content?.arr as unknown[] | undefined
      if (Array.isArray(arr) && arr.length > 0) {
        const val = arr[arr.length - 1]
        if (typeof val === 'string') return val
      }
    }
  }

  return undefined
}

/**
 * Zpracuje Y.YMapEvent — extrahuje property changes z Y.Map.
 * Parent Y.Map je konkrétní objekt — získáme ID a keys.
 */
function processMapEvent(event: Y.YMapEvent<unknown>, pending: PendingBatch): void {
  const yMap = event.target as Y.Map<unknown>
  const id = yMap.get('id')

  if (typeof id !== 'string') return

  // keys() vrací Map<string, {action, oldValue}> — iteruj a sbírej nové hodnoty
  const changedKeys = event.keys
  const patch: Record<string, unknown> = {}

  for (const [key] of changedKeys) {
    // 'id' a 'type' jsou immutable — skipni
    if (key === 'id' || key === 'type') continue
    patch[key] = yMap.get(key)
  }

  if (Object.keys(patch).length === 0) return

  // Sloučit s existujícím patchem pro tento objekt (coalescing)
  const existing = pending.updatedPatches.get(id)
  if (existing !== undefined) {
    pending.updatedPatches.set(id, { ...existing, ...patch } as Partial<SlideObject>)
  } else {
    pending.updatedPatches.set(id, patch as Partial<SlideObject>)
  }
}
