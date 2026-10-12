# A4 — the style pack schema

Design for A4.3's `StylePackSchema` (to become zod in
`packages/shared/src/schema/stylePack.ts`), grounded in the five brands' <!-- docs-check: ignore -->
source material. Written 2026-10-12 against the skill library at `29f9367`.
Parent plan: [`a4-style-packs.md`](./a4-style-packs.md); format sketch:
[`agentic-layer.md`](./agentic-layer.md) §7.1.

## What the sources showed (the facts the schema rests on)

- **Variant cuts share geometry.** Contoso: 22 of 23 families have identical
  slot boxes in every cut (`two-pics` differs by rounding); only colour
  changes. Fabrikam: 35 of 50 layouts are identical in the light and dark
  masters, the other 15 differ by < 0.5 px at 1920. So a layout is stored
  **once**, and colour comes from **variant-dependent colour roles** —
  Contoso 58 → 23 layouts, Fabrikam 100 → 31.
- **Fabrikam's 30 "N active" agenda layouts are one design each** with a
  different item emphasised (`tx1` vs `accent2`): 11 + 5 + 6 layouts fold
  into 3 with an `items.emphasis` rule.
- **Per-level list styles carry more than a glyph.** Contoso levels change size
  and weight (level 0 = Text Office Bold 18 pt, level 1 = 14 pt, dash from
  level 2 on the `text` family, on every level of `bullets`); Fabrikam colours
  bullets per level (`›` red / `tx1` / grey) at 150 % scale; Tailspin uses
  Wingdings `§` (■) and Symbol `-` (−), which must become Unicode.
- **No source uses PowerPoint's shrink-to-fit.** Contoso: `none` 190 / `shape`
  137 slots; Fabrikam: `spAutoFit` 116, `noAutofit` 42, `normAutofit` 0; Tailspin:
  `noAutofit` on picture placeholders only.
- **The A4.1 role enum is enough.** Every source slot maps onto
  `OBJECT_ROLES` (table in §2); no new role is needed.
- **Recurring blocks are few.** Contoso's title+subtitle box is identical on 9
  content families; Fabrikam's action title on ~20 layouts; Tailspin's
  title+subheadline on every content layout; Woodgrove/Adatum's section label
  on every content slide. That is the component list; everything else is
  layout data.
- **Woodgrove is flow layout.** `clamp()` sizes evaluated at the 1920×1080 PDF
  viewport all hit their maximum (body 17 px, hero 58 px, cover 160 px);
  region rects must be measured from a render, not computed by hand.

## 1. The schema

Units: **px on the 1920×1080 canvas** (`SLIDE_WIDTH`/`SLIDE_HEIGHT`) for
sizes, insets, indents and grid lines; **canvas fractions** for layout
rects (resolution-independent, so a later M20 aspect ratio re-projects
them). Ids are `^[a-z][a-z0-9-]*$` (≤ 48 chars); slot names reuse A4.1's
`SlotNameSchema`, roles reuse `OBJECT_ROLES`.

```ts
type Id = string
type Px = number
/** [x, y, w, h] as fractions of the canvas, 4 decimals (0.0001 ≈ 0.19 px). */
type Rect = [number, number, number, number]
/**
 * 'role:text' — a colour role, resolved per variant/surface;
 * 'color:dark_blue' — a pack colour; '#RRGGBB' or '#RRGGBBAA' — a literal
 * (Woodgrove/Adatum need alpha: rgba(255,255,255,0.6) → '#FFFFFF99').
 */
type ColorRef = `role:${ColorRole}` | `color:${Id}` | `#${string}`

/** Fixed vocabulary, so a restyle maps a user's accent to the other pack's accent. */
type ColorRole =
  | 'background'
  | 'surface'
  | 'text'
  | 'textSecondary'
  | 'textMuted'
  | 'line'
  | 'accent'
  | 'onAccent'

interface StylePack {
  schemaVersion: 1
  id: Id // 'contoso-2026'
  name: string
  canvas: { width: 1920; height: 1080 } // literal until M20
  tokens: PackTokens
  fonts: Record<Id, PackFontFace> // 'head' and 'text' required
  textStyles: Record<Id, PackTextStyle>
  grid: PackGrid
  furniture: PackFurniture
  assets: Record<Id, PackAsset>
  layouts: PackLayout[]
  components: PackComponent[]
  imagery?: PackImagery
  editorial: PackEditorial
  qa: PackQa
  archetypeMap: Partial<Record<Archetype, Id[]>> // layout ids, preferred first
  provenance: PackProvenance
}
```

### 1.1 Tokens, variants, surfaces, chart palette

```ts
interface PackTokens {
  colors: Record<
    Id,
    {
      name: string
      value: `#${string}` // 6 or 8 hex digits
      group?: 'primary' | 'secondary' | 'accent' | 'neutral' | 'status'
    }
  >
  /** Deck variants: one value per axis is chosen for a whole deck. */
  axes: PackAxis[] // ≥ 1
  /** Local role sets a layout pins or a slide picks (photo tone, a blue band). */
  surfaces?: Record<Id, { name: string; roles: Partial<Record<ColorRole, ColorRef>> }>
  chart: {
    series: ColorRef[] // in order
    highlight?: ColorRef // the one emphasised series
    grid?: ColorRef
    axis?: ColorRef
    label?: ColorRef
  }
}

