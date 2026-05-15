/**
 * ui/AlignButtonGroup.tsx
 *
 * Generic icon-button group for alignment / case / any small option
 * set with a single-select state. Extracted from `Inspector.tsx` so
 * the table inspector (and any future inspector) can reuse the exact
 * same look — borderless pill row, single primary highlight for the
 * active option, lucide-react icons.
 */

import type { LucideIcon } from 'lucide-react'

export interface AlignButtonGroupProps<V extends string> {
  value: V
  onChange: (value: V) => void
  ariaLabel: string
  options: ReadonlyArray<{
    value: V
    label: string
    Icon: LucideIcon
  }>
  disabled?: boolean
}

export function AlignButtonGroup<V extends string>({
  value,
  onChange,
  ariaLabel,
  options,
  disabled = false,
}: AlignButtonGroupProps<V>) {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className="flex flex-1 items-stretch overflow-hidden rounded-md border border-input field-surface"
    >
      {options.map(({ value: v, label, Icon }, idx) => {
        const active = v === value
        return (
          <button
            key={v}
            type="button"
            aria-label={label}
            aria-pressed={active}
            title={label}
            disabled={disabled}
            onClick={() => onChange(v)}
            className={[
              'flex flex-1 items-center justify-center px-2 py-1 transition-colors',
              idx > 0 ? 'border-l border-input' : '',
              active
                ? 'bg-primary/15 text-primary'
                : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
              'disabled:opacity-40 disabled:hover:bg-transparent',
            ].join(' ')}
          >
            <Icon className="h-3.5 w-3.5" aria-hidden />
          </button>
        )
      })}
    </div>
  )
}
