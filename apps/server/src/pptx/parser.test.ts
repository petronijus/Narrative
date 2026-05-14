/**
 * pptx/parser.test.ts
 *
 * Unit tests covering the regressions that hurt M28 iteration:
 *   - text frames in a `prstGeom="rect"` shell get classified as `text`,
 *     not `rectangle` (text body always wins over geom-derived kind)
 *   - `<a:schemeClr>` references resolve against the deck's theme1.xml
 *   - colour modifiers (`<a:lumMod>`, `<a:lumOff>`, `<a:alpha>`) apply
 *   - `<p:style><a:fillRef|lnRef|fontRef>` is read for shapes that omit
 *     inline solidFill / line in spPr (the common real-world PowerPoint case)
 *   - placeholder geometry / alignment / font size are inherited from the
 *     slide layout when the slide itself has empty spPr
 *
 * The fixtures are tiny hand-written zips so the assertions read clearly and
 * the tests stay fast (no pptxgenjs round-trip).
 */

import { describe, it, expect } from 'vitest'
import JSZip from 'jszip'
import { parsePptx } from './parser.js'

// ---------------------------------------------------------------------------
// Fixture builder
// ---------------------------------------------------------------------------

/** Build the bare minimum file tree that `parsePptx` looks for: a
 *  `ppt/presentation.xml` with one referenced slide, the slide's rels file,
 *  the slide XML, and an optional theme. */
async function makeFixture(opts: {
  slideXml: string
  themeXml?: string
  layoutXml?: string
  masterXml?: string
  notesXml?: string
  hyperlinks?: Array<{ id: string; url: string }>
}): Promise<Buffer> {
  const zip = new JSZip()
  zip.file(
    'ppt/presentation.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst>
  <p:sldSz cx="12192000" cy="6858000"/>
</p:presentation>`,
  )
  zip.file(
    'ppt/_rels/presentation.xml.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>
</Relationships>`,
  )
  zip.file('ppt/slides/slide1.xml', opts.slideXml)
  // Slide rels — layout, optional notes link, optional hyperlinks. Built
  // as a single Relationships element so we can interleave any of those
  // sources without splitting the rels file.
  const slideRelEntries: string[] = []
  let nextRid = 1
  if (opts.layoutXml !== undefined) {
    slideRelEntries.push(
      `<Relationship Id="rId${nextRid++}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>`,
    )
  }
  if (opts.notesXml !== undefined) {
    slideRelEntries.push(
      `<Relationship Id="rId${nextRid++}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide1.xml"/>`,
    )
    zip.file('ppt/notesSlides/notesSlide1.xml', opts.notesXml)
  }
  if (opts.hyperlinks !== undefined) {
    for (const link of opts.hyperlinks) {
      slideRelEntries.push(
        `<Relationship Id="${link.id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${link.url}" TargetMode="External"/>`,
      )
    }
  }
  if (slideRelEntries.length > 0) {
    zip.file(
      'ppt/slides/_rels/slide1.xml.rels',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${slideRelEntries.join('\n')}
</Relationships>`,
    )
  }
  if (opts.layoutXml !== undefined) {
    zip.file('ppt/slideLayouts/slideLayout1.xml', opts.layoutXml)
    if (opts.masterXml !== undefined) {
      zip.file(
        'ppt/slideLayouts/_rels/slideLayout1.xml.rels',
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/>
</Relationships>`,
      )
      zip.file('ppt/slideMasters/slideMaster1.xml', opts.masterXml)
    }
  }
  if (opts.themeXml !== undefined) {
    zip.file('ppt/theme/theme1.xml', opts.themeXml)
  }
  return Buffer.from(await zip.generateAsync({ type: 'nodebuffer' }))
}

