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
import type { NotesDoc } from '@narrative/slide-model'
import { writeNotesBody, writeNotesExt } from './notes.js'
import { endPhase } from '../phases.js'
import { mapConcurrent } from '../../lib/concurrency.js'
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
  /** Speaker notes per slide id: the notes editor's document (ooxml/notes.ts). */
  notesBySlideId?: ReadonlyMap<string, NotesDoc>
  /**
   * When the deck was written: the package's modified date and the
   * timestamp of every zip entry. Fixed, it makes the output reproducible
   * byte for byte (tests).
   */
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

/**
 * Media formats that are compressed already: written STORE, since DEFLATE
 * gains a percent or two on them at the price of running JSZip's JavaScript
 * deflate over every byte (seconds per 100 MB; docs/plans/performance.md, X2).
 * PowerPoint reads stored entries like any other.
 */
const STORED_EXTS = new Set(['png', 'jpeg', 'gif', 'webp', 'mp4', 'mov', 'webm', 'avi', 'wmv'])

/** Assets fetched (and measured) at once before the slides are written. */
const EXPORT_MEDIA_CONCURRENCY = 6

interface MediaPart {
  path: string
  ext: string
  mimeType: string
}

type LoadedAsset = Awaited<ReturnType<AssetLoader>>

class MediaStore {
  private readonly byAsset = new Map<string, MediaPart | null>()
  private readonly sizes = new Map<string, Promise<PixelSize | null>>()
  private readonly loads = new Map<string, Promise<LoadedAsset>>()
  readonly parts = new Map<string, Buffer>()
  readonly defaults = new Map<string, string>()
  private n = 0

  constructor(private readonly loader: AssetLoader | undefined) {}

  /** The loader's answer for `assetId`, asked once. */
  private load(assetId: string): Promise<LoadedAsset> {
    let p = this.loads.get(assetId)
    if (p === undefined) {
      p = this.loader !== undefined ? this.loader(assetId) : Promise.resolve(null)
      this.loads.set(assetId, p)
    }
    return p
  }

  /**
   * Fetch every asset the slides name, and read the pictures' sizes, a few at
   * a time — the object store's round trips and sharp overlap instead of
   * running one after the other as the slides are written. Only a warm-up:
   * parts are still numbered by `part()`, in the order the slides reach them,
   * so the package does not depend on which fetch finished first.
   */
  async prefetch(assetIds: readonly string[]): Promise<void> {
    await mapConcurrent(assetIds, EXPORT_MEDIA_CONCURRENCY, async (assetId) => {
      const asset = await this.load(assetId)
      if (asset !== null && !asset.mimeType.startsWith('video/')) await this.pixelSize(assetId)
    })
  }

  async part(assetId: string): Promise<MediaPart | null> {
    if (this.byAsset.has(assetId)) return this.byAsset.get(assetId) ?? null
    const asset = await this.load(assetId)
    if (asset === null) {
      this.byAsset.set(assetId, null)
      return null
    }
    const ext = EXT_BY_MIME[asset.mimeType.toLowerCase()] ?? 'bin'
    const kind = asset.mimeType.startsWith('video/') ? 'media' : 'image'
    const path = `ppt/media/${kind}${++this.n}.${ext}`
    const part = { path, ext, mimeType: asset.mimeType }
    this.parts.set(path, asset.bytes)
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
    let size = this.sizes.get(assetId)
    if (size === undefined) {
      size = this.load(assetId).then((asset) =>
        asset === null ? null : readPixelSize(asset.bytes),
      )
      this.sizes.set(assetId, size)
    }
    return (await size) ?? undefined
  }
}

async function readPixelSize(bytes: Buffer): Promise<PixelSize | null> {
  try {
    const m = await sharp(bytes).metadata()
    // EXIF orientations 5–8 turn the picture a quarter: the renderer
    // (like the browser) shows it upright, width and height swapped.
    const quarter = m.orientation !== undefined && m.orientation >= 5
    if (m.width !== undefined && m.height !== undefined && m.width > 0 && m.height > 0) {
      return quarter ? { width: m.height, height: m.width } : { width: m.width, height: m.height }
    }
    return null
  } catch {
    return null
  }
}

/**
 * Every asset id the slides name, in the order they name them: any
 * `assetId` / `posterAssetId` field, at any depth (objects, fills, table
 * cells, backgrounds). Feeds `MediaStore.prefetch`; one it missed is simply
 * fetched when the slide that names it is written.
 */
