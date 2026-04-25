/**
 * state/TextEditContext.tsx
 *
 * P7: which text object is currently in inline-edit mode, if any.
 * One object at a time — double-clicking a second text object ends
 * editing on the first.
 *
 * Not persisted to Y.Doc — purely ephemeral editor chrome state.
 */

import { createContext, useCallback, useContext, useState } from 'react'

export interface TextEditContextValue {
  editingId: string | null
  beginEdit: (id: string) => void
  endEdit: () => void
}

const TextEditContext = createContext<TextEditContextValue | null>(null)

export function TextEditProvider({ children }: { children: React.ReactNode }) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const beginEdit = useCallback((id: string) => setEditingId(id), [])
  const endEdit = useCallback(() => setEditingId(null), [])
  return (
    <TextEditContext.Provider value={{ editingId, beginEdit, endEdit }}>
      {children}
    </TextEditContext.Provider>
  )
}

export function useTextEdit(): TextEditContextValue {
  const ctx = useContext(TextEditContext)
  if (ctx === null) throw new Error('useTextEdit: missing TextEditProvider')
  return ctx
}