interface PackAxis {
  id: Id // 'background' (Contoso), 'theme', 'accent' (Woodgrove)
  name: string
  default: Id
  values: Array<{
    id: Id
    name: string
    /** The roles this axis governs. Each role is governed by exactly one axis. */
    roles: Partial<Record<ColorRole, ColorRef>> // never a role: ref (no cycles)
    /** Woodgrove "best on": a warning, not a rule. */
    recommendedWith?: Record<Id, Id[]> // { theme: ['dark'] }
  }>
}
```

Resolution of `role:x` on a slide: the slide's surface (layout-pinned or
chosen) → the deck's variant (its value on the axis that governs `x`) →
error. `background` and `text` must be governed by some axis.

### 1.2 Fonts

```ts
interface PackFontFace {
  family: string // the folder font family: 'Contoso Text Office', 'Fabrikam Type', 'Northwind Sans Display'
  weight: number // 100..900
  stretch?: number // wdth 50..200 — Fabrikam Extended 130, Wide 105, Normal 100
  fallbacks: string[] // CSS generic last: ['Arial', 'sans-serif']
  synthesizeBold: false // every brand ships real bold cuts; faux bold is a brand break
  /** What the folder must hold for the fit check; compile reports what is missing. */
  requires?: {
    postscriptName?: string
    axes?: { wght?: [number, number]; wdth?: [number, number] }
  }
}
```

No `style`: all five brands forbid italics.

### 1.3 Text styles with list levels

```ts
interface PackTextStyle {
  name: string
  font: Id // key of fonts
  size: Px
  /** The floor of `autofit: 'shrink'` (A4.2a: text-style token `minSize`, a box's `minFontSize`). */
  minSize?: Px
  weight?: number
  stretch?: number // override the face
  /** CSS, × font size (Woodgrove). Exclusive with lineSpacing. */
  lineHeight?: number
  /** PowerPoint spcPct, × the font's normal line (Contoso 0.9, Fabrikam 1.1, Tailspin 1.0). */
  lineSpacing?: number
  letterSpacing?: Px // Woodgrove em values × size at bootstrap
  color: ColorRef // almost always 'role:text' / 'role:textSecondary'
  textTransform?: 'uppercase' // Woodgrove/Adatum labels, big statement
  align?: 'left' | 'center' | 'right'
  spaceBefore?: Px
  spaceAfter?: Px
  /** levels[i] applies to paragraphs with ParagraphAttrs.level === i (0..8). */
  levels?: PackListLevel[] // ≤ 9
}

interface PackListLevel {
  /** The default list kind of a paragraph at this level (§5: ParagraphAttrs.list). */
  list: 'bullet' | 'number' | 'none'
  bullet?: { glyph: string; color?: ColorRef; scale?: number } // Fabrikam '›' role:accent ×1.5
  numberFormat?: ListNumberFormat
  indent: Px // text start (OOXML marL)
  hanging: Px // bullet hangs this far left of the text (−OOXML indent)
  spaceBefore?: Px
  /** Contoso: level 0 is Text Office Bold 36 px, level 1 regular 28 px. */
  font?: Id
  size?: Px
  weight?: number
  color?: ColorRef
  lineSpacing?: number
}
```

A bullet's typeface is the paragraph's: symbol fonts are mapped to Unicode
at bootstrap (Wingdings `§` → `■` U+25A0, Symbol `-` → `−` U+2212), so
`buFont` is not stored.

### 1.4 Grid

```ts
interface PackGrid {
  margins: { left: Px; right: Px; top: Px; bottom: Px }
  columns: Array<[left: Px, right: Px]> // explicit: Contoso's four columns are 578/266/266/578 px wide
  halves?: Array<[Px, Px]> // Contoso
  gutter: Px
  bands: { title: Px; subtitle?: Px; content: Px; footer: Px } // y of each top
}
```

Compiled to deck guides (A4.4): a vertical guide per margin and column
edge, a horizontal one per band.

### 1.5 Furniture and assets

```ts
interface PackFurniture {
  defaultSet: Id[] // drawn on a layout that does not say otherwise
  items: Record<Id, FurnitureItem>
}
type FurnitureItem =
  | {
      kind: 'text'
      rect: Rect
      textStyle: Id
      template: string | Record<Lang, string> // 'Page {page} | Creation date: {created} | …'
      fields?: Record<Id, { required?: boolean; default?: string; sentinel?: string }>
    }
  | { kind: 'pageNumber'; component: Id } // the pagination component (isSlideNumber)
  | { kind: 'image'; rect: Rect; asset: Id }
  | { kind: 'rule'; rect: Rect; color: ColorRef; width: Px } // rect h = 0 / w = 0
  | {
      kind: 'shape'
      shape: 'ellipse' | 'rect'
      rect: Rect // Adatum spheres/rings
      fill?:
        | ColorRef
        | { radial: Array<{ offset: number; color: ColorRef }>; center: [number, number] }
      stroke?: { color: ColorRef; width: Px }
      radius?: Px
    }

