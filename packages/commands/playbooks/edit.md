---
name: edit
title: Targeted edits
description: Make a specific change the user asked for — move, copy, restyle or rewrite particular objects or slides.
arguments:
  - name: request
    description: What the user wants changed, in their words.
    required: true
---

The user asked: {{request}}

1. **Pin down the targets.** Resolve every "this / that / the title / slide
   3" to ids: `editor.context` for the user's selection, `query.deck` and
   `query.slide` for everything else. If a reference is ambiguous (two
   titles, no selection), ask one short question instead of guessing.
2. **Plan the smallest change** that does what was asked. Do not tidy,
   restyle or "improve" anything the user did not mention.
3. **Apply it** in one `ops.apply` when it takes several commands. Useful
   mappings:
   - copy an object on the same slide → `object.duplicate`;
   - move → `object.move` (deltas), line up → `object.align` /
     `object.distribute`, to the slide's edge or centre →
     `object.alignToSlide`;
   - resize → `object.resize`, rotate → `object.rotate`, mirror →
     `object.flip`, crop or zoom a picture → `object.crop.set`;
   - change font, size, colour of a whole box → `object.update` (clear
     conflicting run formatting with `text.format` first);
   - change some words → `text.format` with a `match` range, or `text.set`
     with the rich form to keep the rest of the formatting;
   - copy a slide → `slide.duplicate`; reorder → `slide.move`;
   - put another deck's slides after slide N → `deck.insertFrom`.
4. **Check the result** (`query.slide`, and a screenshot once `query.render`
   (planned, not available yet) exists) and fix what does not match the
   request.
5. **Report** in one or two sentences what changed.
