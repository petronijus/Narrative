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
