"""Generate block-font.ttf: the e2e font whose every letter is a solid block.

Text in it paints as filled rectangles, which no fallback face can imitate:
a spec that finds solid blocks where the text is knows the font was embedded
and used (render-export.spec.ts). Family "Narrative Block Test", one regular
face, A–Z, a–z, 0–9 and space.

Regenerate (only needed if the glyph set changes):
    uvx --from fonttools python apps/web/e2e/fixtures/make-block-font.py
"""

from pathlib import Path

from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen

FAMILY = "Narrative Block Test"
UPM = 1000
CHARS = [chr(c) for c in range(ord("A"), ord("Z") + 1)]
CHARS += [chr(c) for c in range(ord("a"), ord("z") + 1)]
CHARS += [chr(c) for c in range(ord("0"), ord("9") + 1)]


def block() -> object:
    pen = TTGlyphPen(None)
    pen.moveTo((40, 0))
    pen.lineTo((40, 700))
    pen.lineTo((960, 700))
    pen.lineTo((960, 0))
    pen.closePath()
    return pen.glyph()


def empty() -> object:
    return TTGlyphPen(None).glyph()


names = [".notdef", "space"] + [f"g{ord(c):04X}" for c in CHARS]
fb = FontBuilder(UPM, isTTF=True)
fb.setupGlyphOrder(names)
fb.setupCharacterMap({0x20: "space", **{ord(c): f"g{ord(c):04X}" for c in CHARS}})
fb.setupGlyf({".notdef": empty(), "space": empty(), **{f"g{ord(c):04X}": block() for c in CHARS}})
fb.setupHorizontalMetrics({n: (500 if n == "space" else 1000, 0) for n in names})
fb.setupHorizontalHeader(ascent=800, descent=-200)
fb.setupNameTable({"familyName": FAMILY, "styleName": "Regular"})
fb.setupOS2(sTypoAscender=800, sTypoDescender=-200, usWinAscent=800, usWinDescent=200)
fb.setupPost()
fb.save(str(Path(__file__).with_name("block-font.ttf")))
