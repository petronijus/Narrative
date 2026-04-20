/**
 * ui/SlideItemMenu.tsx
 *
 * Three-dot context menu for a slide item in the slides panel (M9).
 *
 * Items:
 * - Duplicate slide
 * - Delete slide
 * - Transition settings (activates the slide → Inspector shows transition section)
 *
 * Implemented as a minimal floating popover using React state + useEffect for
 * outside-click dismiss. No library dependency.
 *
 * Accessibility: button has aria-label + aria-expanded; menu has role="menu".
 */

import { useRef, useState, useEffect, useCallback, useId } from 'react'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SlideItemMenuProps {
  slideId: string
  onDuplicate: (id: string) => void
  onDelete: (id: string) => void
  onTransition: (id: string) => void
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function SlideItemMenu({
  slideId,
  onDuplicate,
  onDelete,
  onTransition,
}: SlideItemMenuProps): JSX.Element {
  const [open, setOpen] = useState(false)
  const menuId = useId()
  const buttonRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  // Close on outside click / focus loss
  useEffect(() => {
    if (!open) return

    function handlePointerDown(e: PointerEvent) {
      const button = buttonRef.current
      const menu = menuRef.current
      if (button !== null && button.contains(e.target as Node)) return
      if (menu !== null && menu.contains(e.target as Node)) return
      setOpen(false)
    }

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setOpen(false)
        buttonRef.current?.focus()
      }
    }

    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [open])

  // Focus first menu item on open
  useEffect(() => {
    if (!open) return
    const menu = menuRef.current
    if (menu === null) return
    const firstItem = menu.querySelector('[role="menuitem"]') as HTMLElement | null
    firstItem?.focus()
  }, [open])

  const toggle = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    setOpen((prev) => !prev)
  }, [])

  const close = useCallback(() => setOpen(false), [])

  const handleDuplicate = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      close()
      onDuplicate(slideId)
    },
    [slideId, onDuplicate, close],
  )

  const handleDelete = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      close()
      onDelete(slideId)
    },
    [slideId, onDelete, close],
  )

  const handleTransition = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      close()
      onTransition(slideId)
    },
    [slideId, onTransition, close],
  )

  // Keyboard navigation inside menu
  function handleMenuKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]'))
    const focused = document.activeElement as HTMLElement
    const currentIndex = items.indexOf(focused)

    if (e.key === 'ArrowDown') {
      e.preventDefault()
      const next = items[(currentIndex + 1) % items.length]
      next?.focus()
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      const prev = items[(currentIndex - 1 + items.length) % items.length]
      prev?.focus()
    } else if (e.key === 'Tab') {
      // Trap focus inside menu
      e.preventDefault()
    }
  }

  const ITEM_CLASS = [
    'flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-gray-300',
    'hover:bg-gray-700 hover:text-gray-100',
    'focus-visible:bg-gray-700 focus-visible:text-gray-100 focus-visible:outline-none',
    'transition-colors',
  ].join(' ')

  return (
    // data-slide-menu attribute used by SlidesPanel to skip drag initiation on menu target
    <div data-slide-menu className="relative" onClick={(e) => e.stopPropagation()}>
      <button
        ref={buttonRef}
        type="button"
        aria-label="Slide options"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        onClick={toggle}
        className={[
          'flex h-5 w-5 items-center justify-center rounded text-gray-500',
          'opacity-0 group-hover:opacity-100 focus-visible:opacity-100',
          'hover:bg-gray-700 hover:text-gray-300',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500',
          'transition-all',
        ].join(' ')}
      >
        <svg aria-hidden="true" width="12" height="12" viewBox="0 0 12 12" fill="currentColor">
          <circle cx="6" cy="2" r="1.2" />
          <circle cx="6" cy="6" r="1.2" />
          <circle cx="6" cy="10" r="1.2" />
        </svg>
      </button>

      {open && (
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          aria-label="Slide options"
          onKeyDown={handleMenuKeyDown}
          className={[
            'absolute right-0 top-6 z-50 min-w-36 rounded border border-gray-700',
            'bg-gray-800 py-1 shadow-lg',
          ].join(' ')}
        >
          <button type="button" role="menuitem" onClick={handleDuplicate} className={ITEM_CLASS}>
            Duplicate
          </button>
          <button type="button" role="menuitem" onClick={handleTransition} className={ITEM_CLASS}>
            Transition settings
          </button>
          <div className="my-1 border-t border-gray-700" role="separator" />
          <button
            type="button"
            role="menuitem"
            onClick={handleDelete}
            className={[
              ITEM_CLASS,
              'text-red-400 hover:text-red-300 focus-visible:text-red-300',
            ].join(' ')}
          >
            Delete
          </button>
        </div>
      )}
    </div>
  )
}
