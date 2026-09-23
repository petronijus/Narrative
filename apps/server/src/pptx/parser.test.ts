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
import { randomBytes } from 'node:crypto'
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
  /** Inner XML of `<p:defaultTextStyle>` in presentation.xml. */
  defaultTextStyleXml?: string
}): Promise<Buffer> {
  const zip = new JSZip()
  zip.file(
    'ppt/presentation.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst>
  <p:sldSz cx="12192000" cy="6858000"/>${
    opts.defaultTextStyleXml !== undefined
      ? `\n  <p:defaultTextStyle xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">${opts.defaultTextStyleXml}</p:defaultTextStyle>`
      : ''
  }
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

  it('resolves alias slots (bg1/tx1/bg2/tx2) against the loaded theme, not DEFAULT_THEME', async () => {
    // Regression for the sample deck: theme stores `lt1 = 010101`
    // (near-black) instead of the conventional white. A run with
    // `<a:schemeClr val="bg1"/>` must alias-resolve to `lt1` from the
    // LOADED theme and import as #010101 — not as DEFAULT_THEME.bg1 (white).
    const DARK_LT1_THEME = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <a:themeElements><a:clrScheme name="DarkLt1">
    <a:dk1><a:srgbClr val="010101"/></a:dk1>
    <a:lt1><a:srgbClr val="010101"/></a:lt1>
    <a:dk2><a:srgbClr val="A7A7A7"/></a:dk2>
    <a:lt2><a:srgbClr val="535353"/></a:lt2>
    <a:accent1><a:srgbClr val="FFFE59"/></a:accent1>
    <a:accent2><a:srgbClr val="FEF400"/></a:accent2>
    <a:accent3><a:srgbClr val="3D05AC"/></a:accent3>
    <a:accent4><a:srgbClr val="550DF5"/></a:accent4>
    <a:accent5><a:srgbClr val="48EABB"/></a:accent5>
    <a:accent6><a:srgbClr val="FF0055"/></a:accent6>
  </a:clrScheme></a:themeElements>
</a:theme>`
    const buf = await makeFixture({
      themeXml: DARK_LT1_THEME,
      slideXml: `${SLIDE_OPEN}
        <p:sp>
          <p:nvSpPr><p:cNvPr id="2" name="t"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
          <p:spPr>
            <a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="914400"/></a:xfrm>
            <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
          </p:spPr>
          <p:txBody>
            <a:bodyPr/>
            <a:lstStyle/>
            <a:p><a:r>
              <a:rPr lang="en-US"><a:solidFill><a:schemeClr val="bg1"/></a:solidFill></a:rPr>
              <a:t>Hello</a:t>
            </a:r></a:p>
          </p:txBody>
        </p:sp>
      ${SLIDE_CLOSE}`,
    })
    const out = await parsePptx(buf)
    expect(out.slides[0]!.shapes[0]!.textColor).toBe(0x010101)
  })

  it('falls back to <a:lstStyle>/<a:lvl1pPr>/<a:defRPr> when run rPr has no color', async () => {
    // Regression for the sample "ACME" shape — the run is just
    // <a:rPr sz="N"/> with no solidFill; the colour lives on the text
    // body's lstStyle defRPr. Must inherit per OOXML run-property cascade.
    const buf = await makeFixture({
      themeXml: OFFICE_THEME,
      slideXml: `${SLIDE_OPEN}
        <p:sp>
          <p:nvSpPr><p:cNvPr id="2" name="t"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
          <p:spPr>
            <a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="914400"/></a:xfrm>
            <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
          </p:spPr>
          <p:txBody>
            <a:bodyPr/>
            <a:lstStyle>
              <a:lvl1pPr algn="ctr">
                <a:defRPr sz="3000">
                  <a:solidFill><a:srgbClr val="D1FD51"/></a:solidFill>
                  <a:latin typeface="Custom Display"/>
                </a:defRPr>
              </a:lvl1pPr>
            </a:lstStyle>
            <a:p><a:r><a:rPr sz="5997"/><a:t>ACME</a:t></a:r></a:p>
          </p:txBody>
        </p:sp>
      ${SLIDE_CLOSE}`,
    })
    const out = await parsePptx(buf)
    const sh = out.slides[0]!.shapes[0]!
    expect(sh.textColor).toBe(0xd1fd51)
    expect(sh.fontFamily).toBe('Custom Display')
  })

  it('falls back to <a:pPr>/<a:defRPr> when run rPr has no color', async () => {
    // Regression for the sample "you say when…" shape — the paragraph
    // has its own <a:pPr><a:defRPr> with colour + font; runs inside carry
    // only <a:rPr sz="N"/>. Per-paragraph defRPr fallback must apply.
    const buf = await makeFixture({
      themeXml: OFFICE_THEME,
      slideXml: `${SLIDE_OPEN}
        <p:sp>
          <p:nvSpPr><p:cNvPr id="2" name="t"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
          <p:spPr>
            <a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="914400"/></a:xfrm>
            <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
          </p:spPr>
          <p:txBody>
            <a:bodyPr/>
            <a:lstStyle/>
            <a:p>
              <a:pPr>
                <a:defRPr sz="1400">
                  <a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill>
                  <a:latin typeface="Paragraph Font"/>
                </a:defRPr>
              </a:pPr>
              <a:r><a:rPr sz="2799"/><a:t>hello</a:t></a:r>
            </a:p>
          </p:txBody>
        </p:sp>
      ${SLIDE_CLOSE}`,
    })
    const out = await parsePptx(buf)
    const sh = out.slides[0]!.shapes[0]!
    expect(sh.textColor).toBe(0xffffff)
    expect(sh.fontFamily).toBe('Paragraph Font')
    // Run-level sz overrides paraDefaults.fontSize.
    expect(sh.fontSize).toBeCloseTo(2799 * (96 / 7200), 2)
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
    // PPTX <a:p> paragraph boundary emits U+2029 (PARAGRAPH SEPARATOR),
    // not '\n'. That's the renderer-side signal to start a fresh bullet
    // segment — soft-break '\n' (PPTX <a:br>) stays continuation. See
    // parser.ts paragraph-break emission for the full rationale.
    expect(runs.map((r) => r.text)).toEqual(['Line one', '\u2029', 'Line two'])
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

  it('parses a 2×2 table into a single kind=table shape with per-cell text', async () => {
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
    expect(shapes).toHaveLength(1)
    const tbl = shapes[0]!
    expect(tbl.kind).toBe('table')
    expect(tbl.x).toBeCloseTo(0)
    expect(tbl.y).toBeCloseTo(0)
    expect(tbl.width).toBeCloseTo(192) // 2 × 96 px
    expect(tbl.height).toBeCloseTo(96) // 2 × 48 px
    expect(tbl.tableColWidths).toHaveLength(2)
    expect(tbl.tableRowHeights).toHaveLength(2)
    expect(tbl.tableColWidths![0]).toBeCloseTo(96)
    expect(tbl.tableRowHeights![0]).toBeCloseTo(48)
    const rows = tbl.tableCells!
    expect(rows[0]![0]!.text).toBe('A1')
    expect(rows[0]![1]!.text).toBe('B1')
    expect(rows[1]![0]!.text).toBe('A2')
    expect(rows[1]![1]!.text).toBe('B2')
  })

  it('emits an empty-string cell when `<a:txBody>` is absent', async () => {
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
    expect(shapes[0]!.kind).toBe('table')
    expect(shapes[0]!.tableCells![0]![0]!.text).toBe('')
  })

  it('stamps merge pointers + origin gridSpan for hMerge cells', async () => {
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
    const tbl = out.slides[0]!.shapes[0]!
    expect(tbl.kind).toBe('table')
    const cells = tbl.tableCells!
    expect(cells[0]![0]!.gridSpan).toBe(2)
    expect(cells[0]![0]!.text).toBe('Header')
    expect(cells[0]![1]!.mergeOriginR).toBe(0)
    expect(cells[0]![1]!.mergeOriginC).toBe(0)
  })

  it('applies <a:tcPr><a:solidFill> to the cell fill', async () => {
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
    const tbl = out.slides[0]!.shapes[0]!
    expect(tbl.kind).toBe('table')
    expect(tbl.tableCells![0]![0]!.fill).toBe(0xff8800)
  })

  it('captures `<a:lnL/R/T/B>` edges as per-edge cell borders', async () => {
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
    const tbl = out.slides[0]!.shapes[0]!
    expect(tbl.kind).toBe('table')
    const border = tbl.tableCells![0]![0]!.border
    expect(border?.left?.color).toBe(0x112233)
    expect(border?.left?.width).toBeCloseTo(2, 1) // 19050 EMU = 2 px @ 96 DPI
    expect(border?.bottom?.color).toBe(0x445566)
    expect(border?.bottom?.width).toBeCloseTo(4, 1) // 38100 EMU = 4 px
    // Edges not declared by the XML are absent — renderer falls back
    // to the table default for those.
    expect(border?.top).toBeUndefined()
    expect(border?.right).toBeUndefined()
  })

  it('captures a `<a:tcPr>/<a:gradFill>` as the cell fillGradient', async () => {
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
                  <a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US"/><a:t>g</a:t></a:r></a:p></a:txBody>
                  <a:tcPr>
                    <a:gradFill>
                      <a:gsLst>
                        <a:gs pos="0"><a:srgbClr val="FF0000"/></a:gs>
                        <a:gs pos="100000"><a:srgbClr val="0000FF"/></a:gs>
                      </a:gsLst>
                      <a:lin ang="5400000" scaled="1"/>
                    </a:gradFill>
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
    const tbl = out.slides[0]!.shapes[0]!
    expect(tbl.kind).toBe('table')
    const g = tbl.tableCells![0]![0]!.fillGradient
    expect(g).toBeDefined()
    expect(g!.kind).toBe('linearGradient')
    expect(g!.stops).toHaveLength(2)
    expect(g!.stops[0]!.color).toBe(0xff0000)
    expect(g!.stops[1]!.color).toBe(0x0000ff)
  })

  it('captures cell typography (lineHeight + letterSpacing + textTransform)', async () => {
    // Single cell with a `<a:pPr lnSpc>/<a:spcPct val="150000">` (1.5x
    // line-height) and a run carrying `<a:rPr spc="200" cap="all">`
    // (200/100 = 2 pt letter-spacing = 2.67 px @ PPTX_FONT_TO_PX,
    // uppercase). Parser should land all three on ParsedTableCell.
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
                  <a:txBody>
                    <a:bodyPr/><a:lstStyle/>
                    <a:p>
                      <a:pPr><a:lnSpc><a:spcPct val="150000"/></a:lnSpc></a:pPr>
                      <a:r><a:rPr lang="en-US" sz="1800" spc="200" cap="all"/><a:t>tex</a:t></a:r>
                    </a:p>
                  </a:txBody>
                  <a:tcPr/>
                </a:tc>
              </a:tr>
            </a:tbl>
          </a:graphicData>
        </a:graphic>
      </p:graphicFrame>
    ${SLIDE_CLOSE}`
    const buf = await makeFixture({ slideXml, themeXml: OFFICE_THEME })
    const out = await parsePptx(buf)
    const tbl = out.slides[0]!.shapes[0]!
    expect(tbl.kind).toBe('table')
    const cell = tbl.tableCells![0]![0]!
    // Source spcPct=150000 (1.5x raw). Parser applies the
    // PPTX_LINE_LEADING_FACTOR (1.2) so the stored value reflects
    // PowerPoint's effective single-line metric rather than a pure
    // multiplier. 1.5 × 1.2 = 1.8. See parser.ts comment on the
    // constant for the spcPct→CSS rationale.
    expect(cell.lineHeight).toBeCloseTo(1.5 * 1.2, 2)
    expect(cell.letterSpacing).toBeGreaterThan(0)
    expect(cell.textTransform).toBe('uppercase')
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
    const tbl = out.slides[0]!.shapes[0]!
    expect(tbl.kind).toBe('table')
    expect(tbl.tableCells![0]![0]!.fill).toBe(0x4472c4) // header (firstRow)
    expect(tbl.tableCells![1]![0]!.fill).toBeUndefined() // body row — unshaded
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
    const tbl = out.slides[0]!.shapes[0]!
    expect(tbl.kind).toBe('table')
    const cells = tbl.tableCells!
    expect(cells[0]![0]!.fill).toBe(0x4472c4) // header (firstRow)
    expect(cells[1]![0]!.fill).toBeUndefined() // data row 0 — unshaded
    expect(cells[2]![0]!.fill).toBeDefined() // data row 1 — banded
    expect(cells[3]![0]!.fill).toBeUndefined() // data row 2 — unshaded
    // Banded fill is a tint of accent1 — lighter than the original.
    const banded = cells[2]![0]!.fill!
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
    const tbl = out.slides[0]!.shapes[0]!
    expect(tbl.kind).toBe('table')
    // Explicit green fill wins over preset header colour.
    expect(tbl.tableCells![0]![0]!.fill).toBe(0x00ff00)
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
    // Single-subpath case: no anchor should carry a `moveTo` flag —
    // the renderer treats index 0 as an implicit moveTo.
    for (const a of shape.pathAnchors!) {
      expect(a.moveTo).toBeUndefined()
    }
  })

  it('parses multi-subpath `<a:custGeom>` (moveTo→close→moveTo) with subpath markers', async () => {
    // Two disconnected closed squares packed into one <a:path> — the
    // shape PPTX uses for dot-grid icons (slide 8 of the audit deck).
    // Without subpath tracking the renderer draws a straight line
    // from each subpath's close to the next moveTo, producing the
    // diagonal-shear artefact. The parser must mark each anchor that
    // begins a new subpath with `moveTo: true` so the renderer can
    // emit Graphics.moveTo for it.
    const buf = await makeFixture({
      themeXml: OFFICE_THEME,
      slideXml: `${SLIDE_OPEN}
        <p:sp>
          <p:nvSpPr><p:cNvPr id="2" name="g"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
          <p:spPr>
            <a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="914400"/></a:xfrm>
            <a:custGeom>
              <a:pathLst>
                <a:path w="200" h="200">
                  <a:moveTo><a:pt x="0" y="0"/></a:moveTo>
                  <a:lnTo><a:pt x="20" y="0"/></a:lnTo>
                  <a:lnTo><a:pt x="20" y="20"/></a:lnTo>
                  <a:lnTo><a:pt x="0" y="20"/></a:lnTo>
                  <a:close/>
                  <a:moveTo><a:pt x="100" y="100"/></a:moveTo>
                  <a:lnTo><a:pt x="120" y="100"/></a:lnTo>
                  <a:lnTo><a:pt x="120" y="120"/></a:lnTo>
                  <a:lnTo><a:pt x="100" y="120"/></a:lnTo>
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
    // 8 anchors total — 4 per subpath.
    expect(shape.pathAnchors).toHaveLength(8)
    // Anchor 0 is the implicit subpath start (no flag, renderer infers).
    expect(shape.pathAnchors![0]!.moveTo).toBeUndefined()
    // Anchors 1-3 inside subpath 1 — no flag.
    expect(shape.pathAnchors![1]!.moveTo).toBeUndefined()
    expect(shape.pathAnchors![2]!.moveTo).toBeUndefined()
    expect(shape.pathAnchors![3]!.moveTo).toBeUndefined()
    // Anchor 4 starts the SECOND subpath — must carry the flag.
    expect(shape.pathAnchors![4]!.moveTo).toBe(true)
    expect(shape.pathAnchors![4]!.x).toBeCloseTo(48, 1) // 100/200 of 96 px
    // Remaining anchors of subpath 2 — no flag.
    expect(shape.pathAnchors![5]!.moveTo).toBeUndefined()
    expect(shape.pathAnchors![6]!.moveTo).toBeUndefined()
    expect(shape.pathAnchors![7]!.moveTo).toBeUndefined()
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

  it('captures lineSpacing (lnSpc spcPct) + paragraphSpace on the first <a:pPr>', async () => {
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
    // spcPct is a multiple of the font's normal line height and is stored
    // verbatim as lineSpacing; lineHeight (a font-size multiple) stays unset
    // so the client resolves against the real font.
    expect(shape.lineSpacing).toBeCloseTo(1.5, 6)
    expect(shape.lineHeight).toBeUndefined()
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

  it('captures `<a:blip>/<a:alphaModFix amt>` as image opacity', async () => {
    // Regression for the sample deck — a `<p:pic>` with
    // `<a:alphaModFix amt="10000"/>` (10% opacity) on its blip must surface
    // as `imageAlpha = 0.1` on the parsed shape.
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
            <a:blip r:embed="rId2"><a:alphaModFix amt="10000"/></a:blip>
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
    expect(shape.imageAlpha).toBeCloseTo(0.1, 3)
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

  // ─── Charts (fallback-image import) ──────────────────────────────────────

  it('imports a chart `<p:graphicFrame>` as an image via the `<a:blip>` poster', async () => {
    // Chart shape with the poster image embedded inside `<a:graphicData>`
    // — Google Slides + some Office variants emit this shape. We expect
    // the parser to surface a kind=image shape with the chart's bbox and
    // the resolved imagePath.
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
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/chart-poster.png"/>
</Relationships>`,
    )
    zip.file(
      'ppt/slides/slide1.xml',
      `${SLIDE_OPEN}
        <p:graphicFrame>
          <p:nvGraphicFramePr><p:cNvPr id="2" name="Chart"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>
          <p:xfrm><a:off x="914400" y="457200"/><a:ext cx="4572000" cy="3429000"/></p:xfrm>
          <a:graphic>
            <a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart">
              <c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="rId2"/>
              <a:blip r:embed="rId2"/>
            </a:graphicData>
          </a:graphic>
        </p:graphicFrame>
      ${SLIDE_CLOSE}`,
    )
    zip.file(
      'ppt/media/chart-poster.png',
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
        'base64',
      ),
    )
    const buf = Buffer.from(await zip.generateAsync({ type: 'nodebuffer' }))
    const out = await parsePptx(buf)
    const shape = out.slides[0]!.shapes[0]!
    expect(shape.kind).toBe('image')
    expect(shape.sourceTag).toBe('p:graphicFrame')
    expect(shape.imagePath).toBe('ppt/media/chart-poster.png')
    // Geometry from the graphicFrame's xfrm: 914400 EMU = 96 px.
    expect(shape.x).toBeCloseTo(96, 1)
    expect(shape.y).toBeCloseTo(48, 1)
    expect(shape.width).toBeCloseTo(480, 1)
    expect(shape.height).toBeCloseTo(360, 1)
  })

  it('imports an `<mc:AlternateContent>` wrapped chart via the `<mc:Fallback>` `<p:pic>`', async () => {
    // Modern Office structure: chart in `<mc:Choice>`, poster image as a
    // `<p:pic>` inside `<mc:Fallback>`. The parser should take the
    // fallback path and emit the picture's normal image shape.
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
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/fallback-poster.png"/>
</Relationships>`,
    )
    zip.file(
      'ppt/slides/slide1.xml',
      `${SLIDE_OPEN}
        <mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006">
          <mc:Choice xmlns:c14="http://schemas.microsoft.com/office/drawing/2007/8/2/chart" Requires="c14">
            <p:graphicFrame>
              <p:nvGraphicFramePr><p:cNvPr id="2" name="Chart"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>
              <p:xfrm><a:off x="0" y="0"/><a:ext cx="4572000" cy="3429000"/></p:xfrm>
              <a:graphic>
                <a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart">
                  <c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="rId2"/>
                </a:graphicData>
              </a:graphic>
            </p:graphicFrame>
          </mc:Choice>
          <mc:Fallback>
            <p:pic>
              <p:nvPicPr><p:cNvPr id="3" name="ChartFallback"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>
              <p:blipFill>
                <a:blip r:embed="rId3"/>
                <a:stretch><a:fillRect/></a:stretch>
              </p:blipFill>
              <p:spPr>
                <a:xfrm><a:off x="0" y="0"/><a:ext cx="4572000" cy="3429000"/></a:xfrm>
                <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
              </p:spPr>
            </p:pic>
          </mc:Fallback>
        </mc:AlternateContent>
      ${SLIDE_CLOSE}`,
    )
    zip.file(
      'ppt/media/fallback-poster.png',
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
        'base64',
      ),
    )
    const buf = Buffer.from(await zip.generateAsync({ type: 'nodebuffer' }))
    const out = await parsePptx(buf)
    const shape = out.slides[0]!.shapes[0]!
    expect(shape.kind).toBe('image')
    expect(shape.imagePath).toBe('ppt/media/fallback-poster.png')
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
    // Legacy frame-wide field still derived from the first paragraph.
    expect(out.slides[0]!.shapes[0]!.listStyle).toBe('bullet')
    // Per-paragraph block attrs carry the glyph.
    expect(out.slides[0]!.shapes[0]!.paragraphs).toEqual([{ list: 'bullet', bulletChar: '•' }])
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
    expect(out.slides[0]!.shapes[0]!.paragraphs).toEqual([
      { list: 'number', numberFormat: 'decimal' },
    ])
  })

  it('maps every buAutoNum type token to the right numberFormat', async () => {
    // One paragraph per OOXML autonum token; assert the mapping table.
    const cases: Array<[string, string]> = [
      ['arabicPeriod', 'decimal'],
      ['arabicParenR', 'decimalParen'],
      ['arabicParenBoth', 'decimalParen'],
      ['alphaLcPeriod', 'lowerAlpha'],
      ['alphaLcParenR', 'lowerAlphaParen'],
      ['alphaUcPeriod', 'upperAlpha'],
      ['alphaUcParenR', 'upperAlphaParen'],
      ['romanLcPeriod', 'lowerRoman'],
      ['romanUcPeriod', 'upperRoman'],
      ['someUnknownToken', 'decimal'], // fallback
    ]
    const paras = cases
      .map(
        ([token], i) =>
          `<a:p><a:pPr><a:buAutoNum type="${token}"/></a:pPr>` +
          `<a:r><a:rPr lang="en-US"/><a:t>Item ${i}</a:t></a:r></a:p>`,
      )
      .join('')
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
          <p:txBody><a:bodyPr/><a:lstStyle/>${paras}</p:txBody>
        </p:sp>
      ${SLIDE_CLOSE}`,
    })
    const out = await parsePptx(buf)
    const got = out.slides[0]!.shapes[0]!.paragraphs!.map((p) => p.numberFormat)
    expect(got).toEqual(cases.map(([, fmt]) => fmt))
  })

  it('captures buAutoNum startAt when present and ≥ 1', async () => {
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
          <p:txBody><a:bodyPr/><a:lstStyle/>
            <a:p>
              <a:pPr><a:buAutoNum type="arabicPeriod" startAt="5"/></a:pPr>
              <a:r><a:rPr lang="en-US"/><a:t>Five</a:t></a:r>
            </a:p>
          </p:txBody>
        </p:sp>
      ${SLIDE_CLOSE}`,
    })
    const out = await parsePptx(buf)
    expect(out.slides[0]!.shapes[0]!.paragraphs).toEqual([
      { list: 'number', numberFormat: 'decimal', startAt: 5 },
    ])
  })

  it('captures per-paragraph lvl as nesting level (multi-level list)', async () => {
    const paras = [0, 1, 2, 1]
      .map(
        (lvl, i) =>
          `<a:p><a:pPr lvl="${lvl}"><a:buChar char="•"/></a:pPr>` +
          `<a:r><a:rPr lang="en-US"/><a:t>L${i}</a:t></a:r></a:p>`,
      )
      .join('')
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
          <p:txBody><a:bodyPr/><a:lstStyle/>${paras}</p:txBody>
        </p:sp>
      ${SLIDE_CLOSE}`,
    })
    const out = await parsePptx(buf)
    const got = out.slides[0]!.shapes[0]!.paragraphs!
    // level 0 omitted; 1/2 carried.
    expect(got.map((p) => p.level ?? 0)).toEqual([0, 1, 2, 1])
    expect(got.every((p) => p.list === 'bullet')).toBe(true)
    expect(got.every((p) => p.bulletChar === '•')).toBe(true)
  })

  it('keeps a Wingdings-style custom buChar glyph verbatim', async () => {
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
          <p:txBody><a:bodyPr/><a:lstStyle/>
            <a:p>
              <a:pPr><a:buChar char="▪"/></a:pPr>
              <a:r><a:rPr lang="en-US"/><a:t>Square bullet</a:t></a:r>
            </a:p>
          </p:txBody>
        </p:sp>
      ${SLIDE_CLOSE}`,
    })
    const out = await parsePptx(buf)
    expect(out.slides[0]!.shapes[0]!.paragraphs).toEqual([{ list: 'bullet', bulletChar: '▪' }])
  })

  it('mixes bulleted, plain, and numbered paragraphs in one box', async () => {
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
          <p:txBody><a:bodyPr/><a:lstStyle/>
            <a:p><a:pPr><a:buChar char="•"/></a:pPr><a:r><a:rPr lang="en-US"/><a:t>Bullet</a:t></a:r></a:p>
            <a:p><a:pPr><a:buNone/></a:pPr><a:r><a:rPr lang="en-US"/><a:t>Plain</a:t></a:r></a:p>
            <a:p><a:pPr><a:buAutoNum type="arabicParenR"/></a:pPr><a:r><a:rPr lang="en-US"/><a:t>Numbered</a:t></a:r></a:p>
          </p:txBody>
        </p:sp>
      ${SLIDE_CLOSE}`,
    })
    const out = await parsePptx(buf)
    expect(out.slides[0]!.shapes[0]!.paragraphs).toEqual([
      { list: 'bullet', bulletChar: '•' },
      {}, // buNone → plain paragraph
      { list: 'number', numberFormat: 'decimalParen' },
    ])
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
    // Inherited bullet has only a coarse kind (no glyph from txStyles layer).
    expect(out.slides[0]!.shapes[0]!.paragraphs).toEqual([{ list: 'bullet' }])
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
    // buNone veto ⇒ plain paragraph ⇒ no per-paragraph list data emitted.
    expect(out.slides[0]!.shapes[0]!.paragraphs).toBeUndefined()
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

  // ─── Embedded fonts (F1) ─────────────────────────────────────────────────

  it('extracts embedded fonts from <p:embeddedFontLst> with rels resolution', async () => {
    // Synthetic TrueType buffer — the parser only extracts raw bytes from
    // the zip entry; it doesn't parse font tables. We just need *some*
    // Buffer so we can assert the round-trip preserves length and content.
    // The first 12 bytes are a valid TrueType offset-table header
    // (sfVersion 0x00010000, numTables=0, searchRange/entry/range=0).
    const ttfBytes = Buffer.alloc(64)
    ttfBytes.writeUInt32BE(0x00010000, 0) // sfVersion — TrueType magic

    const zip = new JSZip()
    zip.file(
      'ppt/presentation.xml',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst>
  <p:sldSz cx="12192000" cy="6858000"/>
  <p:embeddedFontLst>
    <p:embeddedFont>
      <p:font typeface="DejaVu Sans Condensed" panose="020F0506030104020404" pitchFamily="34" charset="0"/>
      <p:regular r:id="rId10"/>
      <p:bold r:id="rId11"/>
    </p:embeddedFont>
  </p:embeddedFontLst>
</p:presentation>`,
    )
    zip.file(
      'ppt/_rels/presentation.xml.rels',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>
  <Relationship Id="rId10" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/font" Target="fonts/font1.fntdata"/>
  <Relationship Id="rId11" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/font" Target="fonts/font2.fntdata"/>
</Relationships>`,
    )
    zip.file('ppt/slides/slide1.xml', `${SLIDE_OPEN}${SLIDE_CLOSE}`)
    zip.file('ppt/fonts/font1.fntdata', ttfBytes)
    zip.file('ppt/fonts/font2.fntdata', ttfBytes)

    const buf = Buffer.from(await zip.generateAsync({ type: 'nodebuffer' }))
    const out = await parsePptx(buf)
    // Two variants surfaced under the same typeface; bytes preserved.
    expect(out.embeddedFonts).toHaveLength(2)
    const regular = out.embeddedFonts.find((f) => f.variant === 'regular')
    const bold = out.embeddedFonts.find((f) => f.variant === 'bold')
    expect(regular).toBeDefined()
    expect(bold).toBeDefined()
    expect(regular!.typeface).toBe('DejaVu Sans Condensed')
    expect(regular!.bytes.length).toBe(ttfBytes.length)
    // .fntdata extension is normalised to .ttf since the bytes are
    // already raw TrueType — that's what the storage key gets.
    expect(regular!.ext).toBe('ttf')
  })

  it('skips embedded fonts referenced by rId without a matching file', async () => {
    // Same shape as the happy path but the rId points at a missing zip
    // entry. The parser should log into ignoredElements and continue
    // rather than crash.
    const zip = new JSZip()
    zip.file(
      'ppt/presentation.xml',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst>
  <p:sldSz cx="12192000" cy="6858000"/>
  <p:embeddedFontLst>
    <p:embeddedFont>
      <p:font typeface="MissingFace"/>
      <p:regular r:id="rId10"/>
    </p:embeddedFont>
  </p:embeddedFontLst>
</p:presentation>`,
    )
    zip.file(
      'ppt/_rels/presentation.xml.rels',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>
  <Relationship Id="rId10" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/font" Target="fonts/missing.fntdata"/>
</Relationships>`,
    )
    zip.file('ppt/slides/slide1.xml', `${SLIDE_OPEN}${SLIDE_CLOSE}`)
    const buf = Buffer.from(await zip.generateAsync({ type: 'nodebuffer' }))
    const out = await parsePptx(buf)
    expect(out.embeddedFonts).toHaveLength(0)
    expect(out.ignoredElements.some((s) => s.startsWith('embeddedFont:missing:'))).toBe(true)
  })

  it('returns an empty embeddedFonts array when the deck has no <p:embeddedFontLst>', async () => {
    const buf = await makeFixture({ slideXml: `${SLIDE_OPEN}${SLIDE_CLOSE}` })
    const out = await parsePptx(buf)
    expect(out.embeddedFonts).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// DoS hardening — decompression-bomb guards (assertNotZipBomb)
//
// The on-the-wire 2 GB import cap is intentionally NOT reduced (large decks
// must import); protection is the per-entry compression-ratio guard, which
// catches the decompression-bomb signature without limiting legitimate large
// files. The total-size / entry-count bounds are backstops set far above any
// realistic deck, so they're not exercised here (a 200k-entry fixture would be
// impractically slow); the ratio guard is the meaningful, testable one.
// ---------------------------------------------------------------------------
describe('parsePptx — layout/master inheritance', () => {
  // A theme whose font scheme names both faces, so `+mn-lt` / `+mj-lt`
  // references have something real to resolve to.
  const THEME_WITH_FONTS = OFFICE_THEME.replace(
    '</a:clrScheme></a:themeElements>',
    `</a:clrScheme>
    <a:fontScheme name="Test">
      <a:majorFont><a:latin typeface="Heading Face"/></a:majorFont>
      <a:minorFont><a:latin typeface="Body Face"/></a:minorFont>
    </a:fontScheme></a:themeElements>`,
  )

  /** Slide with a bare title placeholder: no geometry, no run properties —
   *  everything has to come down the layout → master → theme chain. */
  const BARE_TITLE_SLIDE = `${SLIDE_OPEN}
      <p:sp>
        <p:nvSpPr>
          <p:cNvPr id="2" name="Title"/><p:cNvSpPr/>
          <p:nvPr><p:ph type="title"/></p:nvPr>
        </p:nvSpPr>
        <p:spPr/>
        <p:txBody>
          <a:bodyPr/><a:lstStyle/>
          <a:p><a:r><a:rPr lang="en-US"/><a:t>Hello</a:t></a:r></a:p>
        </p:txBody>
      </p:txBody-placeholder>
    ${SLIDE_CLOSE}`.replace('</p:txBody-placeholder>', '</p:sp>')

  /** Layout title placeholder that declares text defaults but NO `<a:xfrm>` —
   *  the shape PowerPoint expects to inherit its box from the master. */
  const LAYOUT_NO_GEOMETRY = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld><p:spTree>
    <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
    <p:grpSpPr/>
    <p:sp>
      <p:nvSpPr>
        <p:cNvPr id="2" name="Title"/><p:cNvSpPr/>
        <p:nvPr><p:ph type="title"/></p:nvPr>
      </p:nvSpPr>
      <p:spPr/>
      <p:txBody>
        <a:bodyPr/>
        <a:lstStyle><a:lvl1pPr algn="ctr"><a:defRPr sz="4000"/></a:lvl1pPr></a:lstStyle>
      </p:txBody>
    </p:sp>
  </p:spTree></p:cSld>
</p:sldLayout>`

  const MASTER_WITH_GEOMETRY = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld><p:spTree>
    <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
    <p:grpSpPr/>
    <p:sp>
      <p:nvSpPr>
        <p:cNvPr id="2" name="Title"/><p:cNvSpPr/>
        <p:nvPr><p:ph type="title"/></p:nvPr>
      </p:nvSpPr>
      <p:spPr>
        <a:xfrm><a:off x="952500" y="476250"/><a:ext cx="9525000" cy="1905000"/></a:xfrm>
      </p:spPr>
      <p:txBody>
        <a:bodyPr/>
        <a:lstStyle><a:lvl1pPr><a:defRPr sz="8800"><a:latin typeface="+mn-lt"/></a:defRPr></a:lvl1pPr></a:lstStyle>
      </p:txBody>
    </p:sp>
  </p:spTree></p:cSld>
</p:sldMaster>`

  it('takes the master geometry when the layout placeholder declares none', async () => {
    // Regression: the layout entry used to replace the master's wholesale, so
    // a layout placeholder without <a:xfrm> collapsed the frame to 0×0. The
    // renderer then word-wrapped at width 0 and clipped the text away — the
    // text was simply invisible.
    const buf = await makeFixture({
      slideXml: BARE_TITLE_SLIDE,
      layoutXml: LAYOUT_NO_GEOMETRY,
      masterXml: MASTER_WITH_GEOMETRY,
      themeXml: THEME_WITH_FONTS,
    })
    const shape = (await parsePptx(buf)).slides[0]!.shapes[0]!
    expect(shape.kind).toBe('text')
    expect(shape.x).toBeCloseTo(100, 0) // 952500 / 9525
    expect(shape.y).toBeCloseTo(50, 0) // 476250 / 9525
    expect(shape.width).toBeCloseTo(1000, 0) // 9525000 / 9525
    expect(shape.height).toBeCloseTo(200, 0) // 1905000 / 9525
  })

  it('keeps layout text defaults while inheriting master geometry', async () => {
    // The merge is per field: geometry from the master, alignment and size
    // from the layout that actually declared them.
    const buf = await makeFixture({
      slideXml: BARE_TITLE_SLIDE,
      layoutXml: LAYOUT_NO_GEOMETRY,
      masterXml: MASTER_WITH_GEOMETRY,
      themeXml: THEME_WITH_FONTS,
    })
    const shape = (await parsePptx(buf)).slides[0]!.shapes[0]!
    expect(shape.textAlign).toBe('center')
    // sz="4000" is 40 pt; the parser reports px (pt × 96/72).
    expect(shape.fontSize).toBeCloseTo((4000 / 100) * (96 / 72), 1)
  })

  it('resolves a +mn-lt theme font reference to the theme font', async () => {
    const buf = await makeFixture({
      slideXml: BARE_TITLE_SLIDE,
      layoutXml: LAYOUT_NO_GEOMETRY,
      masterXml: MASTER_WITH_GEOMETRY,
      themeXml: THEME_WITH_FONTS,
    })
    const shape = (await parsePptx(buf)).slides[0]!.shapes[0]!
    // The master states `<a:latin typeface="+mn-lt"/>`; the theme's minor
    // font is "Body Face". Before the resolver this surfaced as `undefined`
    // (the raw `+mn-lt` was skipped), so the deck rendered in the browser's
    // default font instead of the template's.
    expect(shape.fontFamily).toBe('Body Face')
  })

  it('resolves a +mj-lt reference on a slide run to the major theme font', async () => {
    const slideXml = `${SLIDE_OPEN}
      <p:sp>
        <p:nvSpPr>
          <p:cNvPr id="2" name="Title"/><p:cNvSpPr/>
          <p:nvPr><p:ph type="title"/></p:nvPr>
        </p:nvSpPr>
        <p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="9525000" cy="952500"/></a:xfrm></p:spPr>
        <p:txBody>
          <a:bodyPr/><a:lstStyle/>
          <a:p><a:r><a:rPr lang="en-US"><a:latin typeface="+mj-lt"/></a:rPr><a:t>Hi</a:t></a:r></a:p>
        </p:txBody>
      </p:sp>
    ${SLIDE_CLOSE}`
    const buf = await makeFixture({ slideXml, themeXml: THEME_WITH_FONTS })
    const shape = (await parsePptx(buf)).slides[0]!.shapes[0]!
    const run = shape.textRuns?.[0]
    expect(run?.fontFamily).toBe('Heading Face')
  })

  it('drops a theme reference the theme cannot resolve rather than leaking OOXML', async () => {
    const slideXml = `${SLIDE_OPEN}
      <p:sp>
        <p:nvSpPr><p:cNvPr id="2" name="T"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
        <p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="9525000" cy="952500"/></a:xfrm></p:spPr>
        <p:txBody>
          <a:bodyPr/><a:lstStyle/>
          <a:p><a:r><a:rPr lang="en-US"><a:latin typeface="+mn-lt"/></a:rPr><a:t>Hi</a:t></a:r></a:p>
        </p:txBody>
      </p:sp>
    ${SLIDE_CLOSE}`
    // OFFICE_THEME has no <a:fontScheme> at all.
    const buf = await makeFixture({ slideXml, themeXml: OFFICE_THEME })
    const shape = (await parsePptx(buf)).slides[0]!.shapes[0]!
    expect(shape.textRuns?.[0]?.fontFamily).toBeUndefined()
  })

  /** Title placeholder whose own lstStyle restyles size + tracking but says
   *  nothing about line spacing — the Proseware deck's "Now we need to make the
   *  experience even more awesome!" slide. */
  const TITLE_RESIZED_ON_SLIDE = `${SLIDE_OPEN}
      <p:sp>
        <p:nvSpPr>
          <p:cNvPr id="2" name="Title"/><p:cNvSpPr txBox="1"/>
          <p:nvPr><p:ph type="title"/></p:nvPr>
        </p:nvSpPr>
        <p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="4762500" cy="6286500"/></a:xfrm></p:spPr>
        <p:txBody>
          <a:bodyPr/>
          <a:lstStyle><a:lvl1pPr><a:defRPr spc="-418" sz="8835"/></a:lvl1pPr></a:lstStyle>
          <a:p><a:pPr/><a:r><a:t>Now we need to make the experience even more awesome!</a:t></a:r></a:p>
        </p:txBody>
      </p:sp>
    ${SLIDE_CLOSE}`

  const layoutWithTitleLstStyle = (lvl1Inner: string): string =>
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld><p:spTree>
    <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
    <p:grpSpPr/>
    <p:sp>
      <p:nvSpPr>
        <p:cNvPr id="2" name="Title"/><p:cNvSpPr/>
        <p:nvPr><p:ph type="title"/></p:nvPr>
      </p:nvSpPr>
      <p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="4762500" cy="6286500"/></a:xfrm></p:spPr>
      <p:txBody>
        <a:bodyPr/>
        <a:lstStyle><a:lvl1pPr>${lvl1Inner}</a:lvl1pPr></a:lstStyle>
      </p:txBody>
    </p:sp>
  </p:spTree></p:cSld>
</p:sldLayout>`

  it("keeps the layout placeholder's line spacing when the slide only restyles the size", async () => {
    // Regression: the slide's own <a:lvl1pPr> (sz + spc only) ended the
    // search, the layout's 68% was never consulted, and the title laid out
    // at the font's full normal line height — 47% taller than PowerPoint.
    const buf = await makeFixture({
      slideXml: TITLE_RESIZED_ON_SLIDE,
      layoutXml: layoutWithTitleLstStyle(
        '<a:lnSpc><a:spcPct val="68000"/></a:lnSpc><a:defRPr spc="-450" sz="9500"/>',
      ),
    })
    const shape = (await parsePptx(buf)).slides[0]!.shapes[0]!
    expect(shape.lineSpacing).toBeCloseTo(0.68, 6)
    // The slide's own size still wins over the layout's.
    expect(shape.fontSize).toBeCloseTo((8835 / 100) * (96 / 72), 3)
  })

  it("falls back to the master's <p:titleStyle> line spacing", async () => {
    const master = MASTER_WITH_GEOMETRY.replace(
      '</p:spTree></p:cSld>',
      `</p:spTree></p:cSld>
  <p:txStyles>
    <p:titleStyle><a:lvl1pPr><a:lnSpc><a:spcPct val="75000"/></a:lnSpc><a:defRPr sz="9500"/></a:lvl1pPr></p:titleStyle>
  </p:txStyles>`,
    )
    const buf = await makeFixture({
      slideXml: TITLE_RESIZED_ON_SLIDE,
      layoutXml: layoutWithTitleLstStyle('<a:defRPr sz="9500"/>'),
      masterXml: master,
    })
    const shape = (await parsePptx(buf)).slides[0]!.shapes[0]!
    expect(shape.lineSpacing).toBeCloseTo(0.75, 6)
  })

  it('resolves inherited absolute line spacing against the final font size', async () => {
    // spcPts is absolute; as a lineHeight ratio it has to be divided by the
    // size the frame actually renders at — here the slide's 88.35 pt, not
    // the layout's 95 pt it was declared next to.
    const buf = await makeFixture({
      slideXml: TITLE_RESIZED_ON_SLIDE,
      layoutXml: layoutWithTitleLstStyle(
        '<a:lnSpc><a:spcPts val="6000"/></a:lnSpc><a:defRPr sz="9500"/>',
      ),
    })
    const shape = (await parsePptx(buf)).slides[0]!.shapes[0]!
    expect(shape.lineSpacing).toBeUndefined()
    expect(shape.lineHeight).toBeCloseTo(6000 / 8835, 6)
  })

  it('inherits a <p:pic> placeholder frame from the layout', async () => {
    // Regression: inheritance only looked under <p:nvSpPr>; a picture
    // placeholder's <p:ph> lives under <p:nvPicPr>, so it came through as a
    // 0×0 image at the slide origin.
    const slideXml = `${SLIDE_OPEN}
      <p:pic>
        <p:nvPicPr>
          <p:cNvPr id="3" name="Image"/><p:cNvPicPr/>
          <p:nvPr><p:ph type="pic" idx="24"/></p:nvPr>
        </p:nvPicPr>
        <p:blipFill><a:blip r:embed="rIdMissing"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>
        <p:spPr><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>
      </p:pic>
    ${SLIDE_CLOSE}`
    const layoutXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld><p:spTree>
    <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
    <p:grpSpPr/>
    <p:sp>
      <p:nvSpPr>
        <p:cNvPr id="4275" name="Image"/><p:cNvSpPr/>
        <p:nvPr><p:ph type="pic" sz="quarter" idx="24"/></p:nvPr>
      </p:nvSpPr>
      <p:spPr><a:xfrm><a:off x="11430000" y="285750"/><a:ext cx="190500" cy="171450"/></a:xfrm></p:spPr>
    </p:sp>
  </p:spTree></p:cSld>
</p:sldLayout>`
    const buf = await makeFixture({ slideXml, layoutXml })
    const shapes = (await parsePptx(buf)).slides[0]!.shapes
    // The empty layout placeholder itself must not be baked onto the slide.
    expect(shapes).toHaveLength(1)
    const pic = shapes[0]!
    expect(pic.kind).toBe('image')
    expect(pic.x).toBeCloseTo(1200, 3)
    expect(pic.y).toBeCloseTo(30, 3)
    expect(pic.width).toBeCloseTo(20, 3)
    expect(pic.height).toBeCloseTo(18, 3)
  })
})

