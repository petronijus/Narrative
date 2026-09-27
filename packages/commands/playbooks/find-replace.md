---
name: find-replace
title: Find and replace text
description: Replace a word or phrase across one slide or the whole deck, keeping formatting.
arguments:
  - name: find
    description: The text to find.
    required: true
  - name: replace
    description: The replacement text.
    required: true
  - name: scope
    description: '"deck" (default) or a slide reference.'
    required: false
    default: deck
---

Replace "{{find}}" with "{{replace}}" (scope: {{scope}}).

`text.replace` (planned, not available yet) will do this in one call. Until
then:

1. Read the slides in scope with `query.slide` and list every text box and
   table cell whose text contains the phrase. Watch for case and for the
   phrase being split across formatting runs.
2. Replace each occurrence with `text.format`-safe edits: use `text.set`
   with the rich form built from the object's current runs, changing only
   the matched characters, so bold/colour/size around it survive.
   Table cells are addressed with `target.cell`.
3. Batch all edits into one `ops.apply` so the whole replacement is one
   step to revert.
4. Report how many occurrences you replaced on which slides, and any you
   skipped on purpose (e.g. a different meaning, a brand name).
