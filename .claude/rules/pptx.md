---
paths:
  - 'apps/server/src/pptx/**'
---

# PowerPoint import / export (apps/server/src/pptx/README.md)

- `just test server` runs the round-trip matrix and the ECMA-376 schema check
  (needs `xmllint`).
- Also `just pptx-roundtrip <real deck>`: the target is 0 differences; the
  pre-existing ones are counted in AGENTS.md → When to run what. A change
  must not add one.
- Line spacing follows PowerPoint (hhea metrics from the font bytes), not the
  browser's `normal`.
