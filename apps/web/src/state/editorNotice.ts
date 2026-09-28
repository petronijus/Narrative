/**
 * state/editorNotice.ts — one short message the editor shows over the
 * canvas for a few seconds (a paste that could not be done, …): for
 * gestures that fail after the fact, where no dialog or panel is open to
 * carry the error. `EditorNotice` renders it.
 */

import { useSyncExternalStore } from 'react'

const SHOW_MS = 5_000

let current: { id: number; message: string } | null = null
let nextId = 1
let timer: ReturnType<typeof setTimeout> | null = null
const listeners = new Set<() => void>()

function emit(): void {
  for (const l of listeners) l()
}

/** Show `message` for a few seconds, replacing whatever was showing. */
export function showEditorNotice(message: string): void {
  current = { id: nextId++, message }
  if (timer !== null) clearTimeout(timer)
  timer = setTimeout(() => {
    current = null
    timer = null
    emit()
  }, SHOW_MS)
  emit()
}

export function dismissEditorNotice(): void {
  if (timer !== null) clearTimeout(timer)
  timer = null
  current = null
  emit()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useEditorNotice(): { id: number; message: string } | null {
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => null,
  )
}
