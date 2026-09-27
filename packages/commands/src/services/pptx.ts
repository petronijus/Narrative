/**
 * `PptxService` — defined here, implemented by apps/server/src/services/pptx.ts.
 * See ../services.ts for the pattern: the PowerPoint import / append / export
 * routes, the tus .pptx path and the `deck.importPptx` / `deck.insertFrom` /
 * `deck.exportPptx` commands share these implementations.
 */

import type { DeckMutationContext } from '@narrative/slide-model'
import type { BinarySource } from './common.js'

export interface ImportPptxResult {
  deckId: string
  slideCount: number
  objectsCreated: number
  skipped: { images: number; unknownShapes: number; fonts: number }
  ignoredElements: string[]
  slideWidth: number
  slideHeight: number
  embeddedFontCount: number
  referencedFontFamilies: string[]
}

/** Where `deck.insertFrom` takes slides from. */
export type SlideInsertSource =
  | { kind: 'pptx'; file: BinarySource }
  | {
      kind: 'deck'
      deckId: string
      /** 0-based, inclusive range of source slides; `from` defaults to 0, `to` to the last slide. */
      range?: { from?: number | undefined; to?: number | undefined } | undefined
    }

export interface SlideInsertResult {
  /** Ids of the inserted slides, in order. */
  slideIds: string[]
  /** Index the first inserted slide took (after clamping to the deck's length). */
  insertedAt: number
  objectsCreated: number
  /** Media rows registered for the target deck (copied from the source deck, or extracted from the file). */
  mediaRegistered: number
  /** What the source had that could not be carried over. */
  skipped: { images: number; unknownShapes: number }
  ignoredElements: string[]
  /**
   * Deck sources in another folder: what happened to the copied slides'
   * token references (the rule of `deck.moveToFolder`, see TokenRebindReport).
   */
  tokens?: { rebound: number; literalised: number; detached: number; unmatched: number }
  /** Deck sources: slide links to source slides that were not copied (removed). */
  droppedLinks?: number
}

/**
 * Slides staged for insertion: everything asynchronous (parsing, reading the
 * source deck, storing and registering media under the target deck) is done;
 * `apply` writes the slides synchronously into the target deck document —
 * inside the host's one transaction — and returns what it did.
 */
export interface PreparedSlideInsert {
  slideCount: number
  apply(deck: DeckMutationContext, at?: number): SlideInsertResult
  /**
   * Release what staging registered when `apply` will not run (the document
   * write failed validation). Safe to call only if `apply` never ran.
   */
  discard(): Promise<void>
}

export type PptxExportResult =
  | {
      delivery: 'url'
      filename: string
      sizeBytes: number
      slideCount: number
      /** Presigned download URL; valid until `expiresAt`. */
      url: string
      expiresAt: string
    }
  | {
      delivery: 'base64'
      filename: string
      sizeBytes: number
      slideCount: number
      base64: string
    }

export interface PptxService {
  /** Import a .pptx as a new deck in a folder the user owns. */
  importPptx(args: {
    userId: string
    folderId: string
    source: BinarySource
    title?: string | undefined
  }): Promise<ImportPptxResult>
  /**
   * Stage slides from a .pptx or from another deck the user can read, for
   * insertion into `deckId` (the caller holds editor access to it).
   */
  prepareInsert(args: {
    userId: string
    deckId: string
    source: SlideInsertSource
  }): Promise<PreparedSlideInsert>
  /**
   * Export the deck as .pptx from its LIVE document (what open editors see
   * now, not the last saved snapshot).
   */
  exportPptx(args: {
    userId: string
    deckId: string
    delivery: 'url' | 'base64'
  }): Promise<PptxExportResult>
}
