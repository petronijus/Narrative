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
   - copy an object on the same slide → `object.duplicate`; to another
     slide → `object.copyTo`; from another deck → read it with
     `query.slide` there and send it to `object.insertFromDeck` here (it
     copies pictures and fonts too);
   - move → `object.move` (deltas), line up → `object.align` /
     `object.distribute`, to the slide's edge or centre →
     `object.alignToSlide`;
   - resize → `object.resize`, rotate → `object.rotate`, mirror →
     `object.flip`, crop or zoom a picture → `object.crop.set`;
   - draw a free-form shape → `object.path.create`; reshape a rectangle,
     ellipse, triangle or polygon point by point →
     `object.path.fromShape`, then `object.path.setAnchors`; move a line's
     or arrow's end → `object.line.setEndpoints` (all in slide px);
   - change font, size, colour of a whole box → `text.setBoxTypography`;
     give it a folder text style → `text.style.apply`; change the style
     itself for the whole folder (only when asked) → `token.update`;
   - restyle some words → `text.format` with a `match` range; change some
     words → `text.edit` at their offsets, or `text.replace` for every
     occurrence;
   - copy a slide → `slide.duplicate`; reorder → `slide.move`;
   - put another deck's slides after slide N → `deck.insertFrom`.
4. **Check the result**: look at the changed slide with `query.render` (and
   `query.slide` for exact values), and fix what does not match the request
   — a text box listed in its `overflow` included.
5. **Report** in one or two sentences what changed.