const SLIDE_OPEN = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld><p:spTree>
    <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
    <p:grpSpPr/>`
const SLIDE_CLOSE = `</p:spTree></p:cSld></p:sld>`

const OFFICE_THEME = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <a:themeElements><a:clrScheme name="Test">
    <a:dk1><a:srgbClr val="000000"/></a:dk1>
    <a:lt1><a:srgbClr val="FFFFFF"/></a:lt1>
    <a:dk2><a:srgbClr val="44546A"/></a:dk2>
    <a:lt2><a:srgbClr val="E7E6E6"/></a:lt2>
    <a:accent1><a:srgbClr val="4472C4"/></a:accent1>
    <a:accent2><a:srgbClr val="ED7D31"/></a:accent2>
    <a:accent3><a:srgbClr val="A5A5A5"/></a:accent3>
    <a:accent4><a:srgbClr val="FFC000"/></a:accent4>
    <a:accent5><a:srgbClr val="5B9BD5"/></a:accent5>
    <a:accent6><a:srgbClr val="70AD47"/></a:accent6>
  </a:clrScheme></a:themeElements>
</a:theme>`

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('parsePptx', () => {
  it('treats a <p:sp> with prstGeom="rect" + non-empty <p:txBody> as text', async () => {
    const buf = await makeFixture({
      slideXml: `${SLIDE_OPEN}
        <p:sp>
          <p:nvSpPr><p:cNvPr id="2" name="t"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
          <p:spPr>
            <a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="914400"/></a:xfrm>
            <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
            <a:noFill/>
          </p:spPr>
          <p:txBody>
            <a:bodyPr/><a:lstStyle/>
            <a:p><a:r><a:rPr lang="en-US"/><a:t>Hello</a:t></a:r></a:p>
          </p:txBody>
        </p:sp>
      ${SLIDE_CLOSE}`,
    })
    const out = await parsePptx(buf)
    expect(out.slides).toHaveLength(1)
    expect(out.slides[0]!.shapes).toHaveLength(1)
    expect(out.slides[0]!.shapes[0]!.kind).toBe('text')
    expect(out.slides[0]!.shapes[0]!.text).toBe('Hello')
  })

  it('resolves <a:schemeClr> against theme1.xml', async () => {
    const buf = await makeFixture({
      themeXml: OFFICE_THEME,
      slideXml: `${SLIDE_OPEN}
        <p:sp>
          <p:nvSpPr><p:cNvPr id="2" name="r"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
          <p:spPr>
            <a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="914400"/></a:xfrm>
            <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
            <a:solidFill><a:schemeClr val="accent1"/></a:solidFill>
          </p:spPr>
        </p:sp>
      ${SLIDE_CLOSE}`,
    })
    const out = await parsePptx(buf)
    expect(out.slides[0]!.shapes[0]!.fillColor).toBe(0x4472c4)
  })

  it('applies lumMod / lumOff modifiers to a scheme colour', async () => {
    const buf = await makeFixture({
      themeXml: OFFICE_THEME,
      slideXml: `${SLIDE_OPEN}
        <p:sp>
          <p:nvSpPr><p:cNvPr id="2" name="r"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
          <p:spPr>
            <a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="914400"/></a:xfrm>
            <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
            <a:solidFill>
              <a:schemeClr val="accent1">
                <a:lumMod val="50000"/>
                <a:lumOff val="50000"/>
              </a:schemeClr>
            </a:solidFill>
          </p:spPr>
        </p:sp>
      ${SLIDE_CLOSE}`,
    })
    const out = await parsePptx(buf)
    const c = out.slides[0]!.shapes[0]!.fillColor!
    // lumMod 50% + lumOff 50% lightens accent1 substantially — the resulting
    // luminance should be well above the original (luma ~0.47 for #4472C4).
    const r = (c >> 16) & 0xff,
      g = (c >> 8) & 0xff,
      b = c & 0xff
    const luma = (0.299 * r + 0.587 * g + 0.114 * b) / 255
    expect(luma).toBeGreaterThan(0.6)
  })

  it('captures <a:alpha> on a colour descriptor', async () => {
    const buf = await makeFixture({
      themeXml: OFFICE_THEME,
      slideXml: `${SLIDE_OPEN}
        <p:sp>
          <p:nvSpPr><p:cNvPr id="2" name="r"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
          <p:spPr>
            <a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="914400"/></a:xfrm>
            <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
            <a:solidFill>
              <a:schemeClr val="accent1"><a:alpha val="50000"/></a:schemeClr>
            </a:solidFill>
          </p:spPr>
        </p:sp>
      ${SLIDE_CLOSE}`,
    })
    const out = await parsePptx(buf)
    expect(out.slides[0]!.shapes[0]!.fillAlpha).toBeCloseTo(0.5, 2)
  })

  it('reads fillRef + lnRef from <p:style> when spPr has no inline fill/line', async () => {
    const buf = await makeFixture({
      themeXml: OFFICE_THEME,
      slideXml: `${SLIDE_OPEN}
        <p:sp>
          <p:nvSpPr><p:cNvPr id="2" name="r"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
          <p:spPr>
            <a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="914400"/></a:xfrm>
            <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
          </p:spPr>
          <p:style>
            <a:lnRef idx="2"><a:schemeClr val="accent2"/></a:lnRef>
            <a:fillRef idx="1"><a:schemeClr val="accent1"/></a:fillRef>
            <a:effectRef idx="0"><a:schemeClr val="accent1"/></a:effectRef>
            <a:fontRef idx="minor"><a:schemeClr val="lt1"/></a:fontRef>
          </p:style>
        </p:sp>
      ${SLIDE_CLOSE}`,
    })
    const out = await parsePptx(buf)
    const shape = out.slides[0]!.shapes[0]!
    expect(shape.fillColor).toBe(0x4472c4) // accent1
    expect(shape.strokeColor).toBe(0xed7d31) // accent2
    // lnRef idx="2" → "moderate" stroke; the parser maps idx 2 → 2px default.
    expect(shape.strokeWidth).toBe(2)
  })

  it('inherits placeholder geometry + alignment + font size from the layout', async () => {
    const slideXml = `${SLIDE_OPEN}
      <p:sp>
        <p:nvSpPr>
          <p:cNvPr id="2" name="t"/><p:cNvSpPr/>
          <p:nvPr><p:ph type="subTitle" idx="1"/></p:nvPr>
        </p:nvSpPr>
        <p:spPr/>
        <p:txBody>
          <a:bodyPr/><a:lstStyle/>
          <a:p><a:r><a:rPr lang="en-US"/><a:t>Sub</a:t></a:r></a:p>
        </p:txBody>
      </p:sp>
    ${SLIDE_CLOSE}`
    const layoutXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld><p:spTree>
    <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
    <p:grpSpPr/>
    <p:sp>
      <p:nvSpPr>
        <p:cNvPr id="2" name="Subtitle 2"/><p:cNvSpPr/>
        <p:nvPr><p:ph type="subTitle" idx="1"/></p:nvPr>
      </p:nvSpPr>
      <p:spPr>
        <a:xfrm><a:off x="1524000" y="3602038"/><a:ext cx="9144000" cy="1655762"/></a:xfrm>
      </p:spPr>
      <p:txBody>
        <a:bodyPr anchor="ctr"/>
        <a:lstStyle>
          <a:lvl1pPr algn="ctr">
            <a:defRPr sz="2400"/>
          </a:lvl1pPr>
        </a:lstStyle>
      </p:txBody>
    </p:sp>
  </p:spTree></p:cSld>
</p:sldLayout>`
    const buf = await makeFixture({ slideXml, layoutXml, themeXml: OFFICE_THEME })
    const out = await parsePptx(buf)
    const shape = out.slides[0]!.shapes[0]!
    expect(shape.kind).toBe('text')
    expect(shape.x).toBeCloseTo(160, 0) // 1524000 / 9525
    expect(shape.y).toBeCloseTo(378.17, 1) // 3602038 / 9525
    expect(shape.textAlign).toBe('center')
    expect(shape.textVerticalAlign).toBe('middle')
    // PPTX 2400 (24pt) → px @ 96 DPI ≈ 32
    expect(shape.fontSize).toBeCloseTo(32, 1)
  })

  it('parses a multi-stop linear gradient with angle conversion', async () => {
    const buf = await makeFixture({
      themeXml: OFFICE_THEME,
      slideXml: `${SLIDE_OPEN}
        <p:sp>
          <p:nvSpPr><p:cNvPr id="2" name="r"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
          <p:spPr>
            <a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="914400"/></a:xfrm>
            <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
            <a:gradFill>
              <a:gsLst>
                <a:gs pos="0"><a:srgbClr val="FF0000"/></a:gs>
                <a:gs pos="100000"><a:srgbClr val="0000FF"/></a:gs>
              </a:gsLst>
              <a:lin ang="5400000" scaled="1"/>
            </a:gradFill>
          </p:spPr>
        </p:sp>
      ${SLIDE_CLOSE}`,
    })
    const out = await parsePptx(buf)
    const g = out.slides[0]!.shapes[0]!.fillGradient
    expect(g).toBeDefined()
    expect(g!.kind).toBe('linearGradient')
    expect(g!.stops).toHaveLength(2)
    expect(g!.stops[0]!.color).toBe(0xff0000)
    expect(g!.stops[1]!.color).toBe(0x0000ff)
    // PPTX 5400000 = 90° (clockwise from "right"); we add 90 to convert to
    // CSS "top→bottom = 0" → result 180 (i.e. bottom→top).
    if (g!.kind === 'linearGradient') {
      expect(g!.angleDeg).toBe(180)
    }
  })

  // ─── Per-run rich text + hyperlinks + notes ──────────────────────────────

  it('captures per-run bold + colour as textRuns on the parsed text shape', async () => {
    const buf = await makeFixture({
      themeXml: OFFICE_THEME,
      slideXml: `${SLIDE_OPEN}
        <p:sp>
          <p:nvSpPr><p:cNvPr id="2" name="t"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
          <p:spPr>
            <a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="914400"/></a:xfrm>
            <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
            <a:noFill/>
          </p:spPr>
          <p:txBody>
            <a:bodyPr/><a:lstStyle/>
            <a:p>
              <a:r><a:rPr lang="en-US" b="1"><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill></a:rPr><a:t>Red bold </a:t></a:r>
              <a:r><a:rPr lang="en-US" i="1"><a:solidFill><a:srgbClr val="00FF00"/></a:solidFill></a:rPr><a:t>green italic</a:t></a:r>
            </a:p>
          </p:txBody>
        </p:sp>
      ${SLIDE_CLOSE}`,
    })
    const out = await parsePptx(buf)
    const shape = out.slides[0]!.shapes[0]!
    expect(shape.kind).toBe('text')
    expect(shape.text).toBe('Red bold green italic')
    expect(shape.textRuns).toBeDefined()
    expect(shape.textRuns).toHaveLength(2)
    expect(shape.textRuns![0]!.text).toBe('Red bold ')
    expect(shape.textRuns![0]!.bold).toBe(true)
    expect(shape.textRuns![0]!.color).toBe(0xff0000)
    expect(shape.textRuns![1]!.text).toBe('green italic')
    expect(shape.textRuns![1]!.italic).toBe(true)
    expect(shape.textRuns![1]!.color).toBe(0x00ff00)
  })

  it('inserts a paragraph-break run between two paragraphs', async () => {
    const buf = await makeFixture({
      themeXml: OFFICE_THEME,
      slideXml: `${SLIDE_OPEN}
        <p:sp>
          <p:nvSpPr><p:cNvPr id="2" name="t"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
          <p:spPr>
            <a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="914400"/></a:xfrm>
            <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
            <a:noFill/>
          </p:spPr>
          <p:txBody>
            <a:bodyPr/><a:lstStyle/>
            <a:p><a:r><a:rPr lang="en-US"/><a:t>Line one</a:t></a:r></a:p>
            <a:p><a:r><a:rPr lang="en-US"/><a:t>Line two</a:t></a:r></a:p>
          </p:txBody>
        </p:sp>
      ${SLIDE_CLOSE}`,
    })
    const out = await parsePptx(buf)
    const runs = out.slides[0]!.shapes[0]!.textRuns!
    expect(runs.map((r) => r.text)).toEqual(['Line one', '\n', 'Line two'])
  })

  it('resolves <a:hlinkClick r:id> on a run to a TextObject hyperlink', async () => {
    const buf = await makeFixture({
      themeXml: OFFICE_THEME,
      hyperlinks: [{ id: 'rId99', url: 'https://example.com/' }],
      slideXml: `${SLIDE_OPEN}
        <p:sp>
          <p:nvSpPr><p:cNvPr id="2" name="t"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
          <p:spPr>
            <a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="914400"/></a:xfrm>
            <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
            <a:noFill/>
          </p:spPr>
          <p:txBody>
            <a:bodyPr/><a:lstStyle/>
            <a:p>
              <a:r>
                <a:rPr lang="en-US"><a:hlinkClick r:id="rId99"/></a:rPr>
                <a:t>Click me</a:t>
              </a:r>
            </a:p>
          </p:txBody>
        </p:sp>
      ${SLIDE_CLOSE}`,
    })
    const out = await parsePptx(buf)
    const shape = out.slides[0]!.shapes[0]!
    expect(shape.hyperlink).toEqual({ href: 'https://example.com/' })
    expect(shape.textRuns![0]!.hyperlinkHref).toBe('https://example.com/')
  })

  it('imports speaker notes paragraphs from the linked notesSlide', async () => {
    const notesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:notes xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld><p:spTree>
    <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
    <p:grpSpPr/>
    <p:sp>
      <p:nvSpPr>
        <p:cNvPr id="2" name="Notes Placeholder"/>
        <p:cNvSpPr/>
        <p:nvPr><p:ph type="body" idx="1"/></p:nvPr>
      </p:nvSpPr>
      <p:spPr/>
      <p:txBody>
        <a:bodyPr/><a:lstStyle/>
        <a:p><a:r><a:rPr lang="en-US"/><a:t>Talk about X.</a:t></a:r></a:p>
        <a:p><a:r><a:rPr lang="en-US"/><a:t>Then Y.</a:t></a:r></a:p>
      </p:txBody>
    </p:sp>
  </p:spTree></p:cSld>
</p:notes>`
    const buf = await makeFixture({
      themeXml: OFFICE_THEME,
      slideXml: `${SLIDE_OPEN}${SLIDE_CLOSE}`,
      notesXml,
    })
    const out = await parsePptx(buf)
    expect(out.slides[0]!.notes).toEqual(['Talk about X.', 'Then Y.'])
  })

  // ─── Tables ───────────────────────────────────────────────────────────────

  it('explodes a 2×2 table into 4 grouped cell rects + cell text shapes', async () => {
    // Table at (0,0) with 2 columns of 914400 EMU (= 96px) and 2 rows of
    // 457200 EMU (= 48px). Each cell has a single text run.
    const slideXml = `${SLIDE_OPEN}
      <p:graphicFrame>
        <p:nvGraphicFramePr><p:cNvPr id="2" name="tbl"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>
        <p:xfrm><a:off x="0" y="0"/><a:ext cx="1828800" cy="914400"/></p:xfrm>
        <a:graphic>
          <a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table">
            <a:tbl>
              <a:tblPr/>
              <a:tblGrid>
                <a:gridCol w="914400"/>
                <a:gridCol w="914400"/>
              </a:tblGrid>
              <a:tr h="457200">
                <a:tc><a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US"/><a:t>A1</a:t></a:r></a:p></a:txBody><a:tcPr/></a:tc>
                <a:tc><a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US"/><a:t>B1</a:t></a:r></a:p></a:txBody><a:tcPr/></a:tc>
              </a:tr>
              <a:tr h="457200">
                <a:tc><a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US"/><a:t>A2</a:t></a:r></a:p></a:txBody><a:tcPr/></a:tc>
                <a:tc><a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US"/><a:t>B2</a:t></a:r></a:p></a:txBody><a:tcPr/></a:tc>
              </a:tr>
            </a:tbl>
          </a:graphicData>
        </a:graphic>
      </p:graphicFrame>
    ${SLIDE_CLOSE}`
    const buf = await makeFixture({ slideXml, themeXml: OFFICE_THEME })
    const out = await parsePptx(buf)
    const shapes = out.slides[0]!.shapes
    // 4 cells × (1 rect + 1 text) = 8 shapes.
    expect(shapes).toHaveLength(8)
    // All shapes share one groupId.
    const groupIds = new Set(shapes.map((s) => s.groupId))
    expect(groupIds.size).toBe(1)
    expect([...groupIds][0]).toMatch(/^[A-Za-z0-9_-]{12}$/)
    // Cells laid out 2×2; A1 = (0,0), B1 = (96,0), A2 = (0,48), B2 = (96,48).
    const a1Rect = shapes[0]!
    expect(a1Rect.kind).toBe('rectangle')
    expect(a1Rect.x).toBeCloseTo(0)
    expect(a1Rect.y).toBeCloseTo(0)
    expect(a1Rect.width).toBeCloseTo(96)
    expect(a1Rect.height).toBeCloseTo(48)
    expect(a1Rect.strokeColor).toBe(0xcccccc)
    const a1Text = shapes[1]!
    expect(a1Text.kind).toBe('text')
    expect(a1Text.text).toBe('A1')
    const b1Rect = shapes[2]!
    expect(b1Rect.x).toBeCloseTo(96)
    const a2Rect = shapes[4]!
    expect(a2Rect.y).toBeCloseTo(48)
  })

  it('skips an empty cell (no <a:txBody>) — emits only the cell rect', async () => {
    const slideXml = `${SLIDE_OPEN}
      <p:graphicFrame>
        <p:nvGraphicFramePr><p:cNvPr id="2" name="tbl"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>
        <p:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="457200"/></p:xfrm>
        <a:graphic>
          <a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table">
            <a:tbl>
              <a:tblPr/>
              <a:tblGrid><a:gridCol w="914400"/></a:tblGrid>
              <a:tr h="457200">
                <a:tc><a:tcPr/></a:tc>
              </a:tr>
            </a:tbl>
          </a:graphicData>
        </a:graphic>
      </p:graphicFrame>
    ${SLIDE_CLOSE}`
    const buf = await makeFixture({ slideXml, themeXml: OFFICE_THEME })
    const out = await parsePptx(buf)
    const shapes = out.slides[0]!.shapes
    expect(shapes).toHaveLength(1)
    expect(shapes[0]!.kind).toBe('rectangle')
  })

  it('respects gridSpan — a merged-column cell is wider than a single grid col', async () => {
    const slideXml = `${SLIDE_OPEN}
      <p:graphicFrame>
        <p:nvGraphicFramePr><p:cNvPr id="2" name="tbl"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>
        <p:xfrm><a:off x="0" y="0"/><a:ext cx="1828800" cy="457200"/></p:xfrm>
        <a:graphic>
          <a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table">
            <a:tbl>
              <a:tblPr/>
              <a:tblGrid>
                <a:gridCol w="914400"/>
                <a:gridCol w="914400"/>
              </a:tblGrid>
              <a:tr h="457200">
                <a:tc gridSpan="2"><a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US"/><a:t>Header</a:t></a:r></a:p></a:txBody><a:tcPr/></a:tc>
                <a:tc hMerge="1"><a:tcPr/></a:tc>
              </a:tr>
            </a:tbl>
          </a:graphicData>
        </a:graphic>
      </p:graphicFrame>
    ${SLIDE_CLOSE}`
    const buf = await makeFixture({ slideXml, themeXml: OFFICE_THEME })
    const out = await parsePptx(buf)
    const shapes = out.slides[0]!.shapes
    // Just one cell rect + one text (continuation cell skipped).
    expect(shapes).toHaveLength(2)
    expect(shapes[0]!.kind).toBe('rectangle')
    expect(shapes[0]!.width).toBeCloseTo(192) // 2 × 96 px
    expect(shapes[1]!.kind).toBe('text')
    expect(shapes[1]!.text).toBe('Header')
  })

  it('applies <a:tcPr><a:solidFill> to the cell rect fill', async () => {
    const slideXml = `${SLIDE_OPEN}
      <p:graphicFrame>
        <p:nvGraphicFramePr><p:cNvPr id="2" name="tbl"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>
        <p:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="457200"/></p:xfrm>
        <a:graphic>
          <a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table">
            <a:tbl>
              <a:tblPr/>
              <a:tblGrid><a:gridCol w="914400"/></a:tblGrid>
              <a:tr h="457200">
                <a:tc>
                  <a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US"/><a:t>X</a:t></a:r></a:p></a:txBody>
                  <a:tcPr>
                    <a:solidFill><a:srgbClr val="FF8800"/></a:solidFill>
                  </a:tcPr>
                </a:tc>
              </a:tr>
            </a:tbl>
          </a:graphicData>
        </a:graphic>
      </p:graphicFrame>
    ${SLIDE_CLOSE}`
    const buf = await makeFixture({ slideXml, themeXml: OFFICE_THEME })
    const out = await parsePptx(buf)
    const rect = out.slides[0]!.shapes[0]!
    expect(rect.kind).toBe('rectangle')
    expect(rect.fillColor).toBe(0xff8800)
  })

  it('picks the first defined <a:lnL/R/T/B> edge as the cell stroke', async () => {
    const slideXml = `${SLIDE_OPEN}
      <p:graphicFrame>
        <p:nvGraphicFramePr><p:cNvPr id="2" name="tbl"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>
        <p:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="457200"/></p:xfrm>
        <a:graphic>
          <a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table">
            <a:tbl>
              <a:tblPr/>
              <a:tblGrid><a:gridCol w="914400"/></a:tblGrid>
              <a:tr h="457200">
                <a:tc>
                  <a:txBody><a:bodyPr/><a:lstStyle/><a:p/></a:txBody>
                  <a:tcPr>
                    <a:lnL w="19050"><a:solidFill><a:srgbClr val="112233"/></a:solidFill></a:lnL>
                    <a:lnB w="38100"><a:solidFill><a:srgbClr val="445566"/></a:solidFill></a:lnB>
                  </a:tcPr>
                </a:tc>
              </a:tr>
            </a:tbl>
          </a:graphicData>
        </a:graphic>
      </p:graphicFrame>
    ${SLIDE_CLOSE}`
    const buf = await makeFixture({ slideXml, themeXml: OFFICE_THEME })
    const out = await parsePptx(buf)
    const rect = out.slides[0]!.shapes[0]!
    // Left edge wins per priority order.
    expect(rect.strokeColor).toBe(0x112233)
    // 19050 EMU = 2 px @ 96 DPI.
    expect(rect.strokeWidth).toBeCloseTo(2, 1)
  })

  it('emits a borderless cell when every declared edge is <a:noFill/>', async () => {
    const slideXml = `${SLIDE_OPEN}
      <p:graphicFrame>
        <p:nvGraphicFramePr><p:cNvPr id="2" name="tbl"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>
        <p:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="457200"/></p:xfrm>
        <a:graphic>
          <a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table">
            <a:tbl>
              <a:tblPr/>
              <a:tblGrid><a:gridCol w="914400"/></a:tblGrid>
              <a:tr h="457200">
                <a:tc>
                  <a:txBody><a:bodyPr/><a:lstStyle/><a:p/></a:txBody>
                  <a:tcPr>
                    <a:lnL><a:noFill/></a:lnL>
                    <a:lnR><a:noFill/></a:lnR>
                    <a:lnT><a:noFill/></a:lnT>
                    <a:lnB><a:noFill/></a:lnB>
                  </a:tcPr>
                </a:tc>
              </a:tr>
            </a:tbl>
          </a:graphicData>
        </a:graphic>
      </p:graphicFrame>
    ${SLIDE_CLOSE}`
    const buf = await makeFixture({ slideXml, themeXml: OFFICE_THEME })
    const out = await parsePptx(buf)
    const rect = out.slides[0]!.shapes[0]!
    expect(rect.strokeColor).toBeUndefined()
    expect(rect.strokeWidth).toBeUndefined()
  })

  // ─── <a:tblPr> presets ────────────────────────────────────────────────────

  it('applies a `<a:tblPr firstRow="1">` accent fill to the first row', async () => {
    // 2 rows × 1 col. firstRow=1 — row 0 should pick up the accent colour
    // (OFFICE_THEME accent1 = 0x4472C4); row 1 should remain transparent.
    const slideXml = `${SLIDE_OPEN}
      <p:graphicFrame>
        <p:nvGraphicFramePr><p:cNvPr id="2" name="tbl"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>
        <p:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="914400"/></p:xfrm>
        <a:graphic>
          <a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table">
            <a:tbl>
              <a:tblPr firstRow="1"/>
              <a:tblGrid><a:gridCol w="914400"/></a:tblGrid>
              <a:tr h="457200">
                <a:tc><a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US"/><a:t>Header</a:t></a:r></a:p></a:txBody><a:tcPr/></a:tc>
              </a:tr>
              <a:tr h="457200">
                <a:tc><a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US"/><a:t>Body</a:t></a:r></a:p></a:txBody><a:tcPr/></a:tc>
              </a:tr>
            </a:tbl>
          </a:graphicData>
        </a:graphic>
      </p:graphicFrame>
    ${SLIDE_CLOSE}`
    const buf = await makeFixture({ slideXml, themeXml: OFFICE_THEME })
    const out = await parsePptx(buf)
    const shapes = out.slides[0]!.shapes
    const headerRect = shapes[0]!
    const bodyRect = shapes[2]!
    expect(headerRect.kind).toBe('rectangle')
    expect(headerRect.fillColor).toBe(0x4472c4)
    expect(bodyRect.kind).toBe('rectangle')
    expect(bodyRect.fillColor).toBeUndefined()
  })

  it('alternates fills on banded rows below the header', async () => {
    // 3 data rows below header: rows 1, 3 should be banded (PowerPoint
    // fills odd data rows). Verify row 1 has a fill, row 2 does not.
    const slideXml = `${SLIDE_OPEN}
      <p:graphicFrame>
        <p:nvGraphicFramePr><p:cNvPr id="2" name="tbl"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>
        <p:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="1828800"/></p:xfrm>
        <a:graphic>
          <a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table">
            <a:tbl>
              <a:tblPr firstRow="1" bandRow="1"/>
              <a:tblGrid><a:gridCol w="914400"/></a:tblGrid>
              <a:tr h="457200"><a:tc><a:txBody><a:bodyPr/><a:lstStyle/><a:p/></a:txBody><a:tcPr/></a:tc></a:tr>
              <a:tr h="457200"><a:tc><a:txBody><a:bodyPr/><a:lstStyle/><a:p/></a:txBody><a:tcPr/></a:tc></a:tr>
              <a:tr h="457200"><a:tc><a:txBody><a:bodyPr/><a:lstStyle/><a:p/></a:txBody><a:tcPr/></a:tc></a:tr>
              <a:tr h="457200"><a:tc><a:txBody><a:bodyPr/><a:lstStyle/><a:p/></a:txBody><a:tcPr/></a:tc></a:tr>
            </a:tbl>
          </a:graphicData>
        </a:graphic>
      </p:graphicFrame>
    ${SLIDE_CLOSE}`
    const buf = await makeFixture({ slideXml, themeXml: OFFICE_THEME })
    const out = await parsePptx(buf)
    const rectAt = (rowIndex: number): import('./parser.js').ParsedShape =>
      out.slides[0]!.shapes[rowIndex]!
    // 4 rows × no <a:txBody> content (`<a:p/>` is empty) → 1 rect per row,
    // no text shapes. Indices map 1:1 to rows.
    expect(rectAt(0).fillColor).toBe(0x4472c4) // header (firstRow)
    expect(rectAt(1).fillColor).toBeUndefined() // data row 0 — unshaded
    expect(rectAt(2).fillColor).toBeDefined() // data row 1 — banded
    expect(rectAt(3).fillColor).toBeUndefined() // data row 2 — unshaded
    // Banded fill is a tint of accent1 — lighter than the original.
    const banded = rectAt(2).fillColor!
    const r = (banded >> 16) & 0xff
    expect(r).toBeGreaterThan(0x44) // tint pushes red channel toward 255
  })

  it('lets explicit <a:tcPr> fill win over the preset heuristic', async () => {
    const slideXml = `${SLIDE_OPEN}
      <p:graphicFrame>
        <p:nvGraphicFramePr><p:cNvPr id="2" name="tbl"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>
        <p:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="457200"/></p:xfrm>
        <a:graphic>
          <a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table">
            <a:tbl>
              <a:tblPr firstRow="1"/>
              <a:tblGrid><a:gridCol w="914400"/></a:tblGrid>
              <a:tr h="457200">
                <a:tc>
                  <a:txBody><a:bodyPr/><a:lstStyle/><a:p/></a:txBody>
                  <a:tcPr>
                    <a:solidFill><a:srgbClr val="00FF00"/></a:solidFill>
                  </a:tcPr>
                </a:tc>
              </a:tr>
            </a:tbl>
          </a:graphicData>
        </a:graphic>
      </p:graphicFrame>
    ${SLIDE_CLOSE}`
    const buf = await makeFixture({ slideXml, themeXml: OFFICE_THEME })
    const out = await parsePptx(buf)
    // Explicit green fill wins over preset header colour.
    expect(out.slides[0]!.shapes[0]!.fillColor).toBe(0x00ff00)
  })

  // ─── Parametric shapes (triangle, polygon, arrow) ────────────────────────

  it('parses `<a:prstGeom prst="triangle">` as kind=triangle', async () => {
    const buf = await makeFixture({
      themeXml: OFFICE_THEME,
      slideXml: `${SLIDE_OPEN}
        <p:sp>
          <p:nvSpPr><p:cNvPr id="2" name="t"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
          <p:spPr>
            <a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="914400"/></a:xfrm>
            <a:prstGeom prst="triangle"><a:avLst/></a:prstGeom>
            <a:solidFill><a:srgbClr val="FF8800"/></a:solidFill>
          </p:spPr>
        </p:sp>
      ${SLIDE_CLOSE}`,
    })
    const out = await parsePptx(buf)
    expect(out.slides[0]!.shapes[0]!.kind).toBe('triangle')
    expect(out.slides[0]!.shapes[0]!.fillColor).toBe(0xff8800)
  })

  it('parses `<a:prstGeom prst="hexagon">` as kind=polygon with sides=6', async () => {
    const buf = await makeFixture({
      themeXml: OFFICE_THEME,
      slideXml: `${SLIDE_OPEN}
        <p:sp>
          <p:nvSpPr><p:cNvPr id="2" name="t"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
          <p:spPr>
            <a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="914400"/></a:xfrm>
            <a:prstGeom prst="hexagon"><a:avLst/></a:prstGeom>
            <a:solidFill><a:srgbClr val="44AAFF"/></a:solidFill>
          </p:spPr>
        </p:sp>
      ${SLIDE_CLOSE}`,
    })
    const out = await parsePptx(buf)
    const shape = out.slides[0]!.shapes[0]!
    expect(shape.kind).toBe('polygon')
    expect(shape.sides).toBe(6)
  })

  it('upgrades a line with `<a:tailEnd type="triangle">` to kind=arrow', async () => {
    const buf = await makeFixture({
      themeXml: OFFICE_THEME,
      slideXml: `${SLIDE_OPEN}
        <p:cxnSp>
          <p:nvCxnSpPr><p:cNvPr id="2" name="c"/><p:cNvCxnSpPr/><p:nvPr/></p:nvCxnSpPr>
          <p:spPr>
            <a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="0"/></a:xfrm>
            <a:prstGeom prst="straightConnector1"><a:avLst/></a:prstGeom>
            <a:ln w="19050">
              <a:solidFill><a:srgbClr val="000000"/></a:solidFill>
              <a:tailEnd type="triangle"/>
            </a:ln>
          </p:spPr>
        </p:cxnSp>
      ${SLIDE_CLOSE}`,
    })
    const out = await parsePptx(buf)
    const shape = out.slides[0]!.shapes[0]!
    expect(shape.kind).toBe('arrow')
    expect(shape.endCap).toBe('arrow')
    expect(shape.startCap).toBeUndefined()
  })

  it('parses `<a:custGeom>` with line + cubic segments → kind=path with anchors', async () => {
    // Custom path: moveTo (0,0) → lnTo (100,0) → cubicBezTo (cp1=(120,0),
    // cp2=(180,100), end=(200,100)) → close. Path-space EMU 200×100 mapped
    // to a shape of 914400×457200 EMU (= 96×48 px) becomes anchors at
    // (0,0), (48,0), (96,48) in slide-local px (shape at 0,0).
    const buf = await makeFixture({
      themeXml: OFFICE_THEME,
      slideXml: `${SLIDE_OPEN}
        <p:sp>
          <p:nvSpPr><p:cNvPr id="2" name="p"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
          <p:spPr>
            <a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="457200"/></a:xfrm>
            <a:custGeom>
              <a:pathLst>
                <a:path w="200" h="100">
                  <a:moveTo><a:pt x="0" y="0"/></a:moveTo>
                  <a:lnTo><a:pt x="100" y="0"/></a:lnTo>
                  <a:cubicBezTo>
                    <a:pt x="120" y="0"/>
                    <a:pt x="180" y="100"/>
                    <a:pt x="200" y="100"/>
                  </a:cubicBezTo>
                  <a:close/>
                </a:path>
              </a:pathLst>
            </a:custGeom>
            <a:solidFill><a:srgbClr val="FF0000"/></a:solidFill>
          </p:spPr>
        </p:sp>
      ${SLIDE_CLOSE}`,
    })
    const out = await parsePptx(buf)
    const shape = out.slides[0]!.shapes[0]!
    expect(shape.kind).toBe('path')
    expect(shape.pathClosed).toBe(true)
    expect(shape.pathAnchors).toBeDefined()
    expect(shape.pathAnchors).toHaveLength(3)
    // First anchor at (0, 0); last at (96, 48) within the 96×48 px shape.
    expect(shape.pathAnchors![0]).toEqual({ x: 0, y: 0 })
    expect(shape.pathAnchors![2]!.x).toBeCloseTo(96, 1)
    expect(shape.pathAnchors![2]!.y).toBeCloseTo(48, 1)
    // Cubic handles attached: previous-anchor cpOut + this-anchor cpIn.
    expect(shape.pathAnchors![1]!.cpOut).toBeDefined()
    expect(shape.pathAnchors![2]!.cpIn).toBeDefined()
  })

  it('parses a `<p:pic>` with `<a:videoFile r:embed>` as kind=video with videoPath', async () => {
    // 12-byte stub bytes that start with `ftyp` at offset 4 so sniffImageType
    // detects `video/mp4`. Real MP4 atoms would be much longer; we just need
    // the magic to flip the MIME on the embedded media probe.
    const zip = new JSZip()
    zip.file(
      'ppt/presentation.xml',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst>
  <p:sldSz cx="12192000" cy="6858000"/>
</p:presentation>`,
    )
    zip.file(
      'ppt/_rels/presentation.xml.rels',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>
</Relationships>`,
    )
    zip.file(
      'ppt/slides/_rels/slide1.xml.rels',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/poster.png"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/video" Target="../media/clip.mp4"/>
</Relationships>`,
    )
    zip.file(
      'ppt/slides/slide1.xml',
      `${SLIDE_OPEN}
        <p:pic>
          <p:nvPicPr>
            <p:cNvPr id="2" name="v"/>
            <p:cNvPicPr/>
            <p:nvPr><a:videoFile r:embed="rId3"/></p:nvPr>
          </p:nvPicPr>
          <p:blipFill>
            <a:blip r:embed="rId2"/>
            <a:stretch><a:fillRect/></a:stretch>
          </p:blipFill>
          <p:spPr>
            <a:xfrm><a:off x="0" y="0"/><a:ext cx="2438400" cy="1828800"/></a:xfrm>
            <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
          </p:spPr>
        </p:pic>
      ${SLIDE_CLOSE}`,
    )
    // 16-byte MP4 stub: ftyp box at offset 4 ('ftyp' = 66 74 79 70).
    const mp4Bytes = Buffer.from([
      0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x02,
      0x00,
    ])
    zip.file('ppt/media/clip.mp4', mp4Bytes)
    // Valid 1×1 PNG poster.
    zip.file(
      'ppt/media/poster.png',
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
        'base64',
      ),
    )
    const buf = Buffer.from(await zip.generateAsync({ type: 'nodebuffer' }))
    const out = await parsePptx(buf)
    const shape = out.slides[0]!.shapes[0]!
    expect(shape.kind).toBe('video')
    expect(shape.videoPath).toBe('ppt/media/clip.mp4')
    // Embedded media was sniffed as video/mp4.
    const media = out.embeddedImages.get('ppt/media/clip.mp4')
    expect(media?.mimeType).toBe('video/mp4')
  })

  it('captures fontFamily + letterSpacing + cap from `<a:rPr>` on the first run', async () => {
    const buf = await makeFixture({
      themeXml: OFFICE_THEME,
      slideXml: `${SLIDE_OPEN}
        <p:sp>
          <p:nvSpPr><p:cNvPr id="2" name="t"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
          <p:spPr>
            <a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="457200"/></a:xfrm>
            <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
            <a:noFill/>
          </p:spPr>
          <p:txBody>
            <a:bodyPr/><a:lstStyle/>
            <a:p>
              <a:r>
                <a:rPr lang="en-US" sz="1800" spc="200" cap="all">
                  <a:latin typeface="Inter"/>
                </a:rPr>
                <a:t>Spaced</a:t>
              </a:r>
            </a:p>
          </p:txBody>
        </p:sp>
      ${SLIDE_CLOSE}`,
    })
    const out = await parsePptx(buf)
    const shape = out.slides[0]!.shapes[0]!
    expect(shape.fontFamily).toBe('Inter')
    // 200 PPTX units = 2pt = ~2.67 px @ 96 DPI
    expect(shape.letterSpacing).toBeCloseTo(200 * (1 / 100) * (96 / 72), 2)
    expect(shape.textTransform).toBe('uppercase')
  })

  it('captures lineHeight (lnSpc spcPct) + paragraphSpace on the first <a:pPr>', async () => {
    const buf = await makeFixture({
      themeXml: OFFICE_THEME,
      slideXml: `${SLIDE_OPEN}
        <p:sp>
          <p:nvSpPr><p:cNvPr id="2" name="t"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
          <p:spPr>
            <a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="457200"/></a:xfrm>
            <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
            <a:noFill/>
          </p:spPr>
          <p:txBody>
            <a:bodyPr/><a:lstStyle/>
            <a:p>
              <a:pPr>
                <a:lnSpc><a:spcPct val="150000"/></a:lnSpc>
                <a:spcBef><a:spcPts val="1200"/></a:spcBef>
                <a:spcAft><a:spcPts val="600"/></a:spcAft>
              </a:pPr>
              <a:r><a:rPr lang="en-US" sz="1800"/><a:t>X</a:t></a:r>
            </a:p>
          </p:txBody>
        </p:sp>
      ${SLIDE_CLOSE}`,
    })
    const out = await parsePptx(buf)
    const shape = out.slides[0]!.shapes[0]!
    expect(shape.lineHeight).toBeCloseTo(1.5, 3)
    // 1200 PPTX units = 12pt = 16 px @ 96 DPI
    expect(shape.paragraphSpaceBefore).toBeCloseTo(16, 1)
    expect(shape.paragraphSpaceAfter).toBeCloseTo(8, 1)
  })

  it('captures text stroke from `<a:rPr><a:ln>` on the first run', async () => {
    const buf = await makeFixture({
      themeXml: OFFICE_THEME,
      slideXml: `${SLIDE_OPEN}
        <p:sp>
          <p:nvSpPr><p:cNvPr id="2" name="t"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
          <p:spPr>
            <a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="457200"/></a:xfrm>
            <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
            <a:noFill/>
          </p:spPr>
          <p:txBody>
            <a:bodyPr/><a:lstStyle/>
            <a:p>
              <a:r>
                <a:rPr lang="en-US" sz="3600">
                  <a:ln w="9525"><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill></a:ln>
                </a:rPr>
                <a:t>Outlined</a:t>
              </a:r>
            </a:p>
          </p:txBody>
        </p:sp>
      ${SLIDE_CLOSE}`,
    })
    const out = await parsePptx(buf)
    const shape = out.slides[0]!.shapes[0]!
    expect(shape.textStrokeColor).toBe(0xff0000)
    // 9525 EMU = 1 px @ 96 DPI
    expect(shape.textStrokeWidth).toBeCloseTo(1, 1)
  })

  it('captures `<a:effectLst>/<a:outerShdw>` as shadow{color,offsetX/Y,blur,opacity}', async () => {
    // PPTX shadow: dist=190500 EMU (20px), dir=0 (right), blurRad=38100 EMU (4px),
    // colour 0x808080 @ alpha 50% → offsetX = 20, offsetY = 0.
    const buf = await makeFixture({
      themeXml: OFFICE_THEME,
      slideXml: `${SLIDE_OPEN}
        <p:sp>
          <p:nvSpPr><p:cNvPr id="2" name="r"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
          <p:spPr>
            <a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="914400"/></a:xfrm>
            <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
            <a:solidFill><a:srgbClr val="00AAFF"/></a:solidFill>
            <a:effectLst>
              <a:outerShdw blurRad="38100" dist="190500" dir="0">
                <a:srgbClr val="808080"><a:alpha val="50000"/></a:srgbClr>
              </a:outerShdw>
            </a:effectLst>
          </p:spPr>
        </p:sp>
      ${SLIDE_CLOSE}`,
    })
    const out = await parsePptx(buf)
    const shape = out.slides[0]!.shapes[0]!
    expect(shape.shadow).toBeDefined()
    expect(shape.shadow!.color).toBe(0x808080)
    expect(shape.shadow!.offsetX).toBeCloseTo(20, 1)
    expect(Math.abs(shape.shadow!.offsetY)).toBeLessThan(0.5)
    expect(shape.shadow!.blur).toBeCloseTo(4, 1)
    expect(shape.shadow!.opacity).toBeCloseTo(0.5, 2)
  })

  it("captures `<a:effectLst>/<a:blur rad>` as the shape's gaussian blur", async () => {
    const buf = await makeFixture({
      themeXml: OFFICE_THEME,
      slideXml: `${SLIDE_OPEN}
        <p:sp>
          <p:nvSpPr><p:cNvPr id="2" name="r"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
          <p:spPr>
            <a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="914400"/></a:xfrm>
            <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
            <a:solidFill><a:srgbClr val="00AAFF"/></a:solidFill>
            <a:effectLst><a:blur rad="76200" grow="0"/></a:effectLst>
          </p:spPr>
        </p:sp>
      ${SLIDE_CLOSE}`,
    })
    const out = await parsePptx(buf)
    // 76200 EMU = 8 px @ 96 DPI
    expect(out.slides[0]!.shapes[0]!.blur).toBeCloseTo(8, 1)
  })

  it('captures `<a:blipFill>/<a:srcRect>` on a `<p:pic>` as ImageObject.imageRect', async () => {
    // 25% crop from the left + 10% from the bottom; everything else 0.
    // Frame at 0,0 with 100x100 in slide px. Visible w = 0.75, h = 0.9.
    // imageRect.width = 100 / 0.75 = 133.33; imageRect.x = -0.25 * 133.33 = -33.33
    // imageRect.height = 100 / 0.9 = 111.11; imageRect.y = 0
    const zip = new JSZip()
    zip.file(
      'ppt/presentation.xml',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst>
  <p:sldSz cx="12192000" cy="6858000"/>
</p:presentation>`,
    )
    zip.file(
      'ppt/_rels/presentation.xml.rels',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>
</Relationships>`,
    )
    zip.file(
      'ppt/slides/_rels/slide1.xml.rels',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/>
</Relationships>`,
    )
    zip.file(
      'ppt/slides/slide1.xml',
      `${SLIDE_OPEN}
        <p:pic>
          <p:nvPicPr><p:cNvPr id="2" name="i"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>
          <p:blipFill>
            <a:blip r:embed="rId2"/>
            <a:srcRect l="25000" t="0" r="0" b="10000"/>
            <a:stretch><a:fillRect/></a:stretch>
          </p:blipFill>
          <p:spPr>
            <a:xfrm><a:off x="0" y="0"/><a:ext cx="952500" cy="952500"/></a:xfrm>
            <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
          </p:spPr>
        </p:pic>
      ${SLIDE_CLOSE}`,
    )
    zip.file(
      'ppt/media/image1.png',
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
        'base64',
      ),
    )
    const buf = Buffer.from(await zip.generateAsync({ type: 'nodebuffer' }))
    const out = await parsePptx(buf)
    const shape = out.slides[0]!.shapes[0]!
    expect(shape.kind).toBe('image')
    expect(shape.imageRect).toBeDefined()
    // 952500 EMU = 100 px frame; imageRect.width = 100 / 0.75 ≈ 133.33
    expect(shape.imageRect!.width).toBeCloseTo(133.33, 1)
    expect(shape.imageRect!.x).toBeCloseTo(-33.33, 1)
    expect(shape.imageRect!.height).toBeCloseTo(111.11, 1)
    expect(shape.imageRect!.y).toBeCloseTo(0, 1)
  })

  it('captures slide name + skipped flag', async () => {
    const slideXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" show="0">
  <p:cSld name="Cover Slide"><p:spTree>
    <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
    <p:grpSpPr/>
  </p:spTree></p:cSld>
</p:sld>`
    const buf = await makeFixture({ slideXml })
    const out = await parsePptx(buf)
    expect(out.slides[0]!.name).toBe('Cover Slide')
    expect(out.slides[0]!.skipped).toBe(true)
  })

  it('captures a `<p:transition><p:push dir="r"/>` as a push transition', async () => {
    const slideXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld><p:spTree>
    <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
    <p:grpSpPr/>
  </p:spTree></p:cSld>
  <p:transition spd="med"><p:push dir="r"/></p:transition>
</p:sld>`
    const buf = await makeFixture({ slideXml })
    const out = await parsePptx(buf)
    expect(out.slides[0]!.transition).toEqual({ kind: 'push', durationMs: 500, direction: 'r' })
  })

  it('extracts an entrance animation step from `<p:timing>` and maps presetID 10 → fadeIn', async () => {
    const slideXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld><p:spTree>
    <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
    <p:grpSpPr/>
    <p:sp>
      <p:nvSpPr><p:cNvPr id="5" name="t"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
      <p:spPr>
        <a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="914400"/></a:xfrm>
        <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
        <a:solidFill><a:srgbClr val="00AAFF"/></a:solidFill>
      </p:spPr>
    </p:sp>
  </p:spTree></p:cSld>
  <p:timing>
    <p:tnLst>
      <p:par>
        <p:cTn id="2" presetID="10" presetClass="entr" nodeType="clickEffect" dur="500">
          <p:tgtEl><p:spTgt spid="5"/></p:tgtEl>
        </p:cTn>
      </p:par>
    </p:tnLst>
  </p:timing>
</p:sld>`
    const buf = await makeFixture({ slideXml })
    const out = await parsePptx(buf)
    expect(out.slides[0]!.animations).toBeDefined()
    expect(out.slides[0]!.animations).toHaveLength(1)
    expect(out.slides[0]!.animations![0]).toEqual({
      spId: 5,
      preset: 'fadeIn',
      trigger: 'onClick',
      durationMs: 500,
      delayMs: 0,
    })
  })

  it('captures flipH on a connector line', async () => {
    const buf = await makeFixture({
      themeXml: OFFICE_THEME,
      slideXml: `${SLIDE_OPEN}
        <p:cxnSp>
          <p:nvCxnSpPr><p:cNvPr id="2" name="c"/><p:cNvCxnSpPr/><p:nvPr/></p:nvCxnSpPr>
          <p:spPr>
            <a:xfrm flipH="1"><a:off x="0" y="0"/><a:ext cx="914400" cy="914400"/></a:xfrm>
            <a:prstGeom prst="straightConnector1"><a:avLst/></a:prstGeom>
            <a:ln w="19050"><a:solidFill><a:srgbClr val="000000"/></a:solidFill></a:ln>
          </p:spPr>
        </p:cxnSp>
      ${SLIDE_CLOSE}`,
    })
    const out = await parsePptx(buf)
    expect(out.slides[0]!.shapes[0]!.flipH).toBe(true)
  })

  it('rejects a buffer that is not a ZIP', async () => {
    await expect(parsePptx(Buffer.from('not a zip'))).rejects.toThrow(/ZIP/i)
  })

  // ─── Master + layout flattening ───────────────────────────────────────────
  // Narrative has no master/template concept, so the importer bakes any
  // visible artefact from master + layout into each slide as a stand-alone
  // object/background. These tests pin that behaviour: master shapes appear
  // on the slide, bg cascade works, txStyles defaults reach placeholder text,
  // and showMasterSp="0" still suppresses master shapes for that slide.

  it('bakes a master non-placeholder shape onto every slide', async () => {
    // Master defines a solid red rect (the "logo"). The slide itself only has
    // a placeholder body text. Expected output: 2 shapes on the slide — the
    // master rect (painted first / under) + the slide's own text.
    const slideXml = `${SLIDE_OPEN}
      <p:sp>
        <p:nvSpPr>
          <p:cNvPr id="2" name="t"/><p:cNvSpPr/>
          <p:nvPr><p:ph type="body" idx="1"/></p:nvPr>
        </p:nvSpPr>
        <p:spPr>
          <a:xfrm><a:off x="0" y="0"/><a:ext cx="100000" cy="100000"/></a:xfrm>
        </p:spPr>
        <p:txBody>
          <a:bodyPr/><a:lstStyle/>
          <a:p><a:r><a:rPr lang="en-US"/><a:t>Slide body</a:t></a:r></a:p>
        </p:txBody>
      </p:sp>
    ${SLIDE_CLOSE}`
    const layoutXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld><p:spTree>
    <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
    <p:grpSpPr/>
  </p:spTree></p:cSld>
</p:sldLayout>`
    const masterXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld><p:spTree>
    <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
    <p:grpSpPr/>
    <p:sp>
      <p:nvSpPr><p:cNvPr id="2" name="Logo"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
      <p:spPr>
        <a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="914400"/></a:xfrm>
        <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
        <a:solidFill><a:srgbClr val="FF0000"/></a:solidFill>
      </p:spPr>
    </p:sp>
  </p:spTree></p:cSld>
</p:sldMaster>`
    const buf = await makeFixture({ slideXml, layoutXml, masterXml, themeXml: OFFICE_THEME })
    const out = await parsePptx(buf)
    expect(out.slides[0]!.shapes).toHaveLength(2)
    // Master rect comes first (back-most in paint order).
    const masterRect = out.slides[0]!.shapes[0]!
    expect(masterRect.kind).toBe('rectangle')
    expect(masterRect.fillColor).toBe(0xff0000)
    // Slide's own text comes last (on top).
    const slideText = out.slides[0]!.shapes[1]!
    expect(slideText.kind).toBe('text')
    expect(slideText.text).toBe('Slide body')
  })

  it('falls through to layout bg, then master bg, when the slide has none', async () => {
    const slideXml = `${SLIDE_OPEN}${SLIDE_CLOSE}`
    const layoutXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:bg><p:bgPr><a:solidFill><a:srgbClr val="ABCDEF"/></a:solidFill></p:bgPr></p:bg>
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr/>
    </p:spTree>
  </p:cSld>
</p:sldLayout>`
    const masterXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:bg><p:bgPr><a:solidFill><a:srgbClr val="111111"/></a:solidFill></p:bgPr></p:bg>
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr/>
    </p:spTree>
  </p:cSld>
</p:sldMaster>`
    const buf = await makeFixture({ slideXml, layoutXml, masterXml })
    const out = await parsePptx(buf)
    // Layout wins over master.
    expect(out.slides[0]!.background.kind).toBe('solid')
    expect(out.slides[0]!.background.color).toBe(0xabcdef)
  })

  it('cascades to master bg when layout also has none', async () => {
    const slideXml = `${SLIDE_OPEN}${SLIDE_CLOSE}`
    const layoutXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld><p:spTree>
    <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
    <p:grpSpPr/>
  </p:spTree></p:cSld>
</p:sldLayout>`
    const masterXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:bg><p:bgPr><a:solidFill><a:srgbClr val="222222"/></a:solidFill></p:bgPr></p:bg>
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr/>
    </p:spTree>
  </p:cSld>
</p:sldMaster>`
    const buf = await makeFixture({ slideXml, layoutXml, masterXml })
    const out = await parsePptx(buf)
    expect(out.slides[0]!.background.kind).toBe('solid')
    expect(out.slides[0]!.background.color).toBe(0x222222)
  })

  it("applies master <p:txStyles>/<p:titleStyle> colour to a slide's title placeholder", async () => {
    // Slide carries a title placeholder with no inline rPr colour — the only
    // colour info is on the master's titleStyle. Without flattening this'd
    // land as DEFAULT_TEXT_COLOR; with flattening it picks up the master red.
    const slideXml = `${SLIDE_OPEN}
      <p:sp>
        <p:nvSpPr>
          <p:cNvPr id="2" name="title"/><p:cNvSpPr/>
          <p:nvPr><p:ph type="title"/></p:nvPr>
        </p:nvSpPr>
        <p:spPr>
          <a:xfrm><a:off x="0" y="0"/><a:ext cx="500000" cy="200000"/></a:xfrm>
        </p:spPr>
        <p:txBody>
          <a:bodyPr/><a:lstStyle/>
          <a:p><a:r><a:rPr lang="en-US"/><a:t>The title</a:t></a:r></a:p>
        </p:txBody>
      </p:sp>
    ${SLIDE_CLOSE}`
    const layoutXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld><p:spTree>
    <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
    <p:grpSpPr/>
  </p:spTree></p:cSld>
</p:sldLayout>`
    const masterXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld><p:spTree>
    <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
    <p:grpSpPr/>
  </p:spTree></p:cSld>
  <p:txStyles>
    <p:titleStyle>
      <a:lvl1pPr><a:defRPr sz="4400" b="1"><a:solidFill><a:srgbClr val="CC0000"/></a:solidFill></a:defRPr></a:lvl1pPr>
    </p:titleStyle>
    <p:bodyStyle>
      <a:lvl1pPr><a:defRPr sz="1800"><a:solidFill><a:srgbClr val="333333"/></a:solidFill></a:defRPr></a:lvl1pPr>
    </p:bodyStyle>
    <p:otherStyle>
      <a:lvl1pPr><a:defRPr sz="1800"><a:solidFill><a:srgbClr val="666666"/></a:solidFill></a:defRPr></a:lvl1pPr>
    </p:otherStyle>
  </p:txStyles>
</p:sldMaster>`
    const buf = await makeFixture({ slideXml, layoutXml, masterXml, themeXml: OFFICE_THEME })
    const out = await parsePptx(buf)
    const title = out.slides[0]!.shapes[0]!
    expect(title.kind).toBe('text')
    expect(title.text).toBe('The title')
    expect(title.textColor).toBe(0xcc0000)
    expect(title.bold).toBe(true)
    // PPTX sz=4400 → 44pt → px @ 96 DPI ≈ 58.67
    expect(title.fontSize).toBeCloseTo(58.67, 1)
  })

  it('resolves master `<p:bgRef>` to a solid bg with the inline scheme colour', async () => {
    // Themed-master decks (most Office templates) declare their bg via
    // `<p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef>` rather than
    // an inline `<p:bgPr>` fill. The slide cascades to the master, the
    // master's bgRef resolves the scheme colour against theme1.xml, and
    // the result is a solid bg of that colour.
    const slideXml = `${SLIDE_OPEN}${SLIDE_CLOSE}`
    const layoutXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld><p:spTree>
    <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
    <p:grpSpPr/>
  </p:spTree></p:cSld>
</p:sldLayout>`
    const masterXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:bg><p:bgRef idx="1001"><a:schemeClr val="lt2"/></p:bgRef></p:bg>
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr/>
    </p:spTree>
  </p:cSld>
</p:sldMaster>`
    const buf = await makeFixture({ slideXml, layoutXml, masterXml, themeXml: OFFICE_THEME })
    const out = await parsePptx(buf)
    expect(out.slides[0]!.background.kind).toBe('solid')
    expect(out.slides[0]!.background.color).toBe(0xe7e6e6) // theme lt2
  })

  // ─── Bullet lists ─────────────────────────────────────────────────────────

  it('maps a slide-side <a:buChar> to listStyle="bullet" on the parsed text', async () => {
    const buf = await makeFixture({
      themeXml: OFFICE_THEME,
      slideXml: `${SLIDE_OPEN}
        <p:sp>
          <p:nvSpPr><p:cNvPr id="2" name="t"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
          <p:spPr>
            <a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="914400"/></a:xfrm>
            <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
            <a:noFill/>
          </p:spPr>
          <p:txBody>
            <a:bodyPr/><a:lstStyle/>
            <a:p>
              <a:pPr><a:buChar char="•"/></a:pPr>
              <a:r><a:rPr lang="en-US"/><a:t>Item one</a:t></a:r>
            </a:p>
          </p:txBody>
        </p:sp>
      ${SLIDE_CLOSE}`,
    })
    const out = await parsePptx(buf)
    expect(out.slides[0]!.shapes[0]!.listStyle).toBe('bullet')
  })

  it('maps a slide-side <a:buAutoNum> to listStyle="numbered"', async () => {
    const buf = await makeFixture({
      themeXml: OFFICE_THEME,
      slideXml: `${SLIDE_OPEN}
        <p:sp>
          <p:nvSpPr><p:cNvPr id="2" name="t"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
          <p:spPr>
            <a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="914400"/></a:xfrm>
            <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
            <a:noFill/>
          </p:spPr>
          <p:txBody>
            <a:bodyPr/><a:lstStyle/>
            <a:p>
              <a:pPr><a:buAutoNum type="arabicPeriod"/></a:pPr>
              <a:r><a:rPr lang="en-US"/><a:t>Step 1</a:t></a:r>
            </a:p>
          </p:txBody>
        </p:sp>
      ${SLIDE_CLOSE}`,
    })
    const out = await parsePptx(buf)
    expect(out.slides[0]!.shapes[0]!.listStyle).toBe('numbered')
  })

  it("inherits master <p:bodyStyle>'s <a:buChar> default for a body placeholder", async () => {
    // Slide's body placeholder text has no inline `<a:pPr>` bullet decl —
    // the bullet comes from the master's <p:bodyStyle><a:lvl1pPr><a:buChar>.
    const slideXml = `${SLIDE_OPEN}
      <p:sp>
        <p:nvSpPr>
          <p:cNvPr id="2" name="body"/><p:cNvSpPr/>
          <p:nvPr><p:ph type="body" idx="1"/></p:nvPr>
        </p:nvSpPr>
        <p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="500000" cy="200000"/></a:xfrm></p:spPr>
        <p:txBody>
          <a:bodyPr/><a:lstStyle/>
          <a:p><a:r><a:rPr lang="en-US"/><a:t>Body text</a:t></a:r></a:p>
        </p:txBody>
      </p:sp>
    ${SLIDE_CLOSE}`
    const layoutXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld><p:spTree>
    <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
    <p:grpSpPr/>
  </p:spTree></p:cSld>
</p:sldLayout>`
    const masterXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld><p:spTree>
    <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
    <p:grpSpPr/>
  </p:spTree></p:cSld>
  <p:txStyles>
    <p:titleStyle>
      <a:lvl1pPr><a:buNone/><a:defRPr sz="4400"/></a:lvl1pPr>
    </p:titleStyle>
    <p:bodyStyle>
      <a:lvl1pPr><a:buChar char="•"/><a:defRPr sz="1800"/></a:lvl1pPr>
    </p:bodyStyle>
    <p:otherStyle>
      <a:lvl1pPr><a:defRPr sz="1800"/></a:lvl1pPr>
    </p:otherStyle>
  </p:txStyles>
</p:sldMaster>`
    const buf = await makeFixture({ slideXml, layoutXml, masterXml, themeXml: OFFICE_THEME })
    const out = await parsePptx(buf)
    expect(out.slides[0]!.shapes[0]!.listStyle).toBe('bullet')
  })

  it('lets slide-side <a:buNone> suppress an inherited body-style bullet', async () => {
    // Same master as above (body lvl1 has buChar), but the slide's
    // first paragraph carries an explicit `<a:buNone/>` — no bullet.
    const slideXml = `${SLIDE_OPEN}
      <p:sp>
        <p:nvSpPr>
          <p:cNvPr id="2" name="body"/><p:cNvSpPr/>
          <p:nvPr><p:ph type="body" idx="1"/></p:nvPr>
        </p:nvSpPr>
        <p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="500000" cy="200000"/></a:xfrm></p:spPr>
        <p:txBody>
          <a:bodyPr/><a:lstStyle/>
          <a:p><a:pPr><a:buNone/></a:pPr><a:r><a:rPr lang="en-US"/><a:t>No bullet</a:t></a:r></a:p>
        </p:txBody>
      </p:sp>
    ${SLIDE_CLOSE}`
    const layoutXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld><p:spTree>
    <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
    <p:grpSpPr/>
  </p:spTree></p:cSld>
</p:sldLayout>`
    const masterXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld><p:spTree>
    <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
    <p:grpSpPr/>
  </p:spTree></p:cSld>
  <p:txStyles>
    <p:bodyStyle>
      <a:lvl1pPr><a:buChar char="•"/><a:defRPr sz="1800"/></a:lvl1pPr>
    </p:bodyStyle>
  </p:txStyles>
</p:sldMaster>`
    const buf = await makeFixture({ slideXml, layoutXml, masterXml, themeXml: OFFICE_THEME })
    const out = await parsePptx(buf)
    expect(out.slides[0]!.shapes[0]!.listStyle).toBeUndefined()
  })

  it('honours showMasterSp="0" on the slide to suppress master shapes', async () => {
    // Same setup as "bakes a master non-placeholder shape" but the slide
    // opts out via the showMasterSp attribute. Expected: only the slide's
    // own text shape; master rect is suppressed.
    const slideXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" showMasterSp="0">
  <p:cSld><p:spTree>
    <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
    <p:grpSpPr/>
    <p:sp>
      <p:nvSpPr><p:cNvPr id="2" name="t"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
      <p:spPr>
        <a:xfrm><a:off x="0" y="0"/><a:ext cx="100000" cy="100000"/></a:xfrm>
        <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
      </p:spPr>
      <p:txBody>
        <a:bodyPr/><a:lstStyle/>
        <a:p><a:r><a:rPr lang="en-US"/><a:t>Only this</a:t></a:r></a:p>
      </p:txBody>
    </p:sp>
  </p:spTree></p:cSld>
</p:sld>`
    const layoutXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld><p:spTree>
    <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
    <p:grpSpPr/>
  </p:spTree></p:cSld>
</p:sldLayout>`
    const masterXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld><p:spTree>
    <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
    <p:grpSpPr/>
    <p:sp>
      <p:nvSpPr><p:cNvPr id="2" name="Logo"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
      <p:spPr>
        <a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="914400"/></a:xfrm>
        <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
        <a:solidFill><a:srgbClr val="FF0000"/></a:solidFill>
      </p:spPr>
    </p:sp>
  </p:spTree></p:cSld>
</p:sldMaster>`
    const buf = await makeFixture({ slideXml, layoutXml, masterXml, themeXml: OFFICE_THEME })
    const out = await parsePptx(buf)
    expect(out.slides[0]!.shapes).toHaveLength(1)
    expect(out.slides[0]!.shapes[0]!.kind).toBe('text')
  })
})
