/**
 * `EditorService` — defined here, implemented by apps/server/src/services/editor.ts.
 * See ../services.ts for the pattern.
 *
 * The bridge between an agent and the calling user's OPEN editors on a deck:
 * what they are looking at (their awareness state) and pointing them at
 * something (a Hocuspocus stateless message). Nothing here writes the
 * document.
 */

/** One open editor (one browser tab) of the calling user on the deck. */
export interface OpenEditorState {
  /** The slide the tab shows, or null when the tab did not report one (older client). */
  activeSlideId: string | null
  /** 0-based position of that slide in the deck, when it still exists. */
  activeSlideIndex: number | null
  /** Objects selected in that tab (ids on the active slide). */
  selectedObjectIds: string[]
  /** ISO time of the tab's last awareness update. */
  lastActiveAt: string
}

export interface EditorContextArgs {
  userId: string
  deckId: string
}

export interface EditorShowArgs {
  userId: string
  deckId: string
  slideId: string
  objectIds: string[]
  /** The agent run that asked, when there is one (lets the editor say who pointed it there). */
  runId?: string
}

export interface PresentUrlArgs {
  deckId: string
  /** 1-based slide number, as shown to people. */
  slideNumber: number
}

/**
 * The stateless message `editor.show` sends to the user's open editors
 * (JSON-encoded as the Hocuspocus stateless payload). The web client
 * switches to `slideId` and temporarily highlights `objectIds`; it never
 * writes the document.
 */
export interface EditorShowMessage {
  type: 'narrative.editor.show'
  slideId: string
  objectIds: string[]
  runId?: string
}

export const EDITOR_SHOW_MESSAGE_TYPE = 'narrative.editor.show'

export interface EditorService {
  /** The calling user's open editors on the deck, most recently active first. Empty when none is open. */
  context(args: EditorContextArgs): Promise<OpenEditorState[]>
  /** Point the calling user's open editors at a slide/objects. Returns how many tabs received it. */
  show(args: EditorShowArgs): Promise<{ delivered: number }>
  /** Absolute URL of present mode on the deck, starting at the given slide. */
  presentUrl(args: PresentUrlArgs): string
}