function assetIdsOf(slides: readonly Slide[]): string[] {
  const ids = new Set<string>()
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) {
      for (const x of v) walk(x)
      return
    }
    if (v === null || typeof v !== 'object') return
    const proto = Object.getPrototypeOf(v) as unknown
    if (proto !== Object.prototype && proto !== null) return
    for (const [k, x] of Object.entries(v)) {
      if ((k === 'assetId' || k === 'posterAssetId') && typeof x === 'string') ids.add(x)
      else walk(x)
    }
  }
  for (const s of slides) {
    walk(s.background)
    walk(s.objects)
  }
  return [...ids]
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
  const now = options.now ?? new Date()
  const overrides: Array<{ partName: string; contentType: string }> = []
  /**
   * Every entry is a part, stamped `now`. Left to itself JSZip stamps each
   * with the moment it was added and adds an entry for every folder on the
   * way; folders are not parts of a package (PowerPoint writes none), and
   * the clock made two exports of one deck differ whenever they straddled
   * a tick of the zip's two-second time.
   */
  const put = (
    path: string,
    content: string | Buffer,
    contentType?: string,
    compression?: 'STORE',
  ): void => {
    zip.file(path, content, {
      date: now,
      createFolders: false,
      ...(compression !== undefined ? { compression } : {}),
    })
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

  await media.prefetch(assetIdsOf(slides))
  endPhase('export', 'assets')

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
      put(`ppt/notesSlides/_rels/notesSlide${i + 1}.xml.rels`, relationshipsPart(notesRels.all))
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
    put(`ppt/slides/_rels/slide${i + 1}.xml.rels`, relationshipsPart(rels.all))
  }

  endPhase('export', 'slides')

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
  put('ppt/_rels/presentation.xml.rels', relationshipsPart(presRels.all))
  put('ppt/slideMasters/slideMaster1.xml', slideMasterPart('rId1'), CT.slideMaster)
  put(
    'ppt/slideMasters/_rels/slideMaster1.xml.rels',
    relationshipsPart([
      { id: 'rId1', type: REL.slideLayout, target: '../slideLayouts/slideLayout1.xml' },
      { id: 'rId2', type: REL.theme, target: '../theme/theme1.xml' },
    ]),
  )
  put('ppt/slideLayouts/slideLayout1.xml', slideLayoutPart(), CT.slideLayout)
  put(
    'ppt/slideLayouts/_rels/slideLayout1.xml.rels',
    relationshipsPart([
      { id: 'rId1', type: REL.slideMaster, target: '../slideMasters/slideMaster1.xml' },
    ]),
  )
  put('ppt/theme/theme1.xml', themePart(), CT.theme)
  if (hasNotes) {
    put('ppt/notesMasters/notesMaster1.xml', notesMasterPart(), CT.notesMaster)
    put(
      'ppt/notesMasters/_rels/notesMaster1.xml.rels',
      relationshipsPart([{ id: 'rId1', type: REL.theme, target: '../theme/theme2.xml' }]),
    )
    put('ppt/theme/theme2.xml', themePart('Narrative Notes'), CT.theme)
  }
  put('ppt/presProps.xml', presPropsPart(), CT.presProps)
  put('ppt/viewProps.xml', viewPropsPart(), CT.viewProps)
  put('ppt/tableStyles.xml', tableStylesPart(), CT.tableStyles)
  for (const [path, bytes] of media.parts) {
    const ext = path.slice(path.lastIndexOf('.') + 1)
    put(path, bytes, undefined, STORED_EXTS.has(ext) ? 'STORE' : undefined)
  }

  const title = options.title ?? 'Narrative deck'
  const author = options.author ?? 'Narrative'
  put('docProps/core.xml', corePropsPart(title, author, now), CT.coreProps)
  put('docProps/app.xml', extendedPropsPart(slides.length), CT.extendedProps)
  put(
    '_rels/.rels',
    relationshipsPart([
      { id: 'rId1', type: REL.officeDocument, target: 'ppt/presentation.xml' },
      { id: 'rId2', type: REL.coreProps, target: 'docProps/core.xml' },
      { id: 'rId3', type: REL.extendedProps, target: 'docProps/app.xml' },
    ]),
  )
  put(
    '[Content_Types].xml',
    contentTypesPart(
      [...media.defaults].map(([extension, contentType]) => ({ extension, contentType })),
      overrides,
    ),
  )

  // `nodebuffer` is a Buffer already; copying it held the package twice.
  const out = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  })
  endPhase('export', 'zip')
  return out
}
