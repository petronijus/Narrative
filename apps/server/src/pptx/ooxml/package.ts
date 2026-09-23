/**
 * pptx/ooxml/package.ts
 *
 * The parts of a presentation package that do not depend on slide content:
 * content types, package relationships, document properties, the
 * presentation part, one slide master with one blank layout, the theme, and
 * — when any slide has speaker notes — the notes master with its theme.
 *
 * Everything the exporter writes is explicit on the slide (fonts, sizes,
 * colours, positions), so the master and layout carry no placeholders and no
 * text defaults that could leak into imported slides: a deck written here
 * re-imports from its slides alone. The theme is still complete — PowerPoint
 * refuses a package whose theme lacks any of the three format-scheme lists.
 *
 * Element order follows the ECMA-376 transitional schemas (pml.xsd,
 * dml-main.xsd); `ooxml/validate.test.ts` checks every part against them.
 */

import { el, tag, xmlDocument, xmlns, NS, type XmlElement } from './xml.js'
import { SLIDE_CX_EMU, SLIDE_CY_EMU } from './units.js'

export const CT = {
  presentation:
    'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml',
  slide: 'application/vnd.openxmlformats-officedocument.presentationml.slide+xml',
  slideMaster: 'application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml',
  slideLayout: 'application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml',
  notesMaster: 'application/vnd.openxmlformats-officedocument.presentationml.notesMaster+xml',
  notesSlide: 'application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml',
  theme: 'application/vnd.openxmlformats-officedocument.theme+xml',
  presProps: 'application/vnd.openxmlformats-officedocument.presentationml.presProps+xml',
  viewProps: 'application/vnd.openxmlformats-officedocument.presentationml.viewProps+xml',
  tableStyles: 'application/vnd.openxmlformats-officedocument.presentationml.tableStyles+xml',
  coreProps: 'application/vnd.openxmlformats-package.core-properties+xml',
  extendedProps: 'application/vnd.openxmlformats-officedocument.extended-properties+xml',
  relationships: 'application/vnd.openxmlformats-package.relationships+xml',
  xml: 'application/xml',
} as const

export const REL = {
  officeDocument:
    'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument',
  coreProps:
    'http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties',
  extendedProps:
    'http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties',
  slide: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide',
  slideMaster: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster',
  slideLayout: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout',
  notesMaster: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesMaster',
  notesSlide: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide',
  theme: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme',
  presProps: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/presProps',
  viewProps: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/viewProps',
  tableStyles: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/tableStyles',
  image: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image',
  video: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/video',
  media: 'http://schemas.microsoft.com/office/2007/relationships/media',
  hyperlink: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink',
} as const

export interface Relationship {
  id: string
  type: string
  target: string
  external?: boolean
}

export function relationshipsPart(rels: readonly Relationship[]): string {
  return xmlDocument(
    el(
      'Relationships',
      { xmlns: NS.rel },
      rels.map((r) =>
        el('Relationship', {
          Id: r.id,
          Type: r.type,
          Target: r.target,
          TargetMode: r.external === true ? 'External' : undefined,
        }),
      ),
    ),
  )
}

export function contentTypesPart(
  defaults: ReadonlyArray<{ extension: string; contentType: string }>,
  overrides: ReadonlyArray<{ partName: string; contentType: string }>,
): string {
  return xmlDocument(
    el(
      'Types',
      { xmlns: NS.ct },
      el('Default', { Extension: 'rels', ContentType: CT.relationships }),
      el('Default', { Extension: 'xml', ContentType: CT.xml }),
      defaults.map((d) => el('Default', { Extension: d.extension, ContentType: d.contentType })),
      overrides.map((o) => el('Override', { PartName: o.partName, ContentType: o.contentType })),
    ),
  )
}

export function corePropsPart(title: string, author: string, now: Date): string {
  const iso = now.toISOString().replace(/\.\d{3}Z$/, 'Z')
  return xmlDocument(
    el(
      'cp:coreProperties',
      xmlns('cp', 'dc', 'dcterms', 'dcmitype', 'xsi'),
      tag('dc:title', title),
      tag('dc:creator', author),
      tag('cp:lastModifiedBy', author),
      tag('cp:revision', '1'),
      el('dcterms:created', { 'xsi:type': 'dcterms:W3CDTF' }, iso),
      el('dcterms:modified', { 'xsi:type': 'dcterms:W3CDTF' }, iso),
    ),
  )
}