describe('parsePptx — paragraph outline level', () => {
  /** A text box (not a placeholder) with one paragraph at `lvl="1"`. */
  const textBoxAtLevel2 = (pPrExtra: string, bullet = '', lstStyle = '<a:lstStyle/>'): string =>
    `${SLIDE_OPEN}
      <p:sp>
        <p:nvSpPr><p:cNvPr id="2" name="Headline"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>
        <p:spPr><a:xfrm><a:off x="460964" y="622101"/><a:ext cx="10713058" cy="960121"/></a:xfrm></p:spPr>
        <p:txBody>
          <a:bodyPr lIns="0" tIns="0" rIns="0" bIns="0"/>${lstStyle}
          <a:p><a:pPr lvl="1" ${pPrExtra}>${bullet}</a:pPr><a:r><a:t>We made it to our first Camp!</a:t></a:r></a:p>
        </p:txBody>
      </p:sp>
    ${SLIDE_CLOSE}`

  it('drops the level of a plain paragraph whose level has no margin', async () => {
    // The Proseware deck's headline: lvl 1 selects defaultTextStyle's level 2,
    // whose marL is 0, so PowerPoint draws it flush at the frame edge. The
    // level used to be kept and rendered as a 1.5 em indent — 108 px off.
    const buf = await makeFixture({
      slideXml: textBoxAtLevel2('indent="0"'),
      defaultTextStyleXml: '<a:lvl2pPr marL="0" indent="457200"/>',
    })
    const shape = (await parsePptx(buf)).slides[0]!.shapes[0]!
    expect(shape.paragraphs?.[0]?.level).toBeUndefined()
  })

  it('keeps the level of a plain paragraph whose shape gives that level a margin', async () => {
    const buf = await makeFixture({
      slideXml: textBoxAtLevel2('', '', '<a:lstStyle><a:lvl2pPr marL="457200"/></a:lstStyle>'),
      defaultTextStyleXml: '<a:lvl2pPr marL="0"/>',
    })
    const shape = (await parsePptx(buf)).slides[0]!.shapes[0]!
    expect(shape.paragraphs?.[0]?.level).toBe(1)
  })

  it("lets the paragraph's own marL decide over inherited margins", async () => {
    const buf = await makeFixture({
      slideXml: textBoxAtLevel2(
        'marL="0"',
        '',
        '<a:lstStyle><a:lvl2pPr marL="457200"/></a:lstStyle>',
      ),
    })
    const shape = (await parsePptx(buf)).slides[0]!.shapes[0]!
    expect(shape.paragraphs?.[0]?.level).toBeUndefined()
  })

  it('always keeps the nesting level of a list paragraph', async () => {
    const buf = await makeFixture({
      slideXml: textBoxAtLevel2('marL="0"', '<a:buChar char="•"/>'),
      defaultTextStyleXml: '<a:lvl2pPr marL="0"/>',
    })
    const shape = (await parsePptx(buf)).slides[0]!.shapes[0]!
    expect(shape.paragraphs?.[0]?.level).toBe(1)
    expect(shape.paragraphs?.[0]?.list).toBe('bullet')
  })
})

