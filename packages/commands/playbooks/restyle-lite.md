---
name: restyle-lite
title: Restyle with the folder's tokens
description: Bring slides onto the folder's brand — its style pack's layouts when it has one, else its colours, text styles and fonts.
arguments:
  - name: scope
    description: '"deck" (default), a slide range, or "selection".'
    required: false
    default: deck
  - name: instruction
    description: Optional direction, e.g. "use the accent only for key numbers".
    required: false
---

Restyle {{scope}} onto the folder's brand. Direction: {{instruction}}.

First read the folder's style pack with `style.pack.get` (part "summary"; the
deck's `folderId` from `deck.get`).

**With a style pack** — re-lay the slides onto its layouts:

1. `style.pack.get` part "layouts": the layouts by purpose and slots.
2. Slides imported from a .pptx carry no layout: `deck.importPptx` and
   `deck.insertFrom` returned `placeholders` (the PowerPoint placeholder
   each object filled), the best hint for its role. For each slide in
   scope, choose the layout whose purpose fits the
   slide's point and content (or an `archetype`: cover, content, picture, …
   picks the pack's layout for that kind of slide). A slide not laid out
   yet: first give its objects a `role` with `object.update` (title,
   subtitle, body, picture, …; leave decoration without one), then
   `slide.applyLayout` in the same `ops.apply`. Text and pictures move into
   the layout's slots by role, top to bottom, left to right; give `content`
   for slots the move cannot fill. What the layout had no place for stays
   where it was and is listed as `unplaced`: delete it, or check it does not
   collide with the new layout.
3. A deck already on the pack's layouts is restyled in one step with
   `style.deck.apply` (a new variant, footer fields, the grid as guides): it
   re-lays every laid-out slide and keeps each slot's content. Slides on
   another pack's layouts (copied in from another brand's deck with
   `deck.insertFrom`) follow with `relayout: "archetype"`: each takes this
   pack's layout for the same kind of slide, its colours and styles by
   purpose. What it lists as `unmatched` has no such layout here: lay those
   out by hand (step 2).
4. `query.check` the restyled slides and fix its errors (shorten text, never
   shrink it), then look with `query.render` (a sheet for many).

**Without a style pack** — bring the slides onto the folder's tokens:

1. Read the folder's tokens with `token.list` (colours and text styles with
   their ids); `query.slide` shows which objects already use them
   (`{ "$token": … }` references), `token.usages` where one token is used.
   If the folder has no tokens, say so and ask before inventing a palette.
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
5. Do not move or resize objects in this branch unless the user asked.
6. Look at the restyled slides with `query.render` (a sheet for many): a
   larger style can make text overflow its box (`overflow`) — say so, or
   fix it with the wording, not by moving objects.

Report which roles or slides you mapped to which styles or layouts, and
anything that did not fit.
