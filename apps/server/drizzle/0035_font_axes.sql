-- Agentic A4.2c (docs/plans/a4-style-packs.md): a variable font's weight
-- and width axes, `{ "wght": [min, max], "wdth": [min, max] }`, so text
-- set at a width (Fabrikam Type Extended, wdth 130) can be drawn and checked
-- against the face that has it. NULL for a static font and for non-font
-- assets; fonts uploaded before this are re-read on their next upload.
ALTER TABLE "media_assets" ADD COLUMN IF NOT EXISTS "font_axes" jsonb;
