/**
 * mcp/vocabulary.ts — field descriptions that mean the same on every tool,
 * said once in the server instructions instead of in every tool's schema.
 *
 * The tool list is in every session's context (tools.ts), and a handful of
 * fields — the slide reference above all, on 45 tools — carried the same
 * sentence everywhere they appear. Each entry pairs the exact `description`
 * a command's input schema produces (after command mentions become tool
 * names, as the model sees it) with the note the instructions carry
 * instead. tools.ts removes a matching description from every tool;
 * guidance.ts appends the notes to the instructions.
 *
 * The source zod schemas keep their descriptions: other readers (the
 * capability manifest, the contract suite, a single tool read in isolation
 * by a client that shows it) still see them in full. Only the MCP
 * projection leaves them out.
 *
 * vocabulary.test.ts keeps this list honest in both directions: every entry
 * must still match a description somewhere (a reworded zod `.describe()`
 * would otherwise silently put the sentence back on every tool), and any
 * description repeated widely enough to be worth it must be listed here.
 */

export interface SharedField {
  /** The schema description, exactly as the tool list would carry it. */
  readonly description: string
  /** What the instructions say instead, naming the field. */
  readonly note: string
}

/**
 * A description repeated on at least this many tools, costing at least
 * {@link SHARED_MIN_SAVED_BYTES} to repeat, belongs in the vocabulary.
 */
export const SHARED_MIN_TOOLS = 3
export const SHARED_MIN_SAVED_BYTES = 100

export const SHARED_FIELDS: readonly SharedField[] = [
  // Addressing
  {
    description: 'Slide id, or { id }, or { index } (0-based position in the deck)',
    note: '`slide` / `slides`: a slide id, { "id": … } or { "index": n } (0-based position in the deck).',
  },
  {
    description: 'Object id (unique within its slide)',
    note: '`object` / `objects` / `image`: object ids, unique within their slide.',
  },
  { description: 'Table object id', note: '`table`: the table object’s id.' },
  {
    description: 'Table cell, 0-based row and column',
    note: '`cell`: { row, col }, 0-based.',
  },
  {
    description: 'Required for tables: which cell body to address',
    note: 'In a text target, `cell` is required when `object` is a table.',
  },
  {
    description: 'A text object, or a table when `cell` is given',
    note: 'In a text target, `object` is a text object, or a table with `cell`.',
  },
  {
    description:
      'A text object body, or one table cell body ({ slide, object: tableId, cell: { row, col } })',
    note: '`target` of text tools: a text object’s body, or one table cell’s body ({ slide, object: tableId, cell: { row, col } }).',
  },
  {
    description: 'Inclusive rectangle of cells between two corners',
    note: 'Table `range`: the inclusive rectangle of cells between two corners.',
  },
  {
    description: 'Component id (component_list)',
    note: '`componentId` values come from component_list.',
  },
  {
    description: 'Animation step id',
    note: '`animation` / `animations` / `order`: animation step ids, as query_slide lists them.',
  },
  {
    description: 'Asset id (media_upload returned it; image objects carry it as assetId)',
    note: '`assetId`: from media_upload, or an image object’s own assetId.',
  },
  // Text bodies
  {
    description: 'The body: a plain string, or { paragraphs: [...] } for formatting and lists',
    note: 'A text body (`text`, component `slots`) is a plain string or { paragraphs: [...] }.',
  },
  {
    description:
      'Plain text. A blank line ("\\n\\n") or U+2029 starts a new paragraph; a single "\\n" is a soft line break inside the paragraph.',
    note: 'As a plain string, a blank line ("\\n\\n") or U+2029 starts a new paragraph and a single "\\n" is a soft line break.',
  },
  {
    description:
      'Structured body: paragraphs, each with its list attributes (list "bullet"|"number"|"none", level 0..8, bulletChar, numberFormat, startAt; without `list` a paragraph takes its level\'s default from the box\'s listLevels) and either plain `text` or formatted `runs`.',
    note: 'As { paragraphs }, each paragraph has its list attributes (list "bullet"|"number"|"none", level 0..8, bulletChar, numberFormat, startAt; without `list` a paragraph takes its level\'s default from the box\'s listLevels) and either plain `text` (one unformatted run) or formatted `runs`, in order; a run’s `text` may hold "\\n" as a soft line break.',
  },
  { description: 'Unformatted paragraph text (shorthand for one run)', note: '' },
  { description: 'Run text; "\\n" is a soft line break', note: '' },
  // Typography
  {
    description:
      'Font family name, e.g. "Inter" (must be available to the deck; see its folder fonts)',
    note: '`fontFamily`: a family name such as "Inter", available to the deck (its folder fonts).',
  },
  {
    description: 'CSS font weight 100..900 in steps of 100 (400 regular, 700 bold)',
    note: '`fontWeight`: 100..900 in steps of 100 (400 regular, 700 bold); `bold` is shorthand for 700 / 400.',
  },
  { description: 'Shorthand: true = fontWeight 700, false = fontWeight 400', note: '' },
  { description: 'Font size in slide px', note: '`fontSize` is in slide px.' },
  {
    description: 'Text colour, "#RRGGBB" or 0xRRGGBB integer',
    note: 'A text `color` is "#RRGGBB" or a 0xRRGGBB integer.',
  },
  {
    description:
      'One of 3 kinds, chosen by `kind`. Only some kinds take — stops (required): linearGradient, radialGradient; angleDeg (required): linearGradient; centerX, centerY: radialGradient; assetId (required), fit: image.',
    note: '`fillStyle`: one of 3 kinds chosen by `kind` — linearGradient (stops and angleDeg required), radialGradient (stops required; centerX, centerY) or image (assetId required; fit).',
  },
  // Files
  {
    description: 'The file: { url } for something on the web, or { base64 } for bytes you have',
    note: 'A file argument (`file`, `pptx`) is { url } for something on the web or { base64 } for bytes you have.',
  },
  {
    description:
      'Public http(s) URL the server downloads (ports 80/443 only; private and internal addresses are refused, redirects re-checked)',
    note: 'Its `url` is a public http(s) URL the server downloads (ports 80/443 only; private and internal addresses are refused, redirects re-checked).',
  },
  {
    description: 'The file as base64, or as a data: URL (data:image/png;base64,…)',
    note: 'Its `base64` is raw base64 or a data: URL (data:image/png;base64,…).',
  },
  {
    description: 'File name hint, e.g. "logo.png" (the bytes decide the type)',
    note: 'Its `filename` ("logo.png") and `mimeType` ("image/png") are only hints: the bytes decide the type.',
  },
  { description: 'MIME type hint, e.g. "image/png" (the bytes decide the type)', note: '' },
  // Sharing
  {
    // The text body's runs (sharedShapes.ts' text body note says what a run holds).
    description: 'Formatted runs, in order',
    note: '',
  },
  {
    description:
      'viewer = can look and present; editor = can change the deck; owner = can also share and delete it',
    note: 'Share `role`: viewer = can look and present; editor = can change the deck; owner = can also share and delete it.',
  },
]

/** Descriptions the MCP projection leaves out of every tool schema. */
export const SHARED_DESCRIPTIONS: ReadonlySet<string> = new Set(
  SHARED_FIELDS.map((f) => f.description),
)

/** The instructions' paragraph for the shared fields (entries whose note another entry already covers have none). */
export function sharedFieldsInstructions(): string {
  return [
    'Fields that mean the same everywhere (their schemas do not repeat this):',
    ...SHARED_FIELDS.map((f) => f.note).filter((n) => n.length > 0),
  ].join(' ')
}
