/**
 * pptx/ooxml/writeDeck.ts
 *
 * Narrative slides → a .pptx package, written directly as OOXML.
 *
 * This replaces the pptxgenjs-based exporter. Every element is produced by
 * the modules in this directory, which share units, vocabulary and — element
 * by element — reading code with the importer, and the result is held to
 * two checks: every part validates against the ECMA-376 schemas
 * (ooxml/validate.test.ts), and import → export → import returns the same
 * model (pptx/roundtrip.ts).
 */

import JSZip from 'jszip'
import sharp from 'sharp'
import type { AnimationStep, Slide, SlideBackground, SlideObject } from '@narrative/shared'
import { computeSlideNumber, rotationToDegrees } from '@narrative/shared'
import { el, tag, xmlDocument, xmlns, type XmlElement } from './xml.js'
import {
  CT,
  REL,
  contentTypesPart,
  corePropsPart,
  emptyGroupNvAndProps,
  extendedPropsPart,
  notesMasterPart,
  presentationPart,
  presPropsPart,
  relationshipsPart,
  slideLayoutPart,
  slideMasterPart,
  tableStylesPart,
  themePart,
  viewPropsPart,
  type Relationship,
} from './package.js'
import {
  writeImage,
  writeLineObject,
  writeParametricShape,
  writePath,
  writeTextShape,
  writeVideo,
  type ShapeWriteContext,
} from './shapes.js'
import { writeTable } from './table.js'
import { writeSlideExt } from './narrativeExt.js'
import { writeNotesBody, writeNotesExt, type NotesDoc } from './notes.js'
import type { PixelSize } from './shapes.js'
import { writeTransition } from './transition.js'
import { writeTiming, type AnimatedTarget } from './timing.js'
import { writeFill, type FillModel } from './fill.js'
import { fractionToPercent, pxToEmu } from './units.js'

export type AssetLoader = (assetId: string) => Promise<{ bytes: Buffer; mimeType: string } | null>

export interface WriteDeckOptions {
  title?: string
  author?: string
  assetLoader?: AssetLoader
  /** Speaker notes as plain text per slide id. */
  /** Speaker notes per slide id: the notes editor's document (ooxml/notes.ts). */
  notesBySlideId?: ReadonlyMap<string, NotesDoc>
  /** Fixed timestamp for reproducible output (tests). */
  now?: Date
}

// ---------------------------------------------------------------------------
// Media
// ---------------------------------------------------------------------------

const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpeg',
  'image/jpg': 'jpeg',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
  'image/webp': 'webp',
  'image/tiff': 'tiff',
  'image/bmp': 'bmp',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
  'video/x-msvideo': 'avi',
  'video/x-ms-wmv': 'wmv',
}

/** The registered content type for each extension written. */
const CONTENT_TYPE_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  webp: 'image/webp',
  tiff: 'image/tiff',
  bmp: 'image/bmp',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  avi: 'video/x-msvideo',
  wmv: 'video/x-ms-wmv',
  bin: 'application/octet-stream',
}

interface MediaPart {
  path: string
  ext: string
  mimeType: string
}

class MediaStore {
  private readonly byAsset = new Map<string, MediaPart | null>()
  private readonly sizes = new Map<string, PixelSize | null>()
  private readonly bytesByAsset = new Map<string, Buffer>()
  readonly parts = new Map<string, Buffer>()
  readonly defaults = new Map<string, string>()
  private n = 0

  constructor(private readonly loader: AssetLoader | undefined) {}

  async part(assetId: string): Promise<MediaPart | null> {
    if (this.byAsset.has(assetId)) return this.byAsset.get(assetId) ?? null
    const asset = this.loader !== undefined ? await this.loader(assetId) : null
    if (asset === null) {
      this.byAsset.set(assetId, null)
      return null
    }
    const ext = EXT_BY_MIME[asset.mimeType.toLowerCase()] ?? 'bin'
    const kind = asset.mimeType.startsWith('video/') ? 'media' : 'image'
    const path = `ppt/media/${kind}${++this.n}.${ext}`
    const part = { path, ext, mimeType: asset.mimeType }
    this.parts.set(path, asset.bytes)
    this.bytesByAsset.set(assetId, asset.bytes)
    this.defaults.set(ext, CONTENT_TYPE_BY_EXT[ext] ?? 'application/octet-stream')
    this.byAsset.set(assetId, part)
    return part
  }