interface PackAsset {
  name: string
  /** Per value of a role: Contoso logo in dark blue / white, Woodgrove logo dark / light. */
  byRole?: { role: ColorRole; files: Record<ColorRef, AssetSource> }
  file?: AssetSource
}
type AssetSource = { assetId: string } | { file: string } // file: private overlay path before upload
```

Every furniture object is placed with `role: 'furniture'` and the item id
as `slot`, so `style.deck.apply` regenerates it; field values live in the
deck (§5, `meta.fields`). Decoration (rules, spheres, Fabrikam card rules, the
Tailspin wave) is furniture too: drawn by the pack, not the author (§7.1).

### 1.6 Layouts and regions

```ts
interface PackLayout {
  id: Id
  name: string
  aliases?: string[] // master names for lookup: 'Titel und Bulletpoints', 'Inhalt 3-spaltig mit Überschrift'
  family: Id // groups layouts in pickers (Contoso family; else = id)
  purpose: string // one sentence a model reads (layouts.md)
  /** Absent: the deck variant. fixed: always this surface or axis value (Contoso graph/contact = 'dc', Tailspin cover = 'blue').
   *  choose: the builder picks per slide (Contoso picture tone). */
  surface?: { fixed: Id } | { choose: Id[]; default: Id }
  background?: ColorRef // default 'role:background'
  regions: PackRegion[]
  /** Repeated items (columns, cards, agenda rows) and their emphasis. */
  items?: { count: number; emphasis?: { color: ColorRef; others?: ColorRef } }
  furniture?: Id[] // replaces defaultSet (Fabrikam covers: none; Contoso covers: classification + meta)
  decor?: FurnitureItem[] // layout-only furniture: Contoso title lines, Fabrikam card rules
}

interface PackRegion {
  slot: string // the brand's name: 'bullets2', 'card-3-body'
  role: ObjectRole // A4.1 enum
  type: 'text' | 'image' | 'chart' | 'table'
  rect: Rect
  item?: number // 1-based; which repeated item (Contoso body1/body2, Fabrikam agenda row 3)
  textStyle?: Id // required when type = 'text'
  component?: Id // place a stamp of this pack component here instead
  align?: 'left' | 'center' | 'right'
  anchor?: 'top' | 'middle' | 'bottom' // → vAlign; default top
  autofit?: 'grow-down' | 'fixed' | 'shrink' // default 'fixed' (§6.4)
  insets?: [l: Px, t: Px, r: Px, b: Px] // default the pack's bodyPr default
  aspect?: number // image slots, w/h of the frame
  focus?: 'center' | 'top' | 'bottom' | 'left' | 'right'
  maxLines?: number
  maxChars?: number // Fabrikam cover "maximal zwei Zeilen"; Adatum headline ≤ 12 words → editorial
  required?: boolean
  fillOrder?: number // reading order for an unslotted content array (Fabrikam fill_content)
}
```

`needsPicture` is derived: a layout with a required `image` region.

### 1.7 Components

```ts
interface PackComponent {
  id: Id
  kind: 'pagination' | 'headline' | 'subline' | 'copy' | 'divider' | 'grid' | 'label'
  name: string
  /** Objects relative to the component's origin, px; become the folder master. */
  objects: Array<{
    slot: string
    role: ObjectRole
    type: 'text' | 'shape' | 'image'
    rect: [x: Px, y: Px, w: Px, h: Px]
    textStyle?: Id
    fill?: ColorRef
    stroke?: { color: ColorRef; width: Px }
    radius?: Px // a shape's corners (added in A4.7: Woodgrove's label pill)
    autofit?: 'grow-down' | 'fixed'
    isSlideNumber?: true
    text?: string
  }>
}
```

A region with `component` places a stamp at the region's origin (no
scaling); the master's size must fit the region (§3). Compile matches the
folder master by `origin: { pack, key }` (§5).

### 1.8 Imagery, editorial, QA, archetypes, provenance

```ts
interface PackImagery {
  pool?: { kind: 'drive'; path: string; count?: number } // Contoso 72, Fabrikam ≈ 290
  rights?: string
  minDpi?: number // Fabrikam 150, measured after crop against the slot's inches (144 px = 1 in)
  defaultFocus?: PackRegion['focus']
  scrims: boolean // Fabrikam/Contoso false
  aiLabel?: {
    required: true
    since: string
    corner: 'top-right'
    spacer: { cover: Px; content: Px }
  } // Contoso 0.8 / 0.4 cm = 45.4 / 22.7 px
}