describe('parsePptx — zip-bomb guards', () => {
  it('rejects an entry with a bomb-like compression ratio', async () => {
    // A single ~4 MB run of one byte compresses to a few KB — ratio well past
    // the 200:1 cap — which is the classic decompression-bomb signature.
    const zip = new JSZip()
    zip.file('ppt/presentation.xml', '<x/>')
    zip.file('ppt/bomb.bin', 'A'.repeat(4 * 1024 * 1024))
    const buf = Buffer.from(await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }))
    await expect(parsePptx(buf)).rejects.toThrow(/compression ratio/i)
  })

  it('does NOT false-positive on a large but low-ratio entry (legit big media)', async () => {
    // ~3 MB of true random bytes (incompressible, like JPEG/MP4) — over the
    // 1 MB ratio-check threshold but ~1:1 ratio, so it must pass the guard.
    const noise = randomBytes(3 * 1024 * 1024)
    const zip = new JSZip()
    zip.file('ppt/presentation.xml', '<x/>')
    zip.file('ppt/media/image1.bin', noise)
    const buf = Buffer.from(await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }))
    // The ppt/ tree exists but there are no slides → parsePptx returns an empty
    // deck rather than throwing. The point is the bomb guard does NOT fire.
    await expect(parsePptx(buf)).resolves.toBeTruthy()
  })

  it('accepts a normal small deck (guard does not false-positive)', async () => {
    const buf = await makeFixture({ slideXml: `${SLIDE_OPEN}${SLIDE_CLOSE}` })
    // Should parse without throwing — well under every cap.
    const out = await parsePptx(buf)
    expect(out.slides.length).toBeGreaterThan(0)
  })
})
