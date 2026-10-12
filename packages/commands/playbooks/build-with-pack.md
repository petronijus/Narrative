---
name: build-with-pack
title: Build slides with the brand's style pack
description: Build or extend a deck with its folder's style pack — layouts chosen by purpose, slots filled, the pack's components, checked after every slide.
arguments:
  - name: brief
    description: What the slides should say — the story, the audience, the material to use.
    required: true
  - name: scope
    description: '"deck" (default: build the deck), or where to add slides, e.g. "after slide 4".'
    required: false
    default: deck
---

Build {{scope}} from this brief with the deck's style pack: {{brief}}

The folder's style pack is the brand: its layouts, text styles, colour
variants, furniture (footer, page number, logo) and editorial rules. You
place content into it; you do not design around it.

1. Read the pack: `style.pack.get` with part "summary" (variants, fonts,
   rules, the archetype map), then "layouts" (each layout's id, purpose and
   slots). If the deck's folder has no pack, say so and stop — use the
   `restyle-lite` playbook with the folder's tokens instead. Read the deck
   with `query.deck`.
2. Plan the slides before writing: one point per slide, each mapped to a
   layout by its **purpose** (the archetype map lists the pack's preferred
   layouts for a cover, an agenda, a divider, content, evidence…). Fit the
   content to the layout's slots, not the other way round: a layout with
   three items gets three, not five. Show the plan to the user when the deck
   is new.
3. Set the deck up once with `style.deck.apply`: the variant the user wants
   (else the pack's default), the footer's fields (client, department,
   date — ask for values you do not know; never leave a placeholder such as
   "Client" or "I/XX"), the language.
4. For each slide: `slide.add` where needed, then `slide.applyLayout` with
   the layout id and `content` by slot name — text as a string or
   `{ paragraphs }`, a picture as `{ assetId }` (from `media.upload`). Write
   in the pack's voice: its title mode (an action title states the finding;
   "label+message" puts a short label in the title and the message in the
   subtitle), its register, no closing period where the pack forbids it.
5. Components: where a slot is the pack's component (the headline, a label),
   `slide.applyLayout` stamps it. Never create a component for a one-off
   block, and never draw the footer, page number or logo yourself — the
   layout's furniture does.
6. After each slide, `query.check` for that slide (`slides: ["<id>"]`): fix
   every error — shorten text that does not fit (do not shrink fonts or move
   boxes), replace placeholders, remove colours the pack does not allow —
   then `query.render` to look at it. Warnings are worth fixing when it is
   cheap.
7. At the end, `query.check` on the whole deck and one `query.render` sheet.
   Report the slides you made (layout per slide), the check result, and what
   the user still has to supply (pictures, numbers, footer fields).

Do not:

- set fonts, sizes or colours by hand on pack layouts (`text.setBoxTypography`,
  literal hex) — the layout links its boxes to the pack's text styles;
- move or resize layout objects to make text fit — rewrite the text, or pick
  a layout with more room;
- mix variants in one deck, or use the accent beyond the pack's budget.
