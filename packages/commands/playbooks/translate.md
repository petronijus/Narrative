---
name: translate
title: Translate slides
description: Translate the text of a slide range or the whole deck into another language, keeping layout and formatting.
arguments:
  - name: language
    description: Target language.
    required: true
  - name: scope
    description: '"deck" (default) or a list of slide references.'
    required: false
    default: deck
---

Translate into {{language}} (scope: {{scope}}).

1. Read every slide in scope with `query.slide`; collect text boxes, table
   cells and speaker notes.
2. Translate meaning, not words. Keep names, product names, numbers and
   units as they are; use the target language's typography (quotes,
   decimal separator, non-breaking space before units where customary).
   Match the register of the original (formal/informal).
3. Write back with `text.set` in the rich form, mapping formatted runs to
   the corresponding words in the translation so emphasis survives. Keep
   list structure (levels, bullets, numbering) unchanged.
4. Translations are often longer. After writing, look at each slide with
   `query.render` (a sheet for several): its `overflow` lists the boxes
   whose text no longer fits, measured with the real fonts. Shorten the
   wording before you consider shrinking type, and never go below the size
   the rest of the deck uses for the same role; look again until none is
   left.
5. One `ops.apply` per slide keeps each slide revertible on its own; say so
   in your report, together with anything you left untranslated and why.
