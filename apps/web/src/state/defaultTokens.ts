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
 * 10 starter colors: 3 accents + 7 neutrals.
 * Lean baseline — users add semantic colors (success / warning / etc.)
 * themselves only when they need them.
 */
export const DEFAULT_COLORS: DefaultColor[] = [
  // Accents (3)
  { key: 'accent-primary', name: 'Primary', value: '#3b82f6' },
  { key: 'accent-secondary', name: 'Secondary', value: '#8b5cf6' },
  { key: 'accent-tertiary', name: 'Tertiary', value: '#ec4899' },
  // Neutrals (7)
  { key: 'neutral-0', name: 'White', value: '#ffffff' },
  { key: 'neutral-100', name: 'Neutral 100', value: '#f1f5f9' },
  { key: 'neutral-300', name: 'Neutral 300', value: '#cbd5e1' },
  { key: 'neutral-500', name: 'Neutral 500', value: '#64748b' },
  { key: 'neutral-700', name: 'Neutral 700', value: '#334155' },
  { key: 'neutral-900', name: 'Neutral 900', value: '#0f172a' },
  { key: 'neutral-1000', name: 'Black', value: '#000000' },
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
    colorKey: 'accent-primary',
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