interface PackEditorial {
  titleMode: 'action-title' | 'label+message' // Tailspin: label + message subtitle
  title: { maxWords?: number; maxLines?: number; trailingPeriod: 'forbid' | 'allow' }
  allCaps: 'forbid' | 'styles-only' // Woodgrove caps only through textTransform
  italics: 'forbid'
  underline?: 'forbid'
  accentBudget?: { color: ColorRef; perSlide: number } // Fabrikam red once; Adatum lime
  eyebrows: 'none' | 'minimal' | 'furniture' // Fabrikam minimal; Woodgrove label is furniture/component
  minBodySize?: Px
  recommendedBodySize?: Px // Contoso 28 / 36 px (14 / 18 pt)
  typography: {
    quotes: 'de' | 'en'
    enDashRanges: boolean
    emDash: 'allow' | 'sparingly' | 'forbid'
    nbspBeforeUnits: boolean
    ellipsis: boolean
    emoji: 'forbid'
  }
  replace?: Array<{ pattern: string; with?: string; level: 'error' | 'warn'; note?: string }> // Adatum 'Woodgrove', banned phrases
  register?: 'du' | 'Sie' | 'audience'
  languages: Lang[]
  bilingual?: { marker: '{de|en}'; order: Lang[] } // Contoso
  voice?: string[] // guidance lines for the playbook (Tailspin anti-AI checklist, Contoso craft standards)
}

interface PackQa {
  fit: { slackLines: number; growWarnRatio?: number } // Contoso 0.5 line, warn when a box doubles
  textColors: ColorRef[] // Contoso ['color:dark_blue', 'color:white']
  oneVariantPerDeck: boolean
  requiredFurniture: Id[]
  sentinels: string[] // 'xxxx-xx', 'I/XX', 'Bitte Fußzeile einfügen'
  rules?: Partial<Record<QaRuleId, 'error' | 'warn' | 'off'>>
}
type QaRuleId =
  | 'fit'
  | 'partial-overlap'
  | 'outside-grid'
  | 'text-color'
  | 'variant-mix'
  | 'furniture'
  | 'sentinel'
  | 'missing-picture'
  | 'caps'
  | 'italics'
  | 'bullet-glyph'
  | 'title-period'
  | 'accent-budget'
  | 'typography'
  | 'emoji'
  | 'font-missing'

type Archetype =
  | 'cover'
  | 'agenda'
  | 'divider'
  | 'statement'
  | 'content'
  | 'comparison'
  | 'process'
  | 'evidence'
  | 'decision'
  | 'picture'
  | 'closer'
  | 'contact'

