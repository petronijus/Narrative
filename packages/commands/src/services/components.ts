/**
 * `ComponentService` — defined here, implemented by apps/server/src/services/components.ts.
 * See ../services.ts for the pattern: the /folders/:id/components and
 * /components/:id routes and the `component.*` commands call these methods.
 *
 * A component is folder-scoped: only the folder's owner may read or change
 * it. Its master is a Yjs document named `component:<id>` with the deck
 * schema and exactly one slide (see slide-model/src/stampComponent.ts).
 */

import type { SlideRef } from '../refs.js'

export interface ComponentRecord {
  id: string
  folderId: string
  name: string
  thumbnailKey: string | null
  thumbnailUrl: string | null
  createdAt: string
  updatedAt: string
}

export interface ComponentMaster {
  component: ComponentRecord
  /**
   * `Y.encodeStateAsUpdate` of the master document — the live copy when an
   * editor has it open, else the stored one. Apply it to a fresh `Y.Doc`.
   */
  state: Uint8Array
}

/** What `component.promote` made. */
export interface PromotedComponent {
  component: ComponentRecord
  /** Objects in the master (a promoted group brings its members). */
  objectCount: number
  /** Pictures and videos copied into the component (it owns its media). */
  mediaCopied: number
  /** Pictures whose file could not be copied (the source file is gone). */
  skippedImages: number
  /** Links to slides of the deck (removed: a master has no slides to jump to). */
  droppedLinks: number
}

/**
 * A master staged for stamping into a deck: its pictures and videos are
 * copied into the deck (registered as the deck's media) and `master` points
 * at the copies. Stamp from `master`; call `discard` when the stamp will not
 * be written, so the copies do not stay behind.
 */
export interface PreparedStamp {
  master: ComponentMaster
  /** Media rows registered for the deck. */
  mediaRegistered: number
  /** Pictures whose file could not be copied. */
  skippedImages: number
  discard(): Promise<void>
}

export interface ComponentService {
  list(args: { userId: string; folderId: string }): Promise<ComponentRecord[]>
  rename(args: {
    userId: string
    componentId: string
    name: string
    folderId?: string | undefined
  }): Promise<ComponentRecord>
  /** Delete the master. Objects already stamped from it are untouched (stamps are detached copies). */
  delete(args: {
    userId: string
    componentId: string
    folderId?: string | undefined
  }): Promise<void>
  /**
   * Read a master. With `folderId` the component must live in that folder;
   * with `deckId` it must live in the deck's folder (a deck stamps only its
   * own folder's components). The user must own the component's folder.
   */
  readMaster(args: {
    userId: string
    componentId: string
    folderId?: string | undefined
    deckId?: string | undefined
  }): Promise<ComponentMaster>
  /**
   * Make a new component of the deck's folder from objects on one of the
   * deck's slides: the objects (groups with their members, rich text,
   * animations of the subtree) become the master, the pictures and videos
   * they show are copied into the component, and links to the deck's
   * slides are removed. The slide is not changed. The deck must live in a
   * folder the user owns.
   */
  promote(args: {
    userId: string
    deckId: string
    slide: SlideRef
    objects: readonly string[]
    name: string
  }): Promise<PromotedComponent>
  /**
   * `readMaster` with the deck's rule, and the master's media copied into
   * the deck — see {@link PreparedStamp}.
   */
  prepareStamp(args: {
    userId: string
    componentId: string
    deckId: string
  }): Promise<PreparedStamp>
  /**
   * Authorise opening `component:<id>` as a document (how an agent edits a
   * master with the ordinary document commands). Throws `not_found` /
   * `forbidden`; on success returns the folder and the role (always owner).
   */
  access(args: {
    userId: string
    componentId: string
  }): Promise<{ componentId: string; folderId: string; role: 'owner'; documentName: string }>
}
