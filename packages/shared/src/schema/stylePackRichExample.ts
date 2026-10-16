/**
 * shared/src/schema/stylePackRichExample.ts — a style pack big enough for a
 * whole deck (agentic A5.2): the small example pack (stylePackExample.ts)
 * with two languages, more text styles and eight layouts — cover, agenda,
 * chapter, title and bullets, two columns, picture, quote and closer — its
 * archetype map covering the kinds of slide a deck is built from. The deck
 * builder's tests and the eval build real decks with it; it is no brand.
 * Valid by `validateStylePack`.
 */

import type { PackLayout, PackRegion, StylePack } from './stylePack.js'
import { exampleStylePack } from './stylePackExample.js'

type Rect = [number, number, number, number]

const text = (
  slot: string,
  role: PackRegion['role'],
  rect: Rect,
  textStyle: string,
  extra: Partial<PackRegion> = {},
): PackRegion => ({ slot, role, type: 'text', rect, textStyle, ...extra })

/** The headline component at the title band, as every content layout has it. */
const headline: PackRegion = {
  slot: 'title',
  role: 'title',
  type: 'text',
  rect: [0.0625, 0.0741, 0.875, 0.1111],
  component: 'headline',
  required: true,
}

const LAYOUTS: PackLayout[] = [
  {
    id: 'title',
    name: 'Title',
    family: 'title',
    purpose: 'The opening slide: the deck title and a subtitle.',
    surface: { fixed: 'picture-dark' },
    background: 'color:navy',
    regions: [
      text('title', 'title', [0.0625, 0.3704, 0.875, 0.1481], 'cover', {
        autofit: 'grow-down',
        required: true,
      }),
      text('subtitle', 'subtitle', [0.0625, 0.5556, 0.875, 0.0741], 'subtitle'),
    ],
    furniture: [],
  },
  {
    id: 'agenda',
    name: 'Agenda',
    family: 'agenda',
    purpose: 'What the deck covers: a headline and up to six numbered items.',
    regions: [
      headline,
      text('items', 'body', [0.0625, 0.2778, 0.6, 0.6019], 'body', {
        autofit: 'shrink',
        maxLines: 8,
        required: true,
      }),
    ],
  },
  {
    id: 'chapter',
    name: 'Chapter',
    family: 'divider',
    purpose: 'Opens a chapter: its number and its name, on the dark variant of the slide.',
    surface: { fixed: 'picture-dark' },
    background: 'color:navy',
    regions: [
      text('number', 'subtitle', [0.0625, 0.3333, 0.2, 0.0926], 'subtitle'),
      text('title', 'title', [0.0625, 0.4444, 0.875, 0.1481], 'cover', {
        autofit: 'grow-down',
        required: true,
      }),
    ],
  },
  {
    id: 'title-bullets',
    name: 'Title and bullets',
    family: 'content',
    purpose: 'A headline and up to six bullet points.',
    regions: [
      headline,
      text('bullets', 'body', [0.0625, 0.2778, 0.875, 0.6019], 'body', {
        autofit: 'shrink',
        maxLines: 12,
      }),
    ],
  },
  {
    id: 'two-columns',
    name: 'Two columns',
    family: 'content',
    purpose: 'A headline over two columns of text: a comparison, or two sides of one point.',
    regions: [
      headline,
      text('left', 'body', [0.0625, 0.2778, 0.4219, 0.6019], 'body', {
        autofit: 'shrink',
        required: true,
      }),
      text('right', 'body', [0.5156, 0.2778, 0.4219, 0.6019], 'body', {
        autofit: 'shrink',
        required: true,
      }),
    ],
  },
  {
    id: 'picture',
    name: 'Picture',
    family: 'picture',
    purpose: 'A full-bleed picture with a short statement on it.',
    surface: { fixed: 'picture-dark' },
    regions: [
      {
        slot: 'picture',
        role: 'picture',
        type: 'image',
        rect: [0, 0, 1, 1],
        required: true,
        focus: 'center',
      },
      text('statement', 'body', [0.0625, 0.6481, 0.5, 0.2222], 'title'),
    ],
  },
  {
    id: 'quote',
    name: 'Quote',
    family: 'statement',
    purpose: 'One sentence that carries the point, large, with who said it.',
    regions: [
      text('quote', 'body', [0.125, 0.2963, 0.75, 0.3333], 'quote', {
        anchor: 'middle',
        autofit: 'shrink',
        required: true,
      }),
      text('attribution', 'caption', [0.125, 0.6667, 0.75, 0.0556], 'subtitle'),
    ],
  },
  {
    id: 'closer',
    name: 'Closer',
    family: 'closer',
    purpose: 'The last slide: the ask or the next step, and how to reach us.',
    surface: { fixed: 'picture-dark' },
    background: 'color:navy',
    regions: [
      text('title', 'title', [0.0625, 0.2963, 0.875, 0.1481], 'cover', {
        autofit: 'grow-down',
        required: true,
      }),
      text('contact', 'body', [0.0625, 0.5556, 0.875, 0.1852], 'subtitle'),
    ],
    furniture: [],
  },
]

export function richExampleStylePack(): StylePack {
  const base = exampleStylePack()
  return {
    ...base,
    id: 'example-rich',
    name: 'Example (rich)',
    textStyles: {
      ...base.textStyles,
      cover: { name: 'Cover title', font: 'head', size: 88, lineSpacing: 0.9, color: 'role:text' },
      subtitle: { name: 'Subtitle', font: 'text', size: 36, color: 'role:textMuted' },
      quote: { name: 'Quote', font: 'head', size: 56, lineSpacing: 1.1, color: 'role:text' },
    },
    grid: { ...base.grid, bands: { ...base.grid.bands, subtitle: 200 } },
    furniture: {
      ...base.furniture,
      items: {
        ...base.furniture.items,
        footer: {
          kind: 'text',
          rect: [0.0625, 0.9259, 0.5, 0.0278],
          textStyle: 'footer',
          template: { en: '{client} | Page {page}', de: '{client} | Seite {page}' },
          fields: { client: { required: true, sentinel: 'Client' } },
        },
      },
    },
    layouts: LAYOUTS,
    editorial: { ...base.editorial, languages: ['en', 'de'] },
    archetypeMap: {
      cover: ['title'],
      agenda: ['agenda'],
      divider: ['chapter'],
      content: ['title-bullets', 'two-columns'],
      comparison: ['two-columns'],
      picture: ['picture'],
      statement: ['quote'],
      closer: ['closer'],
      contact: ['closer'],
    },
  }
}
