/**
 * state/useObjectClipboard.ts — copy, cut and paste of canvas objects
 * through commands (ADR 0010). The clipboard itself (what was copied, and
 * how it read) is state/clipboard.ts; this hook decides how a paste is
 * done:
 *
 *   - same document and the sources still there: `object.copyTo`, an exact
 *     copy of the live objects;
 *   - same document, sources gone (cut, or deleted since): `object.insert`
 *     from the snapshot;
 *   - another document — a deck, or a component master, in either
 *     direction: the server's `object.insertFromDeck`, which copies the
 *     pictures and videos into this document (a deck and a master each own
 *     their media), the fonts between decks, and rebinds tokens (a remote
 *     change for this editor, like the slides panel's cross-deck paste).
 *
 * A paste that cannot be done tells the user why (EditorNotice).
 */

import { useCallback } from 'react'
import { CommandError, planInsert } from '@narrative/commands'
import { ApiError, useApi, type DocumentRef } from '../api/client.js'
import { useActiveSlide } from './ActiveSlideContext.js'
import { useCommand } from './useCommand.js'
import { useSlideDoc } from './useSlideDoc.js'
import { readClipboard, setClipboard, hasClipboard } from './clipboard.js'
import { showEditorNotice } from './editorNotice.js'

export type PastePlacement = { offset: { x: number; y: number } } | { at: { x: number; y: number } }

export interface ObjectClipboardActions {
  /** Remember `ids` of the active slide as copied (or cut: the caller deletes them). */
  copy: (ids: ReadonlyArray<string>, opts?: { cut?: boolean }) => boolean
  /** Paste onto the active slide; resolves to the new object ids, or null when nothing was pasted. */
  paste: (placement: PastePlacement) => Promise<string[] | null>
  canPaste: () => boolean
}

/** The document a clipboard key names: a deck id, or `component:<id>` for a master. */
function documentOf(key: string): DocumentRef {
  return key.startsWith('component:')
    ? { componentId: key.slice('component:'.length) }
    : { deckId: key }
}

function pasteFailure(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 403)
      return 'You can only view the deck these objects come from, so they cannot be copied out of it.'
    if (err.status === 404)
      return 'The deck or component these objects come from no longer exists, or is not yours.'
    return `The objects could not be pasted: ${err.message}`
  }
  if (err instanceof CommandError) return `The objects could not be pasted: ${err.message}`
  return 'The objects could not be pasted. Check your connection and try again.'
}

export function useObjectClipboard(): ObjectClipboardActions {
  const command = useCommand()
  const api = useApi()
  const { documentKey } = useSlideDoc()
  const { activeSlideId } = useActiveSlide()
  const here = documentKey

  const copy = useCallback<ObjectClipboardActions['copy']>(
    (ids, opts) => {
      if (activeSlideId === null || ids.length === 0) return false
      const slide = command.run<{ objects: Array<Record<string, unknown>> }>('query.slide', {
        slide: activeSlideId,
      })
      const wanted = new Set(ids)
      const objects = slide.objects.filter((o) => wanted.has(o['id'] as string))
      if (objects.length === 0) return false
      if (opts?.cut === true) {
        // After a cut the snapshot is all a paste has: refuse a cut it could
        // not paste back (an imported object outside today's rules), rather
        // than delete what could only come back through undo.
        try {
          planInsert(objects, {})
        } catch (err) {
          showEditorNotice(
            `These objects cannot be cut (${err instanceof Error ? err.message : 'not pastable'}). Copy them instead.`,
          )
          return false
        }
      }
      setClipboard({
        deckId: here,
        slideId: activeSlideId,
        objectIds: objects.map((o) => o['id'] as string),
        cut: opts?.cut === true,
        objects,
      })
      return true
    },
    [activeSlideId, command, here],
  )

  const paste = useCallback<ObjectClipboardActions['paste']>(
    async (placement) => {
      const clip = readClipboard()
      if (clip === null || activeSlideId === null) return null
      try {
        if (clip.deckId === here) {
          if (!clip.cut) {
            try {
              const out = command.run<{ objectIds: string[] }>('object.copyTo', {
                slide: clip.slideId,
                objects: clip.objectIds,
                toSlide: activeSlideId,
                ...placement,
              })
              return out.objectIds
            } catch (err) {
              // The sources (or their slide) are gone: paste what was read.
              if (!(err instanceof CommandError && err.code === 'not_found')) throw err
            }
          }
          return command.run<{ objectIds: string[] }>('object.insert', {
            slide: activeSlideId,
            objects: clip.objects,
            ...placement,
          }).objectIds
        }
        const out = await api.insertObjectsFrom(documentOf(here), {
          source: documentOf(clip.deckId),
          slideId: activeSlideId,
          objects: clip.objects,
          ...placement,
        })
        return out.objectIds
      } catch (err) {
        console.warn('[paste] failed', err)
        showEditorNotice(pasteFailure(err))
        return null
      }
    },
    [activeSlideId, api, command, here],
  )

  return { copy, paste, canPaste: hasClipboard }
}
