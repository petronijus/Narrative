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

1. Read the folder's tokens: colours and text styles are visible on the
   objects that already use them (`query.slide` shows `{ "$token": … }`
   references); `token.usages` finds where a token is used. If the folder
   has no tokens, say so and ask before inventing a palette.
2. Classify each text box by role (headline, subline, copy, caption,
   footnote, page number) from its size, position and content.
3. Map roles to the folder's text styles and colours:
   - text colours and fills → colour tokens, not literal hex;
   - one font family per role, consistent across slides;
   - the accent colour sparingly, on what carries the message.
4. Apply with `object.update` (and `text.format` `clear` for run-level
   overrides that fight the box style), one `ops.apply` per slide.
5. Do not move or resize objects in this playbook unless the user asked;
   layout changes need the layout-aware restyle that comes with style packs.
6. Report which roles you mapped to which styles, and anything that did not
   fit.
