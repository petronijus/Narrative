/**
 * ui/ShortcutsCheatsheet.tsx
 *
 * P9: Keyboard shortcuts cheatsheet modal.
 *
 * Triggered by Mod+/ (registered as a global shortcut in EditorLayout /
 * PresentLayout via useShortcuts). Lists all currently-registered shortcuts
 * grouped by scope, with key combo chips + description.
 *
 * Uses the shadcn Dialog primitive. The cheatsheet reads the registry
 * snapshot at open time via `getRegisteredShortcuts()` — no reactive
 * subscription needed since the list only changes on component mount/unmount
 * which can't happen while the modal is open.
 */

import { useEffect, useState } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  getRegisteredShortcuts,
  formatKeyCombo,
  type CheatsheetEntry,
  type ShortcutScope,
} from '../state/useShortcuts.js'

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface ShortcutsCheatsheetProps {
  open: boolean
  onClose: () => void
}

// ---------------------------------------------------------------------------
// Scope labels
// ---------------------------------------------------------------------------

const SCOPE_LABELS: Record<ShortcutScope, string> = {
  global: 'Global',
  canvas: 'Canvas',
  slidePanel: 'Slide Panel',
  timeline: 'Timeline',
}

const SCOPE_ORDER: ShortcutScope[] = ['global', 'canvas', 'slidePanel', 'timeline']

// ---------------------------------------------------------------------------
// Key chip
// ---------------------------------------------------------------------------

function KeyChip({ combo }: { combo: string }) {
  return (
    <kbd className="inline-flex min-w-[1.5rem] items-center justify-center rounded border border-border bg-surface-2 px-1.5 py-0.5 font-mono text-[11px] leading-none text-foreground/80 shadow-[inset_0_-1px_0_hsl(var(--border))]">
      {formatKeyCombo(combo)}
    </kbd>
  )
}

function KeyCombos({ keys }: { keys: string | string[] }) {
  const arr = Array.isArray(keys) ? keys : [keys]
  return (
    <span className="flex flex-wrap gap-1">
      {arr.map((combo, i) => (
        <span key={combo} className="flex items-center gap-1">
          {i > 0 && <span className="text-[10px] text-muted-foreground/60">or</span>}
          <KeyChip combo={combo} />
        </span>
      ))}
    </span>
  )
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ShortcutsCheatsheet({ open, onClose }: ShortcutsCheatsheetProps) {
  // Snapshot the registry every time the dialog opens.
  const [entries, setEntries] = useState<CheatsheetEntry[]>([])

  useEffect(() => {
    if (open) {
      setEntries(getRegisteredShortcuts())
    }
  }, [open])

  // Group by scope.
  const byScope = new Map<ShortcutScope, CheatsheetEntry[]>()
  for (const entry of entries) {
    const existing = byScope.get(entry.scope)
    if (existing === undefined) {
      byScope.set(entry.scope, [entry])
    } else {
      existing.push(entry)
    }
  }

  const sections = SCOPE_ORDER.filter((scope) => byScope.has(scope))

  return (
    <Dialog
      open={open}
      onOpenChange={(isOpen) => {
        if (!isOpen) onClose()
      }}
    >
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Keyboard Shortcuts</DialogTitle>
        </DialogHeader>

        {sections.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground">No shortcuts registered.</p>
        ) : (
          <div className="flex flex-col gap-6 pt-2">
            {sections.map((scope) => {
              const sectionEntries = byScope.get(scope)!
              return (
                <section key={scope}>
                  <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                    {SCOPE_LABELS[scope]}
                  </h3>
                  <div className="flex flex-col gap-1">
                    {sectionEntries.map((entry, i) => (
                      <div
                        key={i}
                        className="flex items-center justify-between gap-4 rounded px-2 py-1.5 hover:bg-surface-2/60"
                      >
                        <span className="text-sm text-foreground/90">{entry.description}</span>
                        <KeyCombos keys={entry.keys} />
                      </div>
                    ))}
                  </div>
                </section>
              )
            })}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
