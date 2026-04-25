/**
 * ui/SlideRowContextMenu.tsx
 *
 * P11: Right-click context menu for a slide row in the SlidesPanel.
 *
 * Items:
 *  - Rename
 *  - Duplicate
 *  - Delete
 *  - Skip in present (toggle — backed by slide.skipped boolean)
 *  - Separator
 *  - Add section above (disabled — no schema for sections in this sprint, see P12)
 *  - Move to section (disabled — no schema for sections in this sprint)
 *
 * Callbacks reuse the existing handlers from SlidesPanel (handleDuplicate,
 * handleDelete, handleRename, handleToggleSkip) passed as props.
 *
 * Usage:
 *   <SlideRowContextMenu
 *     slideId={slide.id}
 *     skipped={slide.skipped === true}
 *     onRename={() => setEditing(true)}
 *     onDuplicate={handleDuplicate}
 *     onDelete={handleDelete}
 *     onToggleSkip={handleToggleSkip}
 *   >
 *     {children}  ← the slide thumbnail card
 *   </SlideRowContextMenu>
 */

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'

interface SlideRowContextMenuProps {
  slideId: string
  skipped: boolean
  readOnly?: boolean
  onRename: (id: string) => void
  onDuplicate: (id: string) => void
  onDelete: (id: string) => void
  onToggleSkip: (id: string) => void
  children: React.ReactNode
}

export function SlideRowContextMenu({
  slideId,
  skipped,
  readOnly = false,
  onRename,
  onDuplicate,
  onDelete,
  onToggleSkip,
  children,
}: SlideRowContextMenuProps) {
  if (readOnly) {
    // Viewer role — no context menu, render children as-is.
    return <>{children}</>
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger style={{ display: 'contents' }}>{children}</ContextMenuTrigger>

      <ContextMenuContent className="w-48">
        <ContextMenuItem onSelect={() => onRename(slideId)}>Rename</ContextMenuItem>
        <ContextMenuItem onSelect={() => onDuplicate(slideId)}>Duplicate</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => onToggleSkip(slideId)}>
          {skipped ? 'Unskip in present' : 'Skip in present'}
        </ContextMenuItem>
        <ContextMenuSeparator />
        {/* Sections are not yet in the schema — disabled with a comment */}
        <ContextMenuItem disabled title="Sections not yet implemented (P12)">
          Add section above
        </ContextMenuItem>
        <ContextMenuItem disabled title="Sections not yet implemented (P12)">
          Move to section
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          onSelect={() => onDelete(slideId)}
          className="text-destructive focus:text-destructive"
        >
          Delete
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
