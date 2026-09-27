/**
 * `ComponentService` — defined here, implemented by apps/server/src/services/components.ts.
 * See ../services.ts for the pattern: the /folders/:id/components and
 * /components/:id routes and the `component.*` commands call these methods.
 *
 * A component is folder-scoped: only the folder's owner may read or change
 * it. Its master is a Yjs document named `component:<id>` with the deck
 * schema and exactly one slide (see slide-model/src/stampComponent.ts).
 */

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
   * Authorise opening `component:<id>` as a document (how an agent edits a
   * master with the ordinary document commands). Throws `not_found` /
   * `forbidden`; on success returns the folder and the role (always owner).
   */
  access(args: {
    userId: string
    componentId: string
  }): Promise<{ componentId: string; folderId: string; role: 'owner'; documentName: string }>
}