interface PackProvenance {
  bootstrap: { tool: string; version: string; at: string }
  sources: Array<{ repo: string; commit: string; path: string }>
  calls: Array<{ topic: string; decision: string; why?: string }> // §7.4
  derivedFrom?: { packId: Id; at: string } // Adatum ← Woodgrove
}
```

### 1.9 §7.1 fields dropped or replaced

| §7.1 field                        | Fate                                                                                                           |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `tokens` theme slots              | dropped: only a real-master export needs `bg1/tx1/accent6`, and that is withdrawn; `calls` records the mapping |
| `layouts[].variant`, `tone`       | replaced by `surface` (cuts share geometry, see facts)                                                         |
| `layouts[].needsPicture`          | derived from required image regions                                                                            |
| `editorial.bulletGlyphs`          | derived from the text styles' levels                                                                           |
| `imagery.iconStyle`               | dropped: no brand states one                                                                                   |
| `qa` `[SOURCE NEEDED]` / Rigorous | deck-level proof standard (deck spec, §8.1), not a brand rule                                                  |
| `fonts` roles as a closed list    | open record, `head` + `text` required: Woodgrove needs `display`, Fabrikam `head` at wdth 130                          |
| a pack `extends` another          | not a field: Adatum is a copy of Woodgrove with `derivedFrom` — a live parent would restyle another folder's decks |

## 2. Mapping per brand

Conversions: **inches** × 144 (Contoso `box_in`; `box_px` at 1280 × 1.5);
**pt** × 2 (× `12192000 / sldSz.cx` for Tailspin's 12 190 413 EMU width, i.e.
×1.0001); **EMU** → rect fraction = value / `sldSz` per axis (exact canvas
edges for Tailspin's odd size); `spcPct` / 100 000 → `lineSpacing`; `spcPts` /
100 → pt; `marL` → `indent`, −`indent` → `hanging`; `buSzPct` / 100 000 →
`scale`; **vw/vh** → × 19.2 / × 10.8; `clamp(a, b, c)` evaluated at 1920;
`em` × the element's px size; `rgba` → `#RRGGBBAA`; flow-layout regions
measured with `getBoundingClientRect` in headless Chrome at 1920×1080.

### Contoso 2026 — `layouts.json` (+ `vw_deck.py`, `check_deck.py`, SKILL.md)

| Source                                           | Pack                                                                                                                                                           |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `palette` (13) + `palette.extra` (22)            | `tokens.colors` (extras `group: 'accent'`)                                                                                                                     |
| `families[*]` cuts `dc/nh/white`                 | axis `background` {nh (default), white, dc}                                                                                                                    |
| cuts `dark/light` (picture families)             | surfaces `picture-dark`, `picture-light`; layout `surface.choose`                                                                                              |
| `graph`, `contact` (dc only)                     | `surface: { fixed: 'dc' }`                                                                                                                                     |
| `fonts.head/text/text_bold`                      | `fonts.head/text/textBold`, `synthesizeBold: false`                                                                                                            |
| `slots[].levels` "1".."5"                        | `textStyles[*].levels[0..4]` (key − 1), deduplicated                                                                                                           |
| `bullet` `–`                                     | `levels[i].bullet.glyph`                                                                                                                                       |
| `grid.*` (in)                                    | `grid` (px)                                                                                                                                                    |
| `slots[]` box/anchor/autofit/insets/align        | `regions[]`; `autofit: shape` → `grow-down`, `none` → `fixed`                                                                                                  |
| `slot` / `role`                                  | `slot` / `role` (bullets, statement, agenda, contact → `body`; meta, asof, chart_title/unit → `caption`; topline/bottomline → `subtitle`; addlogo → `picture`) |
| `pagenum`, `footer`, `classification`, `logo`    | furniture items; `FOOTER_FORMAT` en/de → `template`                                                                                                            |
| `lines[]`                                        | `layout.decor` rules, `role:line`                                                                                                                              |
| `check_deck.py` `ALLOWED_TEXT`, slack, sentinels | `qa.textColors`, `qa.fit.slackLines: 0.5`, `qa.sentinels`                                                                                                      |
| caps/glyph/period rules, `{de\|en}`, AI label    | `editorial`, `imagery.aiLabel`                                                                                                                                 |

**Call (§7.4):** `layouts.json` levels win over `vw_deck.py`'s comment
(off by one; SKILL.md agrees with the JSON: level 0 bold 18 pt). The master
footer/pagenum slots carry body level styles (the checker skips them) —
the bootstrap gives them the 10 pt footer style instead.
**Pack:** 23 layouts / 86 regions, 3 deck variants + 2 surfaces, ≈ 18 text
styles (22 before dropping the furniture artefacts), 2 components
(pagination, headline = title+subtitle, identical on 9 content families).

### Fabrikam — `Audi_Template.pptx` (2 masters × 50 layouts) + both skills

