/**
 * ui/PresenterNotes.tsx — the presenter view's speaker notes as rich text: a
 * read-only Tiptap editor on the slide's notes fragment, rendering the same
 * headings, lists and emphasis the notes editor produced (without the XML-ish
 * serialisation a plain preview would show).
 *
 * A chunk of its own (Tiptap, ProseMirror), loaded by `PresenterOverlay.tsx`
 * through `lazyPart`.
 */

import { EditorContent, useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Collaboration from '@tiptap/extension-collaboration'
import { PRESENTER_NOTES_CLASS, type PresenterNotesProps } from './presenterNotesStyle.js'

export function PresenterNotes({ fragment }: PresenterNotesProps) {
  const editor = useEditor(
    {
      extensions: [
        StarterKit.configure({ undoRedo: false }),
        Collaboration.configure({ fragment }),
      ],
      editable: false,
      editorProps: {
        attributes: {
          class: PRESENTER_NOTES_CLASS,
          'aria-label': 'Speaker notes (read-only)',
        },
      },
    },
    [fragment],
  )
  return <EditorContent editor={editor} />
}