  /**
   * A picture's pixel size, which the renderer fits it by. Undefined for
   * media sharp cannot read (video, EMF): the picture is then stretched to
   * its box, which is the best PowerPoint can be told.
   */
  async pixelSize(assetId: string): Promise<PixelSize | undefined> {
    if (this.sizes.has(assetId)) return this.sizes.get(assetId) ?? undefined
    await this.part(assetId)
    const bytes = this.bytesByAsset.get(assetId)
    let size: PixelSize | null = null
    if (bytes !== undefined) {
      try {
        const m = await sharp(bytes).metadata()
        // EXIF orientations 5–8 turn the picture a quarter: the renderer
        // (like the browser) shows it upright, width and height swapped.
        const quarter = m.orientation !== undefined && m.orientation >= 5
        if (m.width !== undefined && m.height !== undefined && m.width > 0 && m.height > 0) {
          size = quarter
            ? { width: m.height, height: m.width }
            : { width: m.width, height: m.height }
        }
      } catch {
        size = null
      }
    }
    this.sizes.set(assetId, size)
    return size ?? undefined
  }
}

// ---------------------------------------------------------------------------
// Per-slide relationships
// ---------------------------------------------------------------------------

class SlideRels {
  private readonly rels: Relationship[] = []
  private readonly byKey = new Map<string, string>()

  add(type: string, target: string, external = false): string {
    const key = `${type}|${target}|${external ? 1 : 0}`
    const existing = this.byKey.get(key)
    if (existing !== undefined) return existing
    const id = `rId${this.rels.length + 1}`
    this.rels.push(external ? { id, type, target, external } : { id, type, target })
    this.byKey.set(key, id)
    return id
  }

  get all(): readonly Relationship[] {
    return this.rels
  }
}

// ---------------------------------------------------------------------------
// Objects and groups
// ---------------------------------------------------------------------------

async function writeObject(
  o: SlideObject,
  id: number,
  ctx: ShapeWriteContext,
): Promise<XmlElement | null> {
  switch (o.type) {
    case 'rectangle':
    case 'ellipse':
    case 'triangle':
    case 'polygon':
      return writeParametricShape(o, id, ctx)
    case 'path':
      return o.anchors.length > 0 ? writePath(o, id, ctx) : null
    case 'line':
    case 'arrow':
      return writeLineObject(o, id, ctx)
    case 'text':
      return writeTextShape(o, id, ctx)
    case 'image':
      return writeImage(o, id, ctx)
    case 'video':
      return writeVideo(o, id, ctx)
    case 'table':
      return writeTable(o, id, ctx)
    default:
      return null
  }
}

/** The bounding box of objects in canvas px, ignoring rotation. */
function bbox(objs: readonly SlideObject[]): { x: number; y: number; w: number; h: number } {
  const x = Math.min(...objs.map((o) => o.x))
  const y = Math.min(...objs.map((o) => o.y))
  const r = Math.max(...objs.map((o) => o.x + o.width))
  const b = Math.max(...objs.map((o) => o.y + o.height))
  return { x, y, w: r - x, h: b - y }
}

/**
 * Objects in paint order, with each group's members gathered at the
 * position of its first member. Narrative groups are an attribute and need
 * not be contiguous; `<p:grpSp>` is. Members that were apart move up to the
 * first — the one paint-order change export can make.
 */