| Source                                                                          | Pack                                                                                                                                                              |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| theme1/theme2 `clrScheme` via each master's rels                                | colours; axis `theme` {light, dark}: `background` = bg1, `text` = tx1, `surface` = accent1, `line` = accent2, `textMuted` = accent3, `accent` = accent6 `#F50537` |
| `fontScheme` Fabrikam Type Extended / Wide                                          | `fonts.head` {Fabrikam Type, 400, stretch 130}, `text` {stretch 105}, `textNormal` {100}, `textBold` {700, 105}                                                       |
| master `bodyStyle` lvl1–9 (`›` accent6/tx1/accent3, 150 %, marL 0.236 in steps) | `textStyles.body.levels`, `bullet.scale: 1.5`                                                                                                                     |
| layout placeholders (`type`, idx, xfrm, `bodyPr`)                               | regions; `title`/`ctrTitle` → title, `subTitle` → subtitle, `pic` → picture, `ftr` → furniture                                                                    |
| light/dark layout pairs (by name, not idx)                                      | one layout; drift < 0.5 px → light geometry                                                                                                                       |
| `Agenda (k active)` ×10, `Agenda 2`/`3`                                         | 3 layouts, `items.count` 10/4/5, `emphasis` tx1 vs accent2                                                                                                        |
| card connectors, `Grafik` rings, `Rectangle 28`                                 | `decor` / furniture `logo`, `rule`                                                                                                                                |
| `MSIPCMContentMarking` INTERNAL                                                 | furniture `classification`, required                                                                                                                              |
| footer `FABRIKAM AG   I/XX    Präsentationstitel   Datum`                           | furniture template; `I/XX` sentinel                                                                                                                               |
| images.md 150 dpi, no scrims, focus                                             | `imagery.minDpi`, `scrims: false`                                                                                                                                 |
| HTML skill: red once, no eyebrows, action titles, typography                    | `editorial`                                                                                                                                                       |

**Calls:** the master wins over the HTML skill (title 18 pt Extended in
the master vs 40 px headline in HTML; master bold on cover titles vs
"Extended 400 always"); the HTML values become a `web` variant only if
asked. Divider layouts invert placeholder types (TITLE = small line) —
the reader maps by size, recorded in `calls`.
**Pack:** 31 layouts / ≈ 264 regions + ≈ 130 decor items, 2 variants,
≈ 16 text styles, 2 components (headline = action title, divider block).
No pagination: the Fabrikam master has no slide number.

### Tailspin — `tailspinr-master.pptx` (1 master, 22 layouts) + SKILL.md

| Source                                                          | Pack                                                                             |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| theme `0071B9` dk2, `002B46` accent1 …, custom Green/Red/Yellow | colours (custom → `group: 'status'`)                                             |
| one master                                                      | axis `theme` {standard}; surface `blue` (cover/closer on `0071B9`, white text)   |
| `Titelfolie Weiß`, `Schlussfolie weiß/blau`                     | layouts with/without `surface.fixed: 'blue'`                                     |
| bodyStyle `§` Wingdings, `-` Symbol                             | `■`, `−` in `levels`                                                             |
| `dt`, `ftr`, `sldNum`, logo `Grafik 7`, `Freihandform` wave     | furniture `date`, `footer`, `pagenum`, `logo`, decor                             |
| `Bitte Fußzeile einfügen`                                       | sentinel                                                                         |
| "Title = label, subtitle = message"                             | `editorial.titleMode: 'label+message'`, `register: 'du'`, `voice` (anti-AI list) |
| `stat_cards`, `band` builders                                   | components `stat-cards` (grid), `band` (copy)                                    |

**Call:** the master theme wins over the dashboard ramp (`#002B46`, not
`#003D7A`). `1_Inhalt` is a duplicate of `Inhalt`: kept as alias.
**Pack:** ≈ 20 layouts / ≈ 70 regions, 1 variant + 1 surface, ≈ 10 text
styles, 4 components (pagination, headline, stat-cards, band).

### Woodgrove house — SKILL.md 1.8 + `test-presentation.html`

| Source                                     | Pack                                                                                                          |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| dark/light `:root`                         | axis `theme` {dark (default), light}: background, surface, text, textSecondary (`#FFFFFF99`), textMuted, line |
| 8 highlight colours, "best on"             | axis `accent` {dune … yard}, `accent` + `onAccent` roles, `recommendedWith`                                   |
| Northwind Sans 400/700/900, Black Display   | `fonts.text`, `textBold`, `black`, `display`                                                                  |
| `clamp()` type scale                       | text styles at the 1920 values (title 160, hero 58, body 17 …)                                                |
| `.label` pill + text (absolute, 7vh/7vw)   | component `label`                                                                                             |
| `.slide-footer` divider, logo dark/light   | furniture `footer-rule`, `logo` (asset `byRole: background`)                                                  |
| layout library (15)                        | layouts, rects measured from the render                                                                       |
| stats row, columns grid                    | component `stats-row` (grid)                                                                                  |
| typography standards, no italics, no emoji | `editorial`                                                                                                   |

**Calls:** SKILL.md 1.8 + `test-presentation.html` win over
`references/template.html`; where the two winners disagree (stat numbers
900 in SKILL.md, 400 in the test deck; headline max-width 66 % vs 38 em),
SKILL.md decides type rules and the test deck decides geometry.
**Pack:** ≈ 15 layouts / ≈ 150 regions, 2 × 8 = 16 deck variants,
≈ 20 text styles, 3 components (label, headline + divider rule, stats-row).