export function extendedPropsPart(slideCount: number): string {
  return xmlDocument(
    el(
      'Properties',
      { xmlns: NS.ep, 'xmlns:vt': NS.vt },
      tag('Application', 'Narrative'),
      tag('Slides', String(slideCount)),
      tag('PresentationFormat', 'Widescreen'),
    ),
  )
}

// ---------------------------------------------------------------------------
// presentation.xml
// ---------------------------------------------------------------------------

export interface PresentationRefs {
  masterRelId: string
  notesMasterRelId: string | undefined
  slideRelIds: readonly string[]
}

export function presentationPart(refs: PresentationRefs): string {
  return xmlDocument(
    el(
      'p:presentation',
      { ...xmlns('a', 'r', 'p'), saveSubsetFonts: 1 },
      tag('p:sldMasterIdLst', el('p:sldMasterId', { id: 2147483648, 'r:id': refs.masterRelId })),
      refs.notesMasterRelId !== undefined &&
        tag('p:notesMasterIdLst', el('p:notesMasterId', { 'r:id': refs.notesMasterRelId })),
      refs.slideRelIds.length > 0 &&
        tag(
          'p:sldIdLst',
          refs.slideRelIds.map((rid, i) => el('p:sldId', { id: 256 + i, 'r:id': rid })),
        ),
      el('p:sldSz', { cx: SLIDE_CX_EMU, cy: SLIDE_CY_EMU }),
      // PowerPoint's default portrait notes page (7.5 × 10 in).
      el('p:notesSz', { cx: 6_858_000, cy: 9_144_000 }),
    ),
  )
}

export function presPropsPart(): string {
  return xmlDocument(el('p:presentationPr', xmlns('a', 'r', 'p')))
}

export function viewPropsPart(): string {
  return xmlDocument(
    el(
      'p:viewPr',
      xmlns('a', 'r', 'p'),
      tag(
        'p:normalViewPr',
        el('p:restoredLeft', { sz: 15620 }),
        el('p:restoredTop', { sz: 94660 }),
      ),
      tag(
        'p:slideViewPr',
        tag(
          'p:cSldViewPr',
          tag(
            'p:cViewPr',
            tag('p:scale', el('a:sx', { n: 100, d: 100 }), el('a:sy', { n: 100, d: 100 })),
            el('p:origin', { x: 0, y: 0 }),
          ),
        ),
      ),
      el('p:gridSpacing', { cx: 76200, cy: 76200 }),
    ),
  )
}

/** No table styles: every table cell the exporter writes carries its own look. */
export function tableStylesPart(): string {
  return xmlDocument(
    el('a:tblStyleLst', {
      'xmlns:a': NS.a,
      def: '{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}',
    }),
  )
}

// ---------------------------------------------------------------------------
// Master, layout, notes master
// ---------------------------------------------------------------------------

/** The empty shape tree every master / layout / slide starts with. */
export function emptyGroupNvAndProps(): XmlElement[] {
  return [
    tag('p:nvGrpSpPr', el('p:cNvPr', { id: 1, name: '' }), tag('p:cNvGrpSpPr'), tag('p:nvPr')),
    tag(
      'p:grpSpPr',
      tag(
        'a:xfrm',
        el('a:off', { x: 0, y: 0 }),
        el('a:ext', { cx: 0, cy: 0 }),
        el('a:chOff', { x: 0, y: 0 }),
        el('a:chExt', { cx: 0, cy: 0 }),
      ),
    ),
  ]
}

const CLR_MAP = {
  bg1: 'lt1',
  tx1: 'dk1',
  bg2: 'lt2',
  tx2: 'dk2',
  accent1: 'accent1',
  accent2: 'accent2',
  accent3: 'accent3',
  accent4: 'accent4',
  accent5: 'accent5',
  accent6: 'accent6',
  hlink: 'hlink',
  folHlink: 'folHlink',
}

function emptyLevelStyles(): XmlElement[] {
  // One level-1 entry is enough for PowerPoint; the exporter's slides state
  // their own text properties, so nothing here reaches imported text.
  return [el('a:lvl1pPr', { marL: 0, indent: 0 })]
}

