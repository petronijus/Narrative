/**
 * pptx/ooxml/table.ts
 *
 * TableObject → `<p:graphicFrame>` with an `<a:tbl>`.
 *
 * The native table is complete for PowerPoint: the grid, row heights,
 * merges (`gridSpan`/`rowSpan` on the origin, `hMerge`/`vMerge` on covered
 * cells), every cell's effective text formatting, padding, anchor, fill and
 * four edges resolved from the model's border segments. The importer derives
 * a table's `defaults` from uniform cell values and invents a default border,
 * so the model's own split between `defaults`, per-cell overrides and
 * `borderSegments` cannot be recovered from the cells; it rides in the
 * Narrative extension. Cell text always comes from the native XML.
 */

import type { TableBorderStyle, TableCell, TableObject, TextObject } from '@narrative/shared'
import { getEffectiveBorderSegment, hSegKey, rotationToDegrees, vSegKey } from '@narrative/shared'
import { el, tag, type XmlChild, type XmlElement } from './xml.js'
import { writeSolidFill } from './color.js'
import { writeFill, type FillModel } from './fill.js'
import { degToAngle, pxToEmu } from './units.js'
import { ANCHOR, BORDER_DASH } from './vocabulary.js'
import { writeNarrativeExt, type FrameFingerprint } from './narrativeExt.js'
import { objectExtValues } from './objectExt.js'
import { writeTextBody } from './text.js'
import { pictureFill, type Rect, type ShapeWriteContext } from './shapes.js'

const TABLE_URI = 'http://schemas.openxmlformats.org/drawingml/2006/table'

function border(
  name: 'a:lnL' | 'a:lnR' | 'a:lnT' | 'a:lnB',
  b: TableBorderStyle | undefined,
): XmlElement {
  if (b === undefined || !(b.width > 0)) return tag(name, tag('a:noFill'))
  return el(
    name,
    { w: pxToEmu(b.width) },
    writeSolidFill(b.color as number, b.alpha),
    el('a:prstDash', { val: BORDER_DASH.toXml(b.dash ?? 'solid') }),
  )
}

/**
 * A cell's fill: its own or the table default's gradient or picture, else
 * the solid colour. A picture is fitted into the cell's own box, as the
 * renderer draws it.
 */
async function cellFill(
  cell: TableCell,
  t: TableObject,
  box: Rect,
  ctx: ShapeWriteContext,
): Promise<XmlChild> {
  const fs = cell.fillStyle ?? t.defaults.fillStyle
  if (fs?.kind === 'image') {
    const picture = await pictureFill(fs.assetId, fs.fit ?? 'cover', box, ctx)
    if (picture !== null) return picture
  }
  return writeFill(solidOrGradient(cell, t))
}

function solidOrGradient(cell: TableCell, t: TableObject): FillModel {
  const fs = cell.fillStyle ?? t.defaults.fillStyle
  if (fs !== undefined && fs.kind !== 'image') {
    return fs.kind === 'linearGradient'
      ? {
          kind: 'gradient',
          gradient: { kind: 'linearGradient', angleDeg: fs.angleDeg, stops: fs.stops },
        }
      : {
          kind: 'gradient',
          gradient: {
            kind: 'radialGradient',
            stops: fs.stops,
            ...(fs.centerX !== undefined ? { centerX: fs.centerX } : {}),
            ...(fs.centerY !== undefined ? { centerY: fs.centerY } : {}),
          },
        }
  }
  const fill = cell.fill ?? t.defaults.fill
  if (fill === undefined) return { kind: 'none' }
  const alpha = cell.fillAlpha ?? t.defaults.fillAlpha
  return alpha !== undefined && alpha < 1
    ? { kind: 'solid', color: fill as number, alpha }
    : { kind: 'solid', color: fill as number }
}

/** A TextObject standing in for a cell, so cell text uses the one text writer. */
function cellAsText(cell: TableCell, t: TableObject): TextObject {
  const d = t.defaults
  const o: TextObject = {
    id: '',
    type: 'text',
    x: 0,
    y: 0,
    width: 1,
    height: 1,
    rotation: 0,
    opacity: 1,
    text: cell.text,
    fontSize: cell.fontSize ?? d.fontSize,
    fontWeight: cell.fontWeight ?? d.fontWeight,
    color: (cell.color ?? d.color) as number,
    align: cell.align ?? d.align,
  }
  const italic = cell.italic ?? d.italic
  if (italic !== undefined) o.italic = italic
  const underline = cell.underline ?? d.underline
  if (underline !== undefined) o.underline = underline
  if (d.fontFamily !== undefined) o.fontFamily = d.fontFamily
  const lh = cell.lineHeight ?? d.lineHeight
  if (lh !== undefined) o.lineHeight = lh
  const ls = cell.letterSpacing ?? d.letterSpacing
  if (ls !== undefined) o.letterSpacing = ls
  const tt = cell.textTransform ?? d.textTransform
  if (tt !== undefined) o.textTransform = tt
  if (d.paragraphSpaceBefore !== undefined) o.paragraphSpaceBefore = d.paragraphSpaceBefore
  if (d.paragraphSpaceAfter !== undefined) o.paragraphSpaceAfter = d.paragraphSpaceAfter
  return o
}

