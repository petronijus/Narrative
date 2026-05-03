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
 * 10 slide-oriented text styles — title slide → footnote.
 * `letterSpacing` is in em units (negative = tighter).
 */
export const DEFAULT_TEXT_STYLES: DefaultTextStyle[] = [
  // Title slide — biggest, accent color so it stands out.
  {
    name: 'Title',
    family: 'Inter',
    weight: 700,
    size: 96,
    lineHeight: 1.0,
    letterSpacing: -0.02,
    colorKey: 'accent-primary',
  },
  // Chapter divider slide — big but a step below Title.
  {
    name: 'Chapter',
    family: 'Inter',
    weight: 700,
    size: 72,
    lineHeight: 1.05,
    letterSpacing: -0.015,
    colorKey: 'neutral-900',
  },
  // Slide heading hierarchy.
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
  // Body copy.
  {
    name: 'Body',
    family: 'Inter',
    weight: 400,
    size: 20,
    lineHeight: 1.5,
    letterSpacing: 0,
    colorKey: 'neutral-700',
  },
  // Bulleted list item — same size as body, looser leading for readability.
  {
    name: 'Bullet',
    family: 'Inter',
    weight: 400,
    size: 20,
    lineHeight: 1.6,
    letterSpacing: 0,
    colorKey: 'neutral-700',
  },
  // Pulled quote / emphasis.
  {
    name: 'Quote',
    family: 'Inter',
    weight: 500,
    size: 24,
    lineHeight: 1.35,
    letterSpacing: -0.005,
    colorKey: 'neutral-700',
  },
  // Caption / description below an image or chart.
  {
    name: 'Caption',
    family: 'Inter',
    weight: 400,
    size: 14,
    lineHeight: 1.4,
    letterSpacing: 0.01,
    colorKey: 'neutral-500',
  },
  // Footnote / source / fine print + slide page numbers.
  {
    name: 'Footnotes and pages',
    family: 'Inter',
    weight: 400,
    size: 11,
    lineHeight: 1.4,
    letterSpacing: 0.04,
    colorKey: 'neutral-500',
  },
]
