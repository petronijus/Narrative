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

1. Decide whether every occurrence should change. Read the slides in scope
   with `query.slide` when the phrase could also mean something else (a
   brand name, a quotation) or appears inside longer words.
2. When all of them should change, call `text.replace` once — whole deck,
   or `slide` for one slide, `objects` for particular boxes. It covers text
   boxes and table cells and keeps the formatting of the text it replaces.
   Use `matchCase: false` for a case-insensitive match and `wholeWord: true`
   so "cat" does not hit "concatenate".
3. When only some should change, change those with `text.edit` at their
   offsets (from `query.object`; a paragraph break "\n\n" counts 2), several
   in one `ops.apply` so the whole replacement is one step to revert.
4. Report how many occurrences you replaced on which slides (`text.replace`
   returns them), and any you skipped on purpose.