export async function writeTable(
  t: TableObject,
  id: number,
  ctx: ShapeWriteContext,
): Promise<XmlElement> {
  const h = t.hyperlink
  const slideRel = h?.kind === 'slide' ? ctx.slideRelId(h.slideId) : undefined
  const hyperlink: XmlChild =
    h?.kind === 'url'
      ? el('a:hlinkClick', { 'r:id': ctx.hyperlinkRelId(h.href) })
      : slideRel !== undefined
        ? el('a:hlinkClick', { 'r:id': slideRel, action: 'ppaction://hlinksldjump' })
        : null
  const frame: FrameFingerprint = {
    x: pxToEmu(t.x),
    y: pxToEmu(t.y),
    cx: pxToEmu(t.width),
    cy: pxToEmu(t.height),
    rot: t.rotation !== 0 ? degToAngle(rotationToDegrees(t.rotation)) : 0,
  }
  const ext = writeNarrativeExt(objectExtValues(t), frame)
  const cols = t.colWidths.length
  // Each cell's box on the slide (a merged origin spans its columns and
  // rows), for fitting picture fills.
  const colX = t.colWidths.reduce<number[]>((acc, w) => [...acc, acc[acc.length - 1]! + w], [0])
  const rowY = t.rowHeights.reduce<number[]>((acc, h) => [...acc, acc[acc.length - 1]! + h], [0])
  const rows: XmlElement[] = await Promise.all(
    t.rows.map(async (row, r) =>
      el(
        'a:tr',
        { h: pxToEmu(t.rowHeights[r] ?? 0) },
        await Promise.all(
          Array.from({ length: cols }, async (_, c) => {
            const cell = row[c] ?? { text: '' }
            const covered = cell.mergeOriginR !== undefined && cell.mergeOriginC !== undefined
            const hMerge = covered && cell.mergeOriginR === r && cell.mergeOriginC !== c
            const vMerge = covered && cell.mergeOriginR !== r
            const pad = cell.padding ?? t.defaults.padding
            const span = { cols: cell.gridSpan ?? 1, rows: cell.rowSpan ?? 1 }
            const edge = (key: string): TableBorderStyle | undefined =>
              getEffectiveBorderSegment(t, key) ?? t.defaults.border
            const box: Rect = {
              x: t.x + colX[c]!,
              y: t.y + rowY[r]!,
              width: colX[Math.min(cols, c + span.cols)]! - colX[c]!,
              height: rowY[Math.min(t.rows.length, r + span.rows)]! - rowY[r]!,
            }
            const tcPr = el(
              'a:tcPr',
              {
                marL: pxToEmu(pad.left),
                marR: pxToEmu(pad.right),
                marT: pxToEmu(pad.top),
                marB: pxToEmu(pad.bottom),
                anchor: ANCHOR.toXml(cell.vAlign ?? t.defaults.vAlign),
              },
              border('a:lnL', edge(vSegKey(r, c))),
              border('a:lnR', edge(vSegKey(r, c + span.cols))),
              border('a:lnT', edge(hSegKey(r, c))),
              border('a:lnB', edge(hSegKey(r + span.rows, c))),
              await cellFill(cell, t, box, ctx),
            )
            const body: XmlChild = covered
              ? tag('a:txBody', tag('a:bodyPr'), tag('a:lstStyle'), tag('a:p'))
              : writeTextBody(cellAsText(cell, t), ctx, 'a:txBody')
            return el(
              'a:tc',
              {
                gridSpan: !covered && span.cols > 1 ? span.cols : undefined,
                rowSpan: !covered && span.rows > 1 ? span.rows : undefined,
                hMerge: hMerge ? 1 : undefined,
                vMerge: vMerge ? 1 : undefined,
              },
              body,
              tcPr,
            )
          }),
        ),
      ),
    ),
  )
  return tag(
    'p:graphicFrame',
    tag(
      'p:nvGraphicFramePr',
      el('p:cNvPr', { id, name: t.name ?? `table ${id}` }, hyperlink, ext),
      tag(
        'p:cNvGraphicFramePr',
        el('a:graphicFrameLocks', {
          noGrp: 1,
          noChangeAspect: t.aspectLocked === true ? 1 : undefined,
        }),
      ),
      tag('p:nvPr'),
    ),
    el(
      'p:xfrm',
      { rot: frame.rot !== 0 ? frame.rot : undefined },
      el('a:off', { x: frame.x, y: frame.y }),
      el('a:ext', { cx: frame.cx, cy: frame.cy }),
    ),
    tag(
      'a:graphic',
      el(
        'a:graphicData',
        { uri: TABLE_URI },
        tag(
          'a:tbl',
          el('a:tblPr', { firstRow: 0, bandRow: 0 }),
          tag(
            'a:tblGrid',
            t.colWidths.map((w) => el('a:gridCol', { w: pxToEmu(w) })),
          ),
          rows,
        ),
      ),
    ),
  )
}
