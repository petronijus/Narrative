/**
 * lib/utils.ts
 *
 * Shared UI helpers, following the shadcn/ui convention.
 *
 * `cn()` merges conditional class strings and dedupes Tailwind classes so
 * later args win (e.g. `cn('p-2', 'p-4') → 'p-4'`). Every shadcn/ui
 * component imports it from this path.
 */

import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
