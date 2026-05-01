/**
 * state/defaultTokens.ts
 *
 * Default design-system tokens seeded into a folder Y.Doc the first time
 * it loads with both `colors` and `textStyles` empty.
 *
 * The palette is intentionally curated (24 colors max) so a fresh folder
 * starts usable without overwhelming the picker.
 *
 * Text styles reference color tokens by id — the seeder writes colors
 * first, captures their generated ids, then writes the text styles with
 * `{ $token: 'colors.<id>' }` color refs.
 */

export const MAX_COLORS = 24

export interface DefaultColor {
  /** Stable key — used inside the seeder to wire text-style color refs. */
  key: string
  name: string
  value: string
}

/**
 * 24 colors total: 6 brand, 8 neutral, 4 semantic, 6 accent.
 * Hex values follow tailwind palette numbering as a familiar baseline.
 */
export const DEFAULT_COLORS: DefaultColor[] = [
  // Brand (6)
  { key: 'brand-50', name: 'Brand 50', value: '#eff6ff' },
  { key: 'brand-100', name: 'Brand 100', value: '#dbeafe' },
  { key: 'brand-300', name: 'Brand 300', value: '#93c5fd' },
  { key: 'brand-500', name: 'Brand 500', value: '#3b82f6' },
  { key: 'brand-700', name: 'Brand 700', value: '#1d4ed8' },
  { key: 'brand-900', name: 'Brand 900', value: '#1e3a8a' },
  // Neutral (8)
  { key: 'neutral-0', name: 'White', value: '#ffffff' },
  { key: 'neutral-50', name: 'Neutral 50', value: '#f8fafc' },
  { key: 'neutral-100', name: 'Neutral 100', value: '#f1f5f9' },
  { key: 'neutral-300', name: 'Neutral 300', value: '#cbd5e1' },
  { key: 'neutral-500', name: 'Neutral 500', value: '#64748b' },
  { key: 'neutral-700', name: 'Neutral 700', value: '#334155' },
  { key: 'neutral-900', name: 'Neutral 900', value: '#0f172a' },
  { key: 'neutral-1000', name: 'Black', value: '#000000' },
  // Semantic (4)
  { key: 'success', name: 'Success', value: '#22c55e' },
  { key: 'warning', name: 'Warning', value: '#f59e0b' },
  { key: 'danger', name: 'Danger', value: '#ef4444' },
  { key: 'info', name: 'Info', value: '#06b6d4' },
  // Accent (6)
  { key: 'accent-violet', name: 'Violet', value: '#8b5cf6' },
  { key: 'accent-pink', name: 'Pink', value: '#ec4899' },
  { key: 'accent-teal', name: 'Teal', value: '#14b8a6' },
  { key: 'accent-orange', name: 'Orange', value: '#f97316' },
  { key: 'accent-lime', name: 'Lime', value: '#84cc16' },
  { key: 'accent-warm-gray', name: 'Warm gray', value: '#a3a3a3' },
]

export interface DefaultTextStyle {
  name: string
  family: string
  weight: number
  size: number
  lineHeight: number
  letterSpacing: number
  /** Key into DEFAULT_COLORS — resolved to a TokenRef during seeding. */
  colorKey: string
}

/**
 * 8 standard text styles spanning a typographic scale.
 * `letterSpacing` is in em units (negative = tighter).
 */
export const DEFAULT_TEXT_STYLES: DefaultTextStyle[] = [
  {
    name: 'Display',
    family: 'Inter',
    weight: 700,
    size: 64,
    lineHeight: 1.05,
    letterSpacing: -0.02,
    colorKey: 'brand-900',
  },
  {
    name: 'Heading 1',
    family: 'Inter',
    weight: 700,
    size: 48,
    lineHeight: 1.1,
    letterSpacing: -0.01,
    colorKey: 'neutral-900',
  },
  {
    name: 'Heading 2',
    family: 'Inter',
    weight: 600,
    size: 36,
    lineHeight: 1.15,
    letterSpacing: -0.01,
    colorKey: 'neutral-900',
  },
  {
    name: 'Heading 3',
    family: 'Inter',
    weight: 600,
    size: 28,
    lineHeight: 1.2,
    letterSpacing: 0,
    colorKey: 'neutral-900',
  },
  {
    name: 'Subhead',
    family: 'Inter',
    weight: 500,
    size: 20,
    lineHeight: 1.3,
    letterSpacing: 0,
    colorKey: 'neutral-700',
  },
  {
    name: 'Body Large',
    family: 'Inter',
    weight: 400,
    size: 18,
    lineHeight: 1.5,
    letterSpacing: 0,
    colorKey: 'neutral-700',
  },
  {
    name: 'Body',
    family: 'Inter',
    weight: 400,
    size: 16,
    lineHeight: 1.5,
    letterSpacing: 0,
    colorKey: 'neutral-700',
  },
  {
    name: 'Caption',
    family: 'Inter',
    weight: 400,
    size: 12,
    lineHeight: 1.4,
    letterSpacing: 0.02,
    colorKey: 'neutral-500',
  },
]
