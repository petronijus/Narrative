"""Generate the e2e fonts with unusual metrics and a variable axis.

tall-font.ttf — family "Narrative Tall Test": a tall line box (hhea ascent
1400, descent 600, line gap 400 on a 1000 em, typo and win metrics different
again), so a layout that takes a fallback's metrics, or the wrong table,
puts lines visibly elsewhere.

var-font.ttf — family "Narrative Var Test": a variable font, one `wght` axis
100–900; the glyphs' stems AND advances change with the weight (gvar phantom
points), so a painter that ignores the variation draws words at other places
than the layout put them.

Every glyph is a few bars whose widths and heights depend on the character,
so words have distinct, measurable shapes (no fallback face looks like
them). Characters: A–Z, a–z, 0–9, space and a few punctuation marks.

Regenerate (only needed if the glyph set changes):
    uvx --from fonttools python apps/web/e2e/fixtures/make-metrics-fonts.py
"""

from pathlib import Path

from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.ttLib.tables.TupleVariation import TupleVariation

UPM = 1000
CHARS = [chr(c) for c in range(ord("A"), ord("Z") + 1)]
CHARS += [chr(c) for c in range(ord("a"), ord("z") + 1)]
CHARS += [chr(c) for c in range(ord("0"), ord("9") + 1)]
CHARS += list(".,;:-—'")
HERE = Path(__file__).parent


def name(c: str) -> str:
    return f"g{ord(c):04X}"


def advance(c: str) -> int:
    return 420 + (ord(c) * 37) % 380


def bars(c: str, stem: int) -> list[tuple[int, int, int, int]]:
    """The glyph's rectangles (x0, y0, x1, y1): two stems and a bar."""
    adv = advance(c)
    h = 380 + (ord(c) * 53) % 360
    if c in ".,;:-—'":
        return [(60, 0, 60 + stem, 120)]
    left = (60, 0, 60 + stem, h)
    right = (adv - 60 - stem, 0, adv - 60, h if c.isupper() else h * 2 // 3)
    mid_y = (ord(c) * 29) % (h - 80)
    bar = (60, mid_y, adv - 60, mid_y + 70)
    return [left, right, bar]


def glyph(rects: list[tuple[int, int, int, int]]) -> object:
    pen = TTGlyphPen(None)
    for x0, y0, x1, y1 in rects:
        pen.moveTo((x0, y0))
        pen.lineTo((x0, y1))
        pen.lineTo((x1, y1))
        pen.lineTo((x1, y0))
        pen.closePath()
    return pen.glyph()


def empty() -> object:
    return TTGlyphPen(None).glyph()


def base(family: str) -> FontBuilder:
    names = [".notdef", "space"] + [name(c) for c in CHARS]
    fb = FontBuilder(UPM, isTTF=True)
    fb.setupGlyphOrder(names)
    fb.setupCharacterMap({0x20: "space", **{ord(c): name(c) for c in CHARS}})
    fb.setupNameTable({"familyName": family, "styleName": "Regular"})
    fb.setupPost()
    return fb


def tall() -> None:
    fb = base("Narrative Tall Test")
    fb.setupGlyf({".notdef": empty(), "space": empty(), **{name(c): glyph(bars(c, 110)) for c in CHARS}})
    fb.setupHorizontalMetrics(
        {".notdef": (500, 0), "space": (360, 0), **{name(c): (advance(c), 60) for c in CHARS}}
    )
    fb.setupHorizontalHeader(ascent=1400, descent=-600, lineGap=400)
    fb.setupOS2(
        sTypoAscender=1100,
        sTypoDescender=-400,
        sTypoLineGap=300,
        usWinAscent=1500,
        usWinDescent=700,
    )
    fb.save(str(HERE / "tall-font.ttf"))


def variable() -> None:
    fb = base("Narrative Var Test")
    stem = 90  # default (wght 400)
    glyphs = {".notdef": empty(), "space": empty(), **{name(c): glyph(bars(c, stem)) for c in CHARS}}
    fb.setupGlyf(glyphs)
    fb.setupHorizontalMetrics(
        {".notdef": (500, 0), "space": (360, 0), **{name(c): (advance(c), 60) for c in CHARS}}
    )
    fb.setupHorizontalHeader(ascent=900, descent=-250, lineGap=0)
    fb.setupOS2(sTypoAscender=900, sTypoDescender=-250, usWinAscent=900, usWinDescent=250)
    fb.setupFvar(
        axes=[("wght", 100, 400, 900, "Weight")],
        instances=[
            {"stylename": "Thin", "location": {"wght": 100}},
            {"stylename": "Regular", "location": {"wght": 400}},
            {"stylename": "Black", "location": {"wght": 900}},
        ],
    )
    # gvar: at wght 900 every right-hand coordinate moves right (stems grow,
    # the advance grows by 160); at 100 they move left (advance −80).
    glyf = fb.font["glyf"]
    variations: dict[str, list[TupleVariation]] = {}
    for c in CHARS:
        g = glyf[name(c)]
        coords = g.getCoordinates(glyf)[0]
        n = len(coords)
        adv = advance(c)
        heavy = []
        light = []
        for x, _y in coords:
            # How far right of the left side bearing the point is, 0–1.
            t = (x - 60) / max(1, adv - 120)
            heavy.append((round(160 * t), 0))
            light.append((round(-80 * t), 0))
        # Phantom points: left side bearing, advance, top, bottom.
        heavy += [(0, 0), (160, 0), (0, 0), (0, 0)]
        light += [(0, 0), (-80, 0), (0, 0), (0, 0)]
        assert len(heavy) == n + 4
        variations[name(c)] = [
            TupleVariation({"wght": (0.0, 1.0, 1.0)}, heavy),
            TupleVariation({"wght": (-1.0, -1.0, 0.0)}, light),
        ]
    fb.setupGvar(variations)
    fb.save(str(HERE / "var-font.ttf"))


tall()
variable()
