---
name: shorten
title: Shorten or tighten text
description: Make the text of a slide or selection shorter and sharper without changing what it says.
arguments:
  - name: scope
    description: A slide reference, "selection" or "deck".
    required: true
  - name: target
    description: Optional target, e.g. "max 12 words per bullet" or "one line titles".
    required: false
---

Shorten the text in {{scope}}. Target: {{target}}.

1. Resolve the scope (`editor.context` for "selection", `query.slide` /
   `query.deck` otherwise) and read the texts with their formatting.
2. For each text: keep the one message it carries, cut filler and
   repetition, prefer concrete words and numbers, keep claims and sources
   intact. Headlines state the point ("Revenue grew 12 % in Q3"), not the
   topic ("Revenue").
3. Keep structure: the same number of bullets unless merging two says it
   better, the same list levels, the same emphasis on the key figure.
4. Write back with `text.set` (rich form), all edits of a slide in one
   `ops.apply`.
5. Report before/after for anything substantial you changed, so the user
   can judge the meaning survived.