function paintUnits(objs: readonly SlideObject[]): Array<SlideObject | SlideObject[]> {
  const out: Array<SlideObject | SlideObject[]> = []
  const groups = new Map<string, SlideObject[]>()
  for (const o of objs) {
    if (o.groupId === undefined) {
      out.push(o)
      continue
    }
    const g = groups.get(o.groupId)
    if (g !== undefined) g.push(o)
    else {
      const members = [o]
      groups.set(o.groupId, members)
      out.push(members)
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Background and slide extension
// ---------------------------------------------------------------------------

async function writeBackground(
  bg: SlideBackground | undefined,
  media: MediaStore,
  rels: SlideRels,
): Promise<{ element: XmlElement | null; ext: Record<string, unknown> }> {
  if (bg === undefined) return { element: null, ext: {} }
  const ext: Record<string, unknown> = {}
  let fill: XmlElement
  if (bg.kind === 'color') {
    const f: FillModel = { kind: 'solid', color: bg.color }
    if (bg.alpha !== undefined && bg.alpha < 1) f.alpha = bg.alpha
    fill = writeFill(f)
  } else if (bg.kind === 'linearGradient') {
    fill = writeFill({
      kind: 'gradient',
      gradient: { kind: 'linearGradient', angleDeg: bg.angleDeg, stops: bg.stops },
    })
  } else if (bg.kind === 'radialGradient') {
    fill = writeFill({
      kind: 'gradient',
      gradient: {
        kind: 'radialGradient',
        stops: bg.stops,
        centerX: bg.centerX,
        centerY: bg.centerY,
      },
    })
    if (bg.radius !== 0.5) ext['background'] = { kind: 'radialGradient', radius: bg.radius }
  } else {
    const part = await media.part(bg.assetId)
    if (part === null) return { element: null, ext: {} }
    const rid = rels.add(REL.image, `../media/${part.path.split('/').pop()}`)
    if (bg.fit !== 'cover') ext['background'] = { kind: 'image', fit: bg.fit }
    fill = tag(
      'a:blipFill',
      el(
        'a:blip',
        { 'r:embed': rid },
        // Dimming darkens the picture; PowerPoint's nearest is brightness.
        bg.dim !== undefined && bg.dim > 0 && el('a:lum', { bright: -fractionToPercent(bg.dim) }),
      ),
      tag('a:stretch', tag('a:fillRect')),
    )
  }
  return { element: tag('p:bg', tag('p:bgPr', fill, tag('a:effectLst'))), ext }
}

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------

function notesSlidePart(doc: NotesDoc, rels: SlideRels): string {
  const body = writeNotesBody(doc, {
    hyperlinkRelId: (href) => rels.add(REL.hyperlink, href, true),
  })
  return xmlDocument(
    el(
      'p:notes',
      xmlns('a', 'r', 'p'),
      tag(
        'p:cSld',
        tag(
          'p:spTree',
          emptyGroupNvAndProps(),
          tag(
            'p:sp',
            tag(
              'p:nvSpPr',
              el('p:cNvPr', { id: 2, name: 'Slide Image Placeholder 1' }),
              tag('p:cNvSpPr', el('a:spLocks', { noGrp: 1, noRot: 1, noChangeAspect: 1 })),
              tag('p:nvPr', el('p:ph', { type: 'sldImg' })),
            ),
            tag('p:spPr'),
          ),
          tag(
            'p:sp',
            tag(
              'p:nvSpPr',
              el('p:cNvPr', { id: 3, name: 'Notes Placeholder 2' }),
              tag('p:cNvSpPr', el('a:spLocks', { noGrp: 1 })),
              tag('p:nvPr', el('p:ph', { type: 'body', idx: 1 })),
            ),
            tag('p:spPr'),
            tag('p:txBody', tag('a:bodyPr'), tag('a:lstStyle'), body.paragraphs),
          ),
        ),
      ),
      tag('p:clrMapOvr', tag('a:masterClrMapping')),
      writeNotesExt(doc, body.text),
    ),
  )
}

// ---------------------------------------------------------------------------
// Deck
// ---------------------------------------------------------------------------

export async function writeDeck(
  slides: readonly Slide[],
  options: WriteDeckOptions = {},
): Promise<Buffer> {
  const zip = new JSZip()
  const media = new MediaStore(options.assetLoader)
  const overrides: Array<{ partName: string; contentType: string }> = []
  const put = (path: string, content: string | Buffer, contentType?: string): void => {
    zip.file(path, content)
    if (contentType !== undefined) overrides.push({ partName: `/${path}`, contentType })
  }

  const hasNotes = slides.some((s) => (options.notesBySlideId?.get(s.id)?.length ?? 0) > 0)
  const slideIndexById = new Map(slides.map((s, i) => [s.id, i]))

  // Presentation-level relationships: master, slides, notes master, props.
  const presRels = new SlideRels()
  const masterRid = presRels.add(REL.slideMaster, 'slideMasters/slideMaster1.xml')
  const slideRids = slides.map((_, i) => presRels.add(REL.slide, `slides/slide${i + 1}.xml`))
  const notesMasterRid = hasNotes
    ? presRels.add(REL.notesMaster, 'notesMasters/notesMaster1.xml')
    : undefined
  presRels.add(REL.presProps, 'presProps.xml')
  presRels.add(REL.viewProps, 'viewProps.xml')
  presRels.add(REL.theme, 'theme/theme1.xml')
  presRels.add(REL.tableStyles, 'tableStyles.xml')

  for (let i = 0; i < slides.length; i++) {
    const slide = slides[i]!
    const rels = new SlideRels()
    rels.add(REL.slideLayout, '../slideLayouts/slideLayout1.xml')
    let nextId = 2
    const spidByObject = new Map<string, number>()
    const slideNumber = computeSlideNumber(slides, slide.id) ?? i + 1

    const ctx: ShapeWriteContext = {
      slideNumber,
      hyperlinkRelId: (href) => rels.add(REL.hyperlink, href, true),
      slideRelId: (slideId) => {
        const j = slideIndexById.get(slideId)
        return j === undefined ? undefined : rels.add(REL.slide, `slide${j + 1}.xml`)
      },
      imageRelId: async (assetId) => {
        const part = await media.part(assetId)
        return part === null
          ? undefined
          : rels.add(REL.image, `../media/${part.path.split('/').pop()}`)
      },
      pixelSize: (assetId) => media.pixelSize(assetId),
      videoRelIds: async (assetId) => {
        const part = await media.part(assetId)
        if (part === null) return undefined
        const target = `../media/${part.path.split('/').pop()}`
        return { video: rels.add(REL.video, target), media: rels.add(REL.media, target) }
      },
    }

    const shapes: XmlElement[] = []
    for (const unit of paintUnits(slide.objects)) {
      if (!Array.isArray(unit)) {
        const id = nextId++
        const x = await writeObject(unit, id, ctx)
        if (x !== null) {
          shapes.push(x)
          spidByObject.set(unit.id, id)
        }
        continue
      }
      const groupId = nextId++
      const members: XmlElement[] = []
      for (const o of unit) {
        const id = nextId++
        const x = await writeObject(o, id, ctx)
        if (x !== null) {
          members.push(x)
          spidByObject.set(o.id, id)
        }
      }
      if (members.length === 0) continue
      const b = bbox(unit)
      const off = { x: pxToEmu(b.x), y: pxToEmu(b.y) }
      const ext = { cx: pxToEmu(b.w), cy: pxToEmu(b.h) }
      shapes.push(
        tag(
          'p:grpSp',
          tag(
            'p:nvGrpSpPr',
            el('p:cNvPr', { id: groupId, name: `group ${groupId}` }),
            tag('p:cNvGrpSpPr'),
            tag('p:nvPr'),
          ),
          tag(
            'p:grpSpPr',
            tag(
              'a:xfrm',
              el('a:off', off),
              el('a:ext', ext),
              el('a:chOff', { x: off.x, y: off.y }),
              el('a:chExt', { cx: ext.cx, cy: ext.cy }),
            ),
          ),
          members,
        ),
      )
    }

    const bg = await writeBackground(slide.background, media, rels)
    const targetOf = (objectId: string): AnimatedTarget | undefined => {
      const spid = spidByObject.get(objectId)
      const o = slide.objects.find((x) => x.id === objectId)
      if (spid === undefined || o === undefined) return undefined
      return { spid, x: o.x, y: o.y, rotationDeg: rotationToDegrees(o.rotation) }
    }
    const timing = writeTiming(slide.animations as AnimationStep[], targetOf)

    const extValues: Record<string, unknown> = { ...bg.ext }
    if (slide.indent !== undefined && slide.indent !== 0) extValues['indent'] = slide.indent
    if (slide.collapsed === true) extValues['collapsed'] = true
    // An explicit "no transition" is still a choice the deck made.
    if (slide.transition.kind === 'none' && slide.transition.durationMs !== 0) {
      extValues['transition'] = slide.transition
    }

    const notes = options.notesBySlideId?.get(slide.id)
    if (notes !== undefined && notes.length > 0) {
      const notesPath = `ppt/notesSlides/notesSlide${i + 1}.xml`
      rels.add(REL.notesSlide, `../notesSlides/notesSlide${i + 1}.xml`)
      const notesRels = new SlideRels()
      notesRels.add(REL.notesMaster, '../notesMasters/notesMaster1.xml')
      notesRels.add(REL.slide, `../slides/slide${i + 1}.xml`)
      put(notesPath, notesSlidePart(notes, notesRels), CT.notesSlide)
      zip.file(
        `ppt/notesSlides/_rels/notesSlide${i + 1}.xml.rels`,
        relationshipsPart(notesRels.all),
      )
    }

    const sld = el(
      'p:sld',
      { ...xmlns('a', 'r', 'p'), show: slide.skipped === true ? 0 : undefined },
      el(
        'p:cSld',
        { name: slide.name !== undefined && slide.name !== '' ? slide.name : undefined },
        bg.element,
        tag('p:spTree', emptyGroupNvAndProps(), shapes),
      ),
      tag('p:clrMapOvr', tag('a:masterClrMapping')),
      writeTransition(slide.transition),
      timing,
      writeSlideExt(extValues),
    )
    put(`ppt/slides/slide${i + 1}.xml`, xmlDocument(sld), CT.slide)
    zip.file(`ppt/slides/_rels/slide${i + 1}.xml.rels`, relationshipsPart(rels.all))
  }

  // Package parts.
  put(
    'ppt/presentation.xml',
    presentationPart({
      masterRelId: masterRid,
      notesMasterRelId: notesMasterRid,
      slideRelIds: slideRids,
    }),
    CT.presentation,
  )
  zip.file('ppt/_rels/presentation.xml.rels', relationshipsPart(presRels.all))
  put('ppt/slideMasters/slideMaster1.xml', slideMasterPart('rId1'), CT.slideMaster)
  zip.file(
    'ppt/slideMasters/_rels/slideMaster1.xml.rels',
    relationshipsPart([
      { id: 'rId1', type: REL.slideLayout, target: '../slideLayouts/slideLayout1.xml' },
      { id: 'rId2', type: REL.theme, target: '../theme/theme1.xml' },
    ]),
  )
  put('ppt/slideLayouts/slideLayout1.xml', slideLayoutPart(), CT.slideLayout)
  zip.file(
    'ppt/slideLayouts/_rels/slideLayout1.xml.rels',
    relationshipsPart([
      { id: 'rId1', type: REL.slideMaster, target: '../slideMasters/slideMaster1.xml' },
    ]),
  )
  put('ppt/theme/theme1.xml', themePart(), CT.theme)
  if (hasNotes) {
    put('ppt/notesMasters/notesMaster1.xml', notesMasterPart(), CT.notesMaster)
    zip.file(
      'ppt/notesMasters/_rels/notesMaster1.xml.rels',
      relationshipsPart([{ id: 'rId1', type: REL.theme, target: '../theme/theme2.xml' }]),
    )
    put('ppt/theme/theme2.xml', themePart('Narrative Notes'), CT.theme)
  }
  put('ppt/presProps.xml', presPropsPart(), CT.presProps)
  put('ppt/viewProps.xml', viewPropsPart(), CT.viewProps)
  put('ppt/tableStyles.xml', tableStylesPart(), CT.tableStyles)
  for (const [path, bytes] of media.parts) zip.file(path, bytes)

  const now = options.now ?? new Date()
  const title = options.title ?? 'Narrative deck'
  const author = options.author ?? 'Narrative'
  put('docProps/core.xml', corePropsPart(title, author, now), CT.coreProps)
  put('docProps/app.xml', extendedPropsPart(slides.length), CT.extendedProps)
  zip.file(
    '_rels/.rels',
    relationshipsPart([
      { id: 'rId1', type: REL.officeDocument, target: 'ppt/presentation.xml' },
      { id: 'rId2', type: REL.coreProps, target: 'docProps/core.xml' },
      { id: 'rId3', type: REL.extendedProps, target: 'docProps/app.xml' },
    ]),
  )
  zip.file(
    '[Content_Types].xml',
    contentTypesPart(
      [...media.defaults].map(([extension, contentType]) => ({ extension, contentType })),
      overrides,
    ),
  )

  return Buffer.from(
    await zip.generateAsync({
      type: 'nodebuffer',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 },
    }),
  )
}