### Adatum — `adatum-deck-design.md` (copy of Woodgrove, `derivedFrom`)

| Source                                   | Pack                                                                                     |
| ---------------------------------------- | ---------------------------------------------------------------------------------------- |
| `--accent #CBFF00`, dark only            | axes `theme` {dark}, `accent` {lime}                                                     |
| competitor tints, faint red marker       | `chart.series` ramp (white 55 % → 12 %, soft blue, soft amber), `highlight: role:accent` |
| spheres + rings, 2–3 per slide, off-edge | per-layout `decor` shapes (rects may leave the canvas)                                   |
| label `Adatum · <CLIENT>`, tagline       | furniture templates with field `client`                                                  |
| insight story-grid 0.95fr / 1.1fr        | layout `insight` (measured)                                                              |
| `Woodgrove` hyphenated, headline ≤ 12 words  | `editorial.replace`, `title.maxWords: 12`                                                |
| glass `backdrop-filter`                  | approximated by `role:surface` fill (no backdrop blur in the renderer)                   |

**Pack:** ≈ 6 layouts, 1 variant, ≈ 12 text styles, 2 components
(insight-head, stats-row).

## 3. Cross-reference validation

Zod checks shape; `validateStylePack(pack)` then enforces, each as a
path-addressed error (`layouts[4].regions[2].textStyle`):

1. **References resolve:** every `textStyle`, `font`, `component`,
   `asset`, furniture id (`defaultSet`, `layout.furniture`,
   `qa.requiredFurniture`), `archetypeMap` layout id, `surface` id and
   `color:` ref names an existing entry; ids unique per collection.
2. **Roles are covered:** every `role:x` used anywhere is governed by
   exactly one axis, every value of that axis defines it, and every surface
   that a layout uses resolves it (own value or axis); `background` and
   `text` are always governed. No `role:` ref inside an axis or surface.
3. **Variants:** `axes[].default` is one of its values; `recommendedWith`
   names real axes and values; `surface.choose.default` ∈ `choose`.
4. **Geometry:** region rects inside [0, 1] with w, h > 0 (furniture and
   decor may leave the canvas — Adatum spheres bleed); a component placed in
   a region fits it (± 1 px); grid lines ascending and inside the canvas.
5. **Regions:** `type: 'text'` has `textStyle` or `component`; `image`
   has no `textStyle`; slots unique per layout; `item` ≤ `items.count` and
   every item 1..count has a region; `fillOrder` unique per layout;
   `role: 'furniture'` only through furniture, never a region.
6. **Text styles:** `lineHeight` and `lineSpacing` exclusive; ≤ 9 levels;
   `bullet` only with `list: 'bullet'`, `numberFormat` only with
   `'number'`; `hanging` ≤ `indent`; sizes 1..1000 px.
7. **Fonts:** `head` and `text` exist; `stretch` 50..200 and within
   `requires.axes.wdth`; weights within `requires.axes.wght`.
8. **Furniture:** template placeholders are declared `fields` (`{page}`
   implicit); exactly one `pageNumber` item references a `pagination`
   component; a `qa.textColors` entry is not a `role:` ref.
9. **Editorial/QA:** every text style's resolved colour (per variant) is in
   `qa.textColors` when that list is set — Contoso's own masters pass this.
10. **Size:** the encoded pack ≤ 256 KB (§4) and ≤ 200 layouts.

## 4. Size — folder Y.Doc or Postgres

Measured: the Contoso projection (`layouts.json` → this schema, 23 layouts, 86
regions, 22 text styles, furniture, editorial, qa) is **31.8 KB** minified
JSON (61.6 KB pretty; layouts 17.4 KB, text styles 7.5 KB, tokens 2.9 KB).
In a Y.Doc with yjs from the repo: **46.6 KB** as nested Y.Maps/Y.Arrays,
37.1 KB with each layout a plain JSON value in a Y.Array, 31.4 KB as one
JSON string. Ten in-place edits of one rect grow the nested doc by 118
bytes. The source `layouts.json` (355 KB) shrinks ~11× because layouts are
stored once, not per cut.

Estimates from region counts (≈ 200 B per region including layout
overhead): Fabrikam ≈ 65 KB JSON (≈ 95 KB nested), Tailspin ≈ 18 KB, Woodgrove ≈ 30 KB,
Adatum ≈ 20 KB. The folder-doc cap (`MAX_DOC_BYTES`) is 32 MB.