export function slideMasterPart(layoutRelId: string): string {
  return xmlDocument(
    el(
      'p:sldMaster',
      xmlns('a', 'r', 'p'),
      // No background: a slide without one of its own imports as having none
      // (the model's default white), where a master background would come
      // back as an explicit white on every slide. PowerPoint draws white too.
      tag('p:cSld', tag('p:spTree', emptyGroupNvAndProps())),
      el('p:clrMap', CLR_MAP),
      tag('p:sldLayoutIdLst', el('p:sldLayoutId', { id: 2147483649, 'r:id': layoutRelId })),
      tag(
        'p:txStyles',
        tag('p:titleStyle', emptyLevelStyles()),
        tag('p:bodyStyle', emptyLevelStyles()),
        tag('p:otherStyle', emptyLevelStyles()),
      ),
    ),
  )
}

export function slideLayoutPart(): string {
  return xmlDocument(
    el(
      'p:sldLayout',
      { ...xmlns('a', 'r', 'p'), type: 'blank', preserve: 1 },
      el('p:cSld', { name: 'Blank' }, tag('p:spTree', emptyGroupNvAndProps())),
      tag('p:clrMapOvr', tag('a:masterClrMapping')),
    ),
  )
}

export function notesMasterPart(): string {
  return xmlDocument(
    el(
      'p:notesMaster',
      xmlns('a', 'r', 'p'),
      // No background: a slide without one of its own imports as having none
      // (the model's default white), where a master background would come
      // back as an explicit white on every slide. PowerPoint draws white too.
      tag('p:cSld', tag('p:spTree', emptyGroupNvAndProps())),
      el('p:clrMap', CLR_MAP),
    ),
  )
}

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

const srgb = (hex: string): XmlElement => el('a:srgbClr', { val: hex })
const sysClr = (val: string, lastClr: string): XmlElement => el('a:sysClr', { val, lastClr })

function solidPh(): XmlElement {
  return tag('a:solidFill', el('a:schemeClr', { val: 'phClr' }))
}

function line(w: number): XmlElement {
  return el(
    'a:ln',
    { w, cap: 'flat', cmpd: 'sng', algn: 'ctr' },
    solidPh(),
    el('a:prstDash', { val: 'solid' }),
    tag('a:miter', undefined),
  )
}

export function themePart(name = 'Narrative'): string {
  const fontScheme = el(
    'a:fontScheme',
    { name },
    tag(
      'a:majorFont',
      el('a:latin', { typeface: 'Arial' }),
      el('a:ea', { typeface: '' }),
      el('a:cs', { typeface: '' }),
    ),
    tag(
      'a:minorFont',
      el('a:latin', { typeface: 'Arial' }),
      el('a:ea', { typeface: '' }),
      el('a:cs', { typeface: '' }),
    ),
  )
  return xmlDocument(
    el(
      'a:theme',
      { 'xmlns:a': NS.a, name },
      tag(
        'a:themeElements',
        el(
          'a:clrScheme',
          { name },
          tag('a:dk1', sysClr('windowText', '000000')),
          tag('a:lt1', sysClr('window', 'FFFFFF')),
          tag('a:dk2', srgb('44546A')),
          tag('a:lt2', srgb('E7E6E6')),
          tag('a:accent1', srgb('4472C4')),
          tag('a:accent2', srgb('ED7D31')),
          tag('a:accent3', srgb('A5A5A5')),
          tag('a:accent4', srgb('FFC000')),
          tag('a:accent5', srgb('5B9BD5')),
          tag('a:accent6', srgb('70AD47')),
          tag('a:hlink', srgb('0563C1')),
          tag('a:folHlink', srgb('954F72')),
        ),
        fontScheme,
        el(
          'a:fmtScheme',
          { name },
          tag('a:fillStyleLst', solidPh(), solidPh(), solidPh()),
          tag('a:lnStyleLst', line(6350), line(12700), line(19050)),
          tag(
            'a:effectStyleLst',
            tag('a:effectStyle', tag('a:effectLst')),
            tag('a:effectStyle', tag('a:effectLst')),
            tag('a:effectStyle', tag('a:effectLst')),
          ),
          tag('a:bgFillStyleLst', solidPh(), solidPh(), solidPh()),
        ),
      ),
      tag('a:objectDefaults'),
      tag('a:extraClrSchemeLst'),
    ),
  )
}
