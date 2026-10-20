/**
 * ui/presenterNotesStyle.ts — what the presenter view's notes box and its
 * lazily loaded rich view (`PresenterNotes.tsx`) share, kept out of that
 * chunk so the stand-in in `PresenterOverlay.tsx` draws the same box.
 */

import type * as Y from 'yjs'

export interface PresenterNotesProps {
  /** The slide's notes fragment (y-prosemirror binds the read-only editor to it). */
  fragment: Y.XmlFragment
  /** The same notes as plain text: the stand-in shows them while the editor loads. */
  text: string
}

export const PRESENTER_NOTES_CLASS = [
  'tiptap-notes-preview prose prose-invert prose-sm max-w-none',
  'flex-1 overflow-auto whitespace-pre-wrap break-words rounded border border-gray-800 bg-gray-900/60 p-2',
  'text-gray-100 leading-snug',
  '[&_p]:my-1 [&_h1]:text-sm [&_h2]:text-sm [&_h3]:text-xs',
  '[&_ul]:list-disc [&_ul]:pl-4 [&_ol]:list-decimal [&_ol]:pl-4',
  '[&_blockquote]:border-l-2 [&_blockquote]:border-gray-700 [&_blockquote]:pl-2 [&_blockquote]:italic',
  '[&_code]:rounded [&_code]:bg-gray-800 [&_code]:px-1',
  '[&_strong]:font-semibold',
  '[&_em]:italic',
].join(' ')
