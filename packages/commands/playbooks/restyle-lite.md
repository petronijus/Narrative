---
name: restyle-lite
title: Restyle with the folder's tokens
description: Bring slides onto the folder's colours, text styles and fonts — the light version before full style packs exist.
arguments:
  - name: scope
    description: '"deck" (default), a slide range, or "selection".'
    required: false
    default: deck
  - name: instruction
    description: Optional direction, e.g. "use the accent only for key numbers".
    required: false
---

Restyle {{scope}} onto the folder's design tokens. Direction: {{instruction}}.

Full brand restyling with style packs — layouts, the pack's components and
`style.slides.restyle` (planned, not available yet) — comes later; this
playbook uses what exists today.

1. Read the folder's tokens with `token.list` (the deck's `folderId` from
   `deck.get`; colours and text styles with their ids); `query.slide` shows
   which objects already use them (`{ "$token": … }` references),
   `token.usages` where one token is used. If the folder has no tokens, say
   so and ask before inventing a palette.
2. Classify each text box by role (headline, subline, copy, caption,
   footnote, page number) from its size, position and content.
3. Map roles to the folder's text styles and colours:
   - text colours and fills → colour tokens, not literal hex;
   - one font family per role, consistent across slides;
   - the accent colour sparingly, on what carries the message.
4. Apply a role's folder text style with `text.style.apply` (by name), or
   set the box's font, size and colour with `text.setBoxTypography` (it
   removes run-level overrides that fight the box style); other properties
   with `object.update`. One `ops.apply` per slide.
5. Do not move or resize objects in this playbook unless the user asked;
   layout changes need the layout-aware restyle that comes with style packs.
6. Look at the restyled slides with `query.render` (a sheet for many): a
   larger style can make text overflow its box (`overflow`) — say so, or
   fix it with the wording, not by moving objects.
7. Report which roles you mapped to which styles, and anything that did not
   fit.