**Recommendation: the folder document**, root map `stylePack`: top-level
parts as nested Y.Maps (so `op: 'update'` patches touch leaves and two
people editing different colours merge), `layouts` as a Y.Array of Y.Maps.
Every deck editor already loads the folder doc for tokens; ≤ 100 KB more
on open is below a single slide thumbnail. Postgres stays the fallback only
if a real pack passes the §3 cap.

## 5. What A4.2 must provide

Field names the slide model should adopt so the compiler and
`slide.applyLayout` have somewhere to write:

- **Autofit:** `TextObject.autofit?: 'grow-down' | 'fixed' | 'shrink'`
  (absent = fixed); `shrink` with `TextStyleToken.minSize` (§6.4).
- **List levels:** `TextStyleTokenSnapshot.levels?: TextStyleLevel[]`
  (index = `ParagraphAttrs.level`) with `list`, `bulletChar`,
  `bulletColor` (`string | TokenRef`), `bulletScale`, `numberFormat`,
  `indent`, `hanging`, `spaceBefore`, `fontFamily`, `fontWeight`,
  `fontSize`, `color`, `lineSpacing`. `ParagraphAttrs.list` gains
  `'none'`: absent means "the linked style's level default" (plain when
  unlinked, so existing decks render unchanged), `'none'` an explicit
  plain paragraph. PPTX export reads the resolved level (no format change).
- **Text style token additions:** `fontStretch?`, `lineSpacing?` (the
  PowerPoint semantic `TextObject` already has), `align?`; `color` keeps
  `string | TokenRef`.
- **Font stretch:** `TextObject.fontStretch?: number` (50–200) in
  `TextStyleOverrideKey`; folder font assets record
  `axes?: { wght?: [min, max]; wdth?: [min, max] }`, and the renderer's
  FontFace declares `font-stretch` ranges.
- **Variant-aware colour tokens (§6.1):** `ColorTokenSnapshot.byVariant?:
{ axis: string; values: Record<string, string> }` and
  `bySurface?: Record<string, string>`; `value` stays the default.
  `resolveTokenValue(ref, tokens, ctx?: { variant, surface })`. Colours
  accept `#RRGGBBAA` (or a separate `alpha`) for Woodgrove/Adatum.
- **Deck meta:** root `meta` Y.Map: `variant: Record<axisId, valueId>`
  (Woodgrove needs two axes), `fields: Record<string, string>` (footer
  department, CSD, date, client, classification), `lang?: string`.
- **Slide provenance (A4.4 writes it):** `slide.layout?: { packId,
layoutId, surface? }` — `surface` replaces the planned `variant`, since
  the variant is the deck's.
- **Compile provenance:** `origin?: { pack: string; key: string }` on
  colour/text-style tokens and component masters, so compile updates what
  it made and never touches hand-made tokens.
- **Furniture:** `role: 'furniture'` + `slot = <furniture id>` (A4.1
  fields); no new field. Image tint is not needed (role-specific asset
  files).
- Optional, not blocking: `SlideBackground.color` accepting a `TokenRef`,
  so a variant switch recolours backgrounds without `style.deck.apply`.

## 6. Decided (Petr, 2026-10-12)

1. **Variant colours — a combination.** A colour token takes its value
   per deck variant by default (`byVariant`, §5): one "Text" token is dark
   blue on New Horizon and white on Digital Cobalt, and a variant switch
   is one deck-meta write. A token without per-variant values is an extra
   — the same in every variant (an accent, a chart colour) or one only
   some variants use; it keeps its single `value`.
2. **List levels are inherited from the text style.** A paragraph without
   its own list setting takes the linked style's level default;
   `ParagraphAttrs.list: 'none'` turns a bullet off explicitly. Existing
   decks render unchanged (their styles carry no levels).
3. **One text style per size, no region overrides.** A region names a
   text style and nothing overrides it: Contoso's titles at 52/72/96/104 px
   are four styles ("Title 52", …). The `override` field of `PackRegion`
   (§1.6) is dropped; `align` stays on the region only where a style is
   shared by regions that align differently — otherwise it moves into the
   style too (A4.3 decides per brand when bootstrapping).
4. **`shrink` autofit stays in A4**, although no source uses it today:
   `TextObject.autofit?: 'grow-down' | 'fixed' | 'shrink'`; shrink scales
   the type down until the text fits, never below the style's `minSize`
   (a new text-style token field), and the render page's `overflow`
   reports a shrink box that still does not fit at `minSize`.
5. **Packs live in the folder document** (§4: Contoso 47 KB encoded, Fabrikam
   ≈ 95 KB estimated); Postgres stays the fallback (decided on the
   numbers, not asked).
