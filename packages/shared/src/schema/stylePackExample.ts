/**
 * shared/src/schema/stylePackExample.ts — a small, complete style pack:
 * two background variants, a picture surface, list levels, a grid,
 * furniture with a pagination component, three layouts. Valid by
 * `validateStylePack`. The commands' fixture folder carries it (their
 * examples run against it), and the tests build on it; it is no brand.
 */

import type { StylePack } from './stylePack.js'

export function exampleStylePack(): StylePack {
  return {
    schemaVersion: 1,
    id: 'example',
    name: 'Example',
    canvas: { width: 1920, height: 1080 },
    tokens: {
      colors: {
        navy: { name: 'Navy', value: '#001e50', group: 'primary' },
        white: { name: 'White', value: '#ffffff', group: 'neutral' },
        grey: { name: 'Grey', value: '#7a8590', group: 'neutral' },
        red: { name: 'Red', value: '#e4002b', group: 'accent' },
      },
      axes: [
        {
          id: 'background',
          name: 'Background',
          default: 'light',
          values: [
            {
              id: 'light',
              name: 'Light',
              roles: {
                background: 'color:white',
                text: 'color:navy',
                textMuted: 'color:grey',
                line: 'color:navy',
                accent: 'color:red',
              },
            },
            {
              id: 'dark',
              name: 'Dark',
              roles: {
                background: 'color:navy',
                text: 'color:white',
                textMuted: 'color:grey',
                line: 'color:white',
                accent: 'color:red',
              },
            },
          ],
        },
      ],
      surfaces: {
        'picture-dark': { name: 'Dark picture', roles: { text: 'color:white' } },
      },
      chart: { series: ['color:navy', 'color:grey'], highlight: 'role:accent' },
    },
    fonts: {
      head: {
        family: 'Inter',
        weight: 700,
        fallbacks: ['Arial', 'sans-serif'],
        synthesizeBold: false,
      },
      text: {
        family: 'Inter',
        weight: 400,
        fallbacks: ['Arial', 'sans-serif'],
        synthesizeBold: false,
      },
    },
    textStyles: {
      title: { name: 'Title', font: 'head', size: 64, lineSpacing: 0.9, color: 'role:text' },
      body: {
        name: 'Body',
        font: 'text',
        size: 32,
        minSize: 24,
        lineSpacing: 1.1,
        color: 'role:text',
        levels: [
          {
            list: 'bullet',
            bullet: { glyph: '–', color: 'role:accent' },
            indent: 36,
            hanging: 36,
            spaceBefore: 12,
          },
          { list: 'bullet', bullet: { glyph: '–' }, indent: 72, hanging: 36, size: 28 },
        ],
      },
      footer: { name: 'Footer', font: 'text', size: 18, color: 'role:textMuted' },
    },
    grid: {
      margins: { left: 120, right: 120, top: 80, bottom: 80 },
      columns: [
        [120, 930],
        [990, 1800],
      ],
      gutter: 60,
      bands: { title: 80, content: 300, footer: 1000 },
    },
    furniture: {
      defaultSet: ['pagenum', 'footer'],
      items: {
        pagenum: { kind: 'pageNumber', component: 'pagination' },
        footer: {
          kind: 'text',
          rect: [0.0625, 0.9259, 0.5, 0.0278],
          textStyle: 'footer',
          template: '{client} | Page {page}',
          fields: { client: { required: true, sentinel: 'Client' } },
        },
      },
    },
    assets: {},
    layouts: [
      {
        id: 'title',
        name: 'Title',
        family: 'title',
        purpose: 'The opening slide: the deck title and a subtitle.',
        regions: [
          {
            slot: 'title',
            role: 'title',
            type: 'text',
            rect: [0.0625, 0.3704, 0.875, 0.1481],
            textStyle: 'title',
            autofit: 'grow-down',
            required: true,
          },
          {
            slot: 'subtitle',
            role: 'subtitle',
            type: 'text',
            rect: [0.0625, 0.5556, 0.875, 0.0741],
            textStyle: 'body',
          },
        ],
        furniture: [],
      },
      {
        id: 'title-bullets',
        name: 'Title and bullets',
        family: 'content',
        purpose: 'A headline and up to six bullet points.',
        regions: [
          {
            slot: 'title',
            role: 'title',
            type: 'text',
            rect: [0.0625, 0.0741, 0.875, 0.1481],
            component: 'headline',
          },
          {
            slot: 'bullets',
            role: 'body',
            type: 'text',
            rect: [0.0625, 0.2778, 0.875, 0.6019],
            textStyle: 'body',
            autofit: 'shrink',
            maxLines: 12,
          },
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
          {
            slot: 'statement',
            role: 'body',
            type: 'text',
            rect: [0.0625, 0.6481, 0.5, 0.2222],
            textStyle: 'title',
          },
        ],
      },
    ],
    components: [
      {
        id: 'pagination',
        kind: 'pagination',
        name: 'Page number',
        objects: [
          {
            slot: 'pagenum',
            role: 'furniture',
            type: 'text',
            rect: [1740, 1000, 60, 30],
            textStyle: 'footer',
            isSlideNumber: true,
          },
        ],
      },
      {
        id: 'headline',
        kind: 'headline',
        name: 'Headline',
        objects: [
          {
            slot: 'title',
            role: 'title',
            type: 'text',
            rect: [0, 0, 1680, 120],
            textStyle: 'title',
            autofit: 'grow-down',
          },
        ],
      },
    ],
    editorial: {
      titleMode: 'action-title',
      title: { maxWords: 12, trailingPeriod: 'forbid' },
      allCaps: 'styles-only',
      italics: 'forbid',
      eyebrows: 'none',
      minBodySize: 24,
      typography: {
        quotes: 'en',
        enDashRanges: true,
        emDash: 'sparingly',
        nbspBeforeUnits: true,
        ellipsis: true,
        emoji: 'forbid',
      },
      languages: ['en'],
    },
    qa: {
      fit: { slackLines: 0.5 },
      textColors: ['color:navy', 'color:white', 'color:grey'],
      oneVariantPerDeck: true,
      requiredFurniture: ['footer'],
      sentinels: ['Client'],
    },
    archetypeMap: { cover: ['title'], content: ['title-bullets'], picture: ['picture'] },
    provenance: {
      bootstrap: { tool: 'hand', version: '1', at: '2026-10-12' },
      sources: [],
      calls: [],
    },
  }
}
