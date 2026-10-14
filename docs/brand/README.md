# Narrative brand

| File                        | What it is                                       |
| --------------------------- | ------------------------------------------------ |
| `narrative-logo.jpeg`       | The logo: NARRATIVE in paper cards (1408 × 768). |
| `narrative-logo-short.jpeg` | The short logo: the N card (1024 × 1024).        |

Both are the originals Petr chose on 2026-09-30 (generated with Gemini).

## Derived files

The web app's icons are cut from the short logo — the card alone, without
its background and shadow (crop 808 × 808 at 110,110) — into
`apps/web/public/`:

- `favicon.ico` — 16, 32 and 48 px;
- `apple-touch-icon.png` — 180 px.

Regenerate them after changing the short logo:

```bash
magick docs/brand/narrative-logo-short.jpeg -crop 808x808+110+110 +repage -strip card.png
magick card.png -define icon:auto-resize=48,32,16 -strip apps/web/public/favicon.ico
magick card.png -resize 180x180 -strip apps/web/public/apple-touch-icon.png
```

The home page (`apps/web/src/pages/FoldersHome.tsx`) shows the logo as a
banner and the card as a mark in the header, from
`apps/web/src/assets/brand/`:

- `narrative-logo.webp` — the logo's middle band (1408 × 500 at 0,130),
  1200 px wide;
- `narrative-mark.webp` — the card, 96 px.

```bash
magick docs/brand/narrative-logo.jpeg -crop 1408x500+0+130 +repage -resize 1200x -strip -quality 82 apps/web/src/assets/brand/narrative-logo.webp
magick docs/brand/narrative-logo-short.jpeg -crop 808x808+110+110 +repage -resize 96x96 -strip -quality 85 apps/web/src/assets/brand/narrative-mark.webp
```

The README's screenshots (`docs/assets/`) are of a demo deck built through
the command API on the dev stack and deleted afterwards.
