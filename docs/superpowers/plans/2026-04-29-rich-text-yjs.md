# Rich Text via Y.Text + Pixi HTMLText Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace box-wide text style fields (italic / underline / fontWeight / color) with Y.Text-backed inline formatting so users can italicize / bold / underline / colour individual words inside a text box. Render via Pixi v8 `HTMLText` and edit via a `contenteditable` div bound to the same Y.Text.

**Architecture:** TextObject keeps its layout fields (x, y, width, height, vAlign, align, lineHeight, fontSize, fontFamily) as box-wide defaults. The `text` field becomes a `Y.Text` (CRDT-friendly rich text) instead of a plain string; format runs live as Quill-style attributes (`{ italic: true }` etc.) on the Y.Text. The Pixi renderer converts Y.Text to an HTML string on each rebuild and feeds it to `HTMLText`. The DOM edit overlay is a `contenteditable` div whose selection drives the Inspector's italic/underline/fontWeight/color toggles — if a range is selected, the toggle calls `Y.Text.format(start, length, attrs)`; if no range, it updates the box-wide default. Backwards compat: existing `text: string` Y.Map values are migrated to `Y.Text` lazily on first edit / first reconciler pass.

**Tech Stack:** Yjs (Y.Text + Y.Map), Pixi.js v8 HTMLText, React (contenteditable wrapped via ref + ContentEditable patterns), Playwright e2e.

---

## File Structure

### New files

- `packages/slide-model/src/richText.ts` — pure helpers around Y.Text. `createTextValue(initial)`, `getPlainString(yt)`, `applyFormat(yt, start, length, attrs)`, `clearFormat(yt, start, length, keys)`, `toDelta(yt)`, `toHtml(delta, defaults)`. No DOM, no Pixi dependency.
- `packages/slide-model/src/richText.test.ts` — vitest unit specs.
- `apps/web/src/state/textEditSelection.ts` — runtime API exposed via React context: `getActiveSelection() → { yTextOwner: TextObjectId; start: number; length: number } | null`. Inspector reads this; TextEditOverlay writes it on selection change.
- `apps/web/src/state/textEditSelection.test.ts` — unit spec for the context plumbing (no real DOM).
- `apps/web/e2e/rich-text-formatting.spec.ts` — partial-range italic/underline/weight/colour, plus regression for "selection survives inspector click".
- `apps/web/e2e/rich-text-migration.spec.ts` — opens a deck whose text was saved as plain `string` and verifies it is read + edited correctly without data loss.

### Modified files

- `packages/shared/src/slide.ts` — `TextObject.text` widens to `string | Y.Text`. The box-wide `italic`, `underline`, `fontWeight`, `color`, `colorAlpha` stay (now meaning "default attribute when a run has no override"). Add `JSDoc` documenting the new semantics.
- `packages/slide-model/src/bindings.ts` — `plainObjectToYMap` must NOT clone Y.Text values (preserve identity). `yMapToPlainObject` must return the Y.Text as-is (not stringified) for the renderer to consume.
- `packages/slide-model/src/mutations.ts` — `addObject` for text seeds a fresh `Y.Text` with the supplied string. `updateObject` recognises `text: string` patches by REPLACING the string contents of the existing Y.Text in-place (delete-all + insert).
- `packages/slide-model/src/index.ts` — re-export new richText helpers.
- `apps/web/src/renderer/types.ts` — extend the renderer-side TextObject type to use the new union.
- `apps/web/src/renderer/objectRenderers/textRenderer.ts` — switch `Pixi.Text` to `Pixi.HTMLText`. `buildHtml(data)` reads Y.Text → delta → HTML, wraps it in a `<div>` with the box-wide CSS defaults (font-family, font-size, color). Drop the custom underline Graphics — `<u>` handles it natively. Keep the clip mask + applyVerticalAlign + applyHorizontalAlign math; only the rendering child changes.
- `apps/web/src/renderer/SceneGraph.ts` — refresh-fonts hook keeps working with HTMLText (no per-node listener change expected; verify in spec).
- `apps/web/src/ui/TextEditOverlay.tsx` — replace `<textarea>` with a `contenteditable` div bound to the same Y.Text. Mirror Pixi's measured `textNode.y` onto the div's `padding-top` (existing logic stays). Track selection range and write to the textEditSelection store.
- `apps/web/src/ui/Inspector.tsx` — italic/underline/fontWeight/color/colorAlpha buttons read from textEditSelection. If a range is active, call `applyFormat` on the Y.Text. Otherwise patch the TextObject's box-wide defaults (current behaviour).
- `apps/web/src/state/testApi.ts` — add `applyTextFormat(objectId, start, length, attrs, slideId?)` so e2e specs can drive partial-range formatting deterministically.

### Deleted files

- None — the underline Graphics machinery in textRenderer.ts is removed inline (no separate file).

---

## Phase A — Foundation: Y.Text in the schema with no UI changes

Goal at end of Phase A: Y.Text replaces `string` for the text body in the data model. The renderer still draws plain Pixi.Text using `Y.Text.toString()`. The editor still uses a textarea. All 22 existing P15 e2e specs must pass unchanged. Visible behaviour is identical.

### Task A1: Widen the TextObject.text schema

**Files:**

- Modify: `packages/shared/src/slide.ts:284-304`

- [ ] **Step 1: Update the type and add doc**

```ts
import type * as Y from 'yjs'

export interface TextObject extends BaseSlideObject {
  type: 'text'
  /**
   * The body content. New objects use a Y.Text for collaborative
   * inline formatting (italic / underline / fontWeight / color
   * attributes). Old objects loaded from disk may still be a plain
   * string until lazily migrated by mutations.ensureRichText().
   */
  text: string | Y.Text
  fontSize: number
  fontWeight: FontWeight
  /** Default color for runs with no explicit color attribute. */
  color: number
  colorAlpha?: number
  align: 'left' | 'center' | 'right'
  fontFamily?: string
  vAlign?: TextVerticalAlign
  lineHeight?: number
  letterSpacing?: number
  /** Default italic for runs with no explicit italic attribute. */
  italic?: boolean
  /** Default underline for runs with no explicit underline attribute. */
  underline?: boolean
  listStyle?: TextListStyle
  // … existing fields (stroke, strokeWidth, shadow, blur, …) stay as-is.
}
```

- [ ] **Step 2: Verify type compiles**

Run: `pnpm --filter @narrative/shared typecheck`
Expected: passes.

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/slide.ts
git commit -m "feat(richtext): TextObject.text widens to string | Y.Text"
```

### Task A2: richText helpers (Y.Text ↔ delta ↔ HTML)

**Files:**

- Create: `packages/slide-model/src/richText.ts`
- Create: `packages/slide-model/src/richText.test.ts`

- [ ] **Step 1: Write failing test for createTextValue + getPlainString**

```ts
// packages/slide-model/src/richText.test.ts
import * as Y from 'yjs'
import { describe, it, expect } from 'vitest'
import { createTextValue, getPlainString, applyFormat, toDelta, toHtml } from './richText.js'

describe('richText helpers', () => {
  it('createTextValue seeds a Y.Text with the initial string', () => {
    const doc = new Y.Doc()
    const map = doc.getMap('m')
    const yt = createTextValue('hello')
    map.set('text', yt)
    expect(getPlainString(yt)).toBe('hello')
  })

  it('applyFormat marks a substring with attributes', () => {
    const doc = new Y.Doc()
    const map = doc.getMap('m')
    const yt = createTextValue('hello world')
    map.set('text', yt)
    applyFormat(yt, 6, 5, { italic: true })
    const delta = toDelta(yt)
    expect(delta).toEqual([{ insert: 'hello ' }, { insert: 'world', attributes: { italic: true } }])
  })

  it('toHtml emits <i>, <b>, <u>, <span style="color"> wrappers', () => {
    const doc = new Y.Doc()
    const map = doc.getMap('m')
    const yt = createTextValue('hi there')
    map.set('text', yt)
    applyFormat(yt, 0, 2, { italic: true, underline: true })
    applyFormat(yt, 3, 5, { fontWeight: 700, color: 0xff0000 })
    const html = toHtml(toDelta(yt), {})
    expect(html).toContain('<u><i>hi</i></u>')
    expect(html).toContain('<span style="font-weight:700;color:#ff0000">there</span>')
  })

  it('toHtml escapes HTML special characters in the body', () => {
    const doc = new Y.Doc()
    const map = doc.getMap('m')
    const yt = createTextValue('a < b & c > d')
    map.set('text', yt)
    const html = toHtml(toDelta(yt), {})
    expect(html).toBe('a &lt; b &amp; c &gt; d')
  })

  it('toHtml turns \\n into <br>', () => {
    const doc = new Y.Doc()
    const map = doc.getMap('m')
    const yt = createTextValue('line one\nline two')
    map.set('text', yt)
    const html = toHtml(toDelta(yt), {})
    expect(html).toBe('line one<br>line two')
  })
})
```

- [ ] **Step 2: Run, verify it fails**

Run: `pnpm --filter @narrative/slide-model test -- richText.test.ts`
Expected: FAIL — module './richText.js' not found.

- [ ] **Step 3: Implement helpers**

```ts
// packages/slide-model/src/richText.ts
import * as Y from 'yjs'

export interface RichAttrs {
  italic?: boolean
  underline?: boolean
  fontWeight?: number
  color?: number
}

export interface RichDeltaOp {
  insert: string
  attributes?: RichAttrs
}

export function createTextValue(initial: string): Y.Text {
  const yt = new Y.Text()
  if (initial.length > 0) yt.insert(0, initial)
  return yt
}

export function getPlainString(yt: Y.Text): string {
  return yt.toString()
}

export function applyFormat(yt: Y.Text, start: number, length: number, attrs: RichAttrs): void {
  if (length <= 0) return
  yt.format(start, length, attrs as Record<string, unknown>)
}

export function clearFormat(
  yt: Y.Text,
  start: number,
  length: number,
  keys: ReadonlyArray<keyof RichAttrs>,
): void {
  if (length <= 0) return
  const erase: Record<string, null> = {}
  for (const k of keys) erase[k] = null
  yt.format(start, length, erase as Record<string, unknown>)
}

export function toDelta(yt: Y.Text): RichDeltaOp[] {
  const raw = yt.toDelta() as Array<{ insert: unknown; attributes?: Record<string, unknown> }>
  const out: RichDeltaOp[] = []
  for (const op of raw) {
    if (typeof op.insert !== 'string') continue
    const e: RichDeltaOp = { insert: op.insert }
    if (op.attributes !== undefined) {
      const a: RichAttrs = {}
      if (op.attributes['italic'] === true) a.italic = true
      if (op.attributes['underline'] === true) a.underline = true
      if (typeof op.attributes['fontWeight'] === 'number')
        a.fontWeight = op.attributes['fontWeight']
      if (typeof op.attributes['color'] === 'number') a.color = op.attributes['color']
      if (Object.keys(a).length > 0) e.attributes = a
    }
    out.push(e)
  }
  return out
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function colorHex(n: number): string {
  return '#' + n.toString(16).padStart(6, '0')
}

export interface HtmlDefaults {
  fontWeight?: number
  italic?: boolean
  underline?: boolean
  color?: number
}

export function toHtml(delta: RichDeltaOp[], defaults: HtmlDefaults): string {
  const parts: string[] = []
  for (const op of delta) {
    const a = op.attributes ?? {}
    const italic = a.italic ?? defaults.italic ?? false
    const underline = a.underline ?? defaults.underline ?? false
    const weight = a.fontWeight ?? defaults.fontWeight
    const color = a.color ?? defaults.color
    const styleBits: string[] = []
    if (typeof weight === 'number' && weight !== 400) styleBits.push(`font-weight:${weight}`)
    if (typeof color === 'number') styleBits.push(`color:${colorHex(color)}`)
    let body = escapeHtml(op.insert).replace(/\n/g, '<br>')
    if (italic) body = `<i>${body}</i>`
    if (underline) body = `<u>${body}</u>`
    if (styleBits.length > 0) body = `<span style="${styleBits.join(';')}">${body}</span>`
    parts.push(body)
  }
  return parts.join('')
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `pnpm --filter @narrative/slide-model test -- richText.test.ts`
Expected: 5 passing.

- [ ] **Step 5: Re-export from package index**

Modify `packages/slide-model/src/index.ts` — append:

```ts
export {
  createTextValue,
  getPlainString,
  applyFormat,
  clearFormat,
  toDelta,
  toHtml,
} from './richText.js'
export type { RichAttrs, RichDeltaOp, HtmlDefaults } from './richText.js'
```

- [ ] **Step 6: Typecheck the workspace**

Run: `pnpm -r typecheck`
Expected: passes.

- [ ] **Step 7: Commit**

```bash
git add packages/slide-model/src/richText.ts packages/slide-model/src/richText.test.ts packages/slide-model/src/index.ts
git commit -m "feat(richtext): Y.Text ↔ delta ↔ HTML helpers"
```

### Task A3: bindings preserve Y.Text identity

**Files:**

- Modify: `packages/slide-model/src/bindings.ts`
- Modify: `packages/slide-model/src/bindings.test.ts`

- [ ] **Step 1: Add a failing test**

Append to `bindings.test.ts`:

```ts
it('plainObjectToYMap stores a Y.Text reference under "text" without flattening it', () => {
  const doc = new Y.Doc()
  const yt = new Y.Text()
  yt.insert(0, 'hello')
  const obj = {
    id: 't1',
    type: 'text',
    x: 0,
    y: 0,
    width: 200,
    height: 100,
    rotation: 0,
    opacity: 1,
    fontSize: 24,
    fontWeight: 400,
    color: 0,
    align: 'left',
    text: yt,
  } as unknown as TextObject
  const yMap = plainObjectToYMapInDoc(doc, obj)
  expect(yMap.get('text')).toBe(yt)
})
```

- [ ] **Step 2: Run, verify it fails**

Run: `pnpm --filter @narrative/slide-model test -- bindings.test.ts`
Expected: FAIL — current `plainObjectToYMap` does `yMap.set(key, value)` which works for Y.Text references too — actually verify; if it already passes, the test still pins the contract. If it FAILS because of a clone, fix Step 3.

- [ ] **Step 3: If failing, ensure no spread/clone of Y.Text values**

Audit `plainObjectToYMap` for any `.toJSON()` / spread of nested objects. If found, special-case `value instanceof Y.AbstractType`.

- [ ] **Step 4: Verify pass**

Run: `pnpm --filter @narrative/slide-model test -- bindings.test.ts`
Expected: passes.

- [ ] **Step 5: Commit**

```bash
git add packages/slide-model/src/bindings.ts packages/slide-model/src/bindings.test.ts
git commit -m "test(richtext): pin Y.Text identity preservation in bindings"
```

### Task A4: addObject for text seeds Y.Text; updateObject migrates string → Y.Text

**Files:**

- Modify: `packages/slide-model/src/mutations.ts:40-90`
- Create: `packages/slide-model/src/mutations.richtext.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// packages/slide-model/src/mutations.richtext.test.ts
import * as Y from 'yjs'
import { describe, it, expect } from 'vitest'
import { addObject, updateObject, getSlideObjectsCtx, addSlide } from './index.js'
import { initDeck } from './slides.js'

describe('text mutations and Y.Text', () => {
  it('addObject creates Y.Text for a text object', () => {
    const doc = new Y.Doc()
    const deckCtx = initDeck(doc)
    const slide = addSlide(deckCtx)
    const ctx = getSlideObjectsCtx(deckCtx, slide.id)!
    addObject(ctx, {
      id: 'a',
      type: 'text',
      x: 0,
      y: 0,
      width: 100,
      height: 40,
      rotation: 0,
      opacity: 1,
      fontSize: 24,
      fontWeight: 400,
      color: 0,
      align: 'left',
      text: 'hello',
    } as never)
    const yMap = ctx.objects.get(0)
    expect(yMap.get('text')).toBeInstanceOf(Y.Text)
    expect((yMap.get('text') as Y.Text).toString()).toBe('hello')
  })

  it('updateObject text patch with a string mutates the existing Y.Text in place (no replacement)', () => {
    const doc = new Y.Doc()
    const deckCtx = initDeck(doc)
    const slide = addSlide(deckCtx)
    const ctx = getSlideObjectsCtx(deckCtx, slide.id)!
    addObject(ctx, {
      id: 'a',
      type: 'text',
      x: 0,
      y: 0,
      width: 100,
      height: 40,
      rotation: 0,
      opacity: 1,
      fontSize: 24,
      fontWeight: 400,
      color: 0,
      align: 'left',
      text: 'hello',
    } as never)
    const ytBefore = ctx.objects.get(0).get('text') as Y.Text
    updateObject(ctx, 'a', { text: 'world' } as never)
    const ytAfter = ctx.objects.get(0).get('text') as Y.Text
    expect(ytAfter).toBe(ytBefore) // identity preserved
    expect(ytAfter.toString()).toBe('world')
  })

  it('updateObject promotes a legacy string text field to Y.Text on first patch', () => {
    const doc = new Y.Doc()
    const deckCtx = initDeck(doc)
    const slide = addSlide(deckCtx)
    const ctx = getSlideObjectsCtx(deckCtx, slide.id)!
    // Simulate a legacy object that landed via plain object creation.
    const yMap = new Y.Map<unknown>()
    doc.transact(() => {
      ctx.objects.push([yMap])
      yMap.set('id', 'legacy')
      yMap.set('type', 'text')
      yMap.set('text', 'old string') // legacy plain string
      yMap.set('x', 0)
      yMap.set('y', 0)
      yMap.set('width', 100)
      yMap.set('height', 40)
      yMap.set('rotation', 0)
      yMap.set('opacity', 1)
      yMap.set('fontSize', 24)
      yMap.set('fontWeight', 400)
      yMap.set('color', 0)
      yMap.set('align', 'left')
    })
    updateObject(ctx, 'legacy', { text: 'new value' } as never)
    expect(yMap.get('text')).toBeInstanceOf(Y.Text)
    expect((yMap.get('text') as Y.Text).toString()).toBe('new value')
  })
})
```

- [ ] **Step 2: Run, verify failures**

Run: `pnpm --filter @narrative/slide-model test -- mutations.richtext`
Expected: 3 FAIL.

- [ ] **Step 3: Update addObject in mutations.ts**

Find the existing `addObject` body. Before calling `plainObjectToYMap`, transform a text object whose `text` is a string into one whose `text` is a freshly-built Y.Text:

```ts
import { createTextValue } from './richText.js'

// inside addObject, just before plainObjectToYMap:
let prepared = obj
if (obj.type === 'text' && typeof (obj as { text: unknown }).text === 'string') {
  prepared = { ...obj, text: createTextValue((obj as { text: string }).text) } as typeof obj
}
const yMap = plainObjectToYMap(prepared)
```

- [ ] **Step 4: Update updateObject in mutations.ts**

Special-case `patch.text` for text objects:

```ts
// inside updateObject, in the entries loop, before yMap.set:
if (key === 'text' && typeof value === 'string') {
  const existing = yMap.get('text')
  if (existing instanceof Y.Text) {
    existing.delete(0, existing.length)
    if (value.length > 0) existing.insert(0, value)
    continue // do NOT yMap.set — preserve the Y.Text identity
  }
  // legacy: text was a plain string → migrate to Y.Text
  yMap.set('text', createTextValue(value))
  continue
}
```

(Remember `import * as Y from 'yjs'` and `import { createTextValue } from './richText.js'` at the top.)

- [ ] **Step 5: Run tests**

Run: `pnpm --filter @narrative/slide-model test -- mutations.richtext`
Expected: 3 PASS.

- [ ] **Step 6: Run full slide-model suite to ensure no regression**

Run: `pnpm --filter @narrative/slide-model test`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add packages/slide-model/src/mutations.ts packages/slide-model/src/mutations.richtext.test.ts
git commit -m "feat(richtext): addObject seeds Y.Text; updateObject migrates legacy strings"
```

### Task A5: textRenderer reads Y.Text via toString() (no rendering change yet)

**Files:**

- Modify: `apps/web/src/renderer/objectRenderers/textRenderer.ts`

- [ ] **Step 1: Add a helper that returns a plain string from data.text**

At the top of the file, add:

```ts
import * as Y from 'yjs'

function readPlainText(data: TextObject): string {
  const t = data.text as unknown
  if (t instanceof Y.Text) return t.toString()
  if (typeof t === 'string') return t
  return ''
}
```

- [ ] **Step 2: Replace every `data.text` and `next.text` and `merged.text` USE that builds Pixi.Text content with `readPlainText(...)`**

Search the file for `.text`. Each call site that feeds Pixi (`new Text({ text: ... })`, `textNode.text = ...`, `applyListMarkers(merged.text, ...)`, the synthetic-fallback `text: textNode.text` etc.) must use the helper. The DATA_TAG snapshot and patches keep the Y.Text reference (so identity is preserved).

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter web typecheck`
Expected: passes.

- [ ] **Step 4: Run all 22 P15 e2e specs**

Run: `pnpm --filter web exec playwright test e2e/text-edit-position.spec.ts e2e/text-edit-wrap.spec.ts e2e/text-edit-underline.spec.ts e2e/text-edit-screenshots.spec.ts --reporter=list`
Expected: 22 PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/renderer/objectRenderers/textRenderer.ts
git commit -m "refactor(richtext): textRenderer reads data.text via plain-string helper"
```

### Task A6: TextEditOverlay reads Y.Text and writes through updateObject

**Files:**

- Modify: `apps/web/src/ui/TextEditOverlay.tsx`

- [ ] **Step 1: Replace `defaultValue={obj.text}` with the plain-string helper**

```ts
import * as Y from 'yjs'

function readPlainText(t: unknown): string {
  if (t instanceof Y.Text) return t.toString()
  if (typeof t === 'string') return t
  return ''
}
```

Usage: `defaultValue={readPlainText(obj.text)}`. The textarea still writes a string back via `commit(value)`; the existing `updateObject(...,{ text: value })` path is now Y.Text-aware (Task A4).

- [ ] **Step 2: Replace the `if (value === obj.text) return` short-circuit**

Use the plain-string helper here too: `if (value === readPlainText(obj.text)) return`.

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter web typecheck`
Expected: passes.

- [ ] **Step 4: Run e2e edit-overlay specs**

Run: `pnpm --filter web exec playwright test e2e/text-edit-position.spec.ts --reporter=list`
Expected: 11 PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/ui/TextEditOverlay.tsx
git commit -m "refactor(richtext): TextEditOverlay reads Y.Text via helper"
```

### Task A7: Phase A acceptance — full P15 spec sweep

- [ ] **Step 1: Run every P15 spec**

Run: `pnpm --filter web exec playwright test e2e/text-edit-position.spec.ts e2e/text-edit-wrap.spec.ts e2e/text-edit-underline.spec.ts e2e/text-edit-screenshots.spec.ts e2e/font-multiplayer.spec.ts e2e/font-upload.spec.ts e2e/fit-to-screen.spec.ts --reporter=list`
Expected: all PASS (22 + font + fit specs).

- [ ] **Step 2: Manually open a previously-saved deck and confirm text loads**

Use deck `GoYLg0H4-wSp`. Verify text renders, edits, saves, reloads. (Smoke-test in dev server.)

- [ ] **Step 3: Tag the commit so we can roll back to "schema migrated, behaviour unchanged"**

```bash
git tag richtext-phase-a-complete
git push --tags
```

---

## Phase B — Renderer: Pixi.HTMLText with run-aware HTML

Goal at end of Phase B: text is rendered through `Pixi.HTMLText` with one `<i>` / `<u>` / `<b>` / `<span>` per Y.Text run. Box-wide italic / underline / fontWeight / color still work as DEFAULT attributes for runs without overrides. The custom underline Graphics is gone. All 22 P15 specs still pass (the `applyUnderline` Graphics test no longer applies; replace with HTMLText-equivalent assertions).

### Task B1: Probe HTMLText behaviour for vAlign + measurement

**Files:**

- Create: `apps/web/e2e/probe-html-text.spec.ts` (probe-only, will be deleted at end of phase)

- [ ] **Step 1: Write a probe spec**

```ts
// apps/web/e2e/probe-html-text.spec.ts
import { test, expect } from '@playwright/test'

test('HTMLText reports height and bounds the same way as Text', async ({ page }) => {
  await page.goto('http://localhost:5173/__test__/html-text-probe')
  // … in a tiny dev-only route we mount an HTMLText('Hello\nWorld', { fontSize: 48, lineHeight: 1.2*48 }) and expose its height + getBounds via window.__probe.
  const probe = await page.evaluate(
    () =>
      (
        window as unknown as {
          __probe?: { height: number; bounds: { width: number; height: number } }
        }
      ).__probe,
  )
  expect(probe?.height).toBeGreaterThan(0)
})
```

(The probe route is a few lines in `apps/web/src/main.tsx` behind `import.meta.env.DEV` and removed at the end of Phase B.)

- [ ] **Step 2: Run, capture the metrics empirically**

Run: `pnpm --filter web exec playwright test e2e/probe-html-text.spec.ts --reporter=list`
Note: this is exploratory; record what HTMLText reports vs Pixi.Text for the same content.

- [ ] **Step 3: Commit the probe (we'll delete it after Phase B)**

```bash
git add apps/web/e2e/probe-html-text.spec.ts apps/web/src/main.tsx
git commit -m "wip(richtext): HTMLText measurement probe"
```

### Task B2: Replace Pixi.Text with Pixi.HTMLText in mount/update/applyPatch

**Files:**

- Modify: `apps/web/src/renderer/objectRenderers/textRenderer.ts`

- [ ] **Step 1: Add a buildHtml(data) helper**

```ts
import { HTMLText } from 'pixi.js'
import * as Y from 'yjs'
import { toDelta, toHtml, type HtmlDefaults } from '@narrative/slide-model'

function buildHtml(data: TextObject): string {
  const yt = data.text as unknown
  if (!(yt instanceof Y.Text)) {
    return typeof yt === 'string' ? yt : ''
  }
  const defaults: HtmlDefaults = {
    fontWeight: typeof data.fontWeight === 'number' ? data.fontWeight : undefined,
    italic: data.italic === true ? true : undefined,
    underline: data.underline === true ? true : undefined,
    color: data.color,
  }
  return toHtml(toDelta(yt), defaults)
}
```

- [ ] **Step 2: Swap `new Text(...)` for `new HTMLText(...)` in mount()**

```ts
const textNode = new HTMLText({
  text: buildHtml(data),
  style: buildStyle(data),
})
```

`buildStyle` keeps fontFamily / fontSize / lineHeight / wordWrap / wordWrapWidth / breakWords / padding. Drop `fontWeight`, `fontStyle`, `fill` from buildStyle (they become DEFAULTS in the HTML, applied by the `toHtml` wrapper).

- [ ] **Step 3: Update update() and applyPatch() to write `textNode.text = buildHtml(merged)`**

Anywhere the previous code did `textNode.text = applyListMarkers(merged.text, merged.listStyle)`, replace with the HTML build. List markers can be applied inside `buildHtml` too (prepend bullet/number to each delta op's first character of each line).

- [ ] **Step 4: Remove the custom underline Graphics path**

Delete `applyUnderline`, `getUnderline`, the `UNDERLINE_TAG`, the cleanup in `destroy`, and every call site. Underline is now `<u>` inside HTMLText.

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter web typecheck`
Expected: passes.

- [ ] **Step 6: Run all P15 specs**

Run: `pnpm --filter web exec playwright test e2e/text-edit-position.spec.ts e2e/text-edit-wrap.spec.ts e2e/text-edit-screenshots.spec.ts --reporter=list`
Expected: 21 PASS. The `text-edit-underline.spec.ts` will need updating — see B3.

- [ ] **Step 7: Commit (without underline spec yet)**

```bash
git add apps/web/src/renderer/objectRenderers/textRenderer.ts
git commit -m "feat(richtext): renderer switches to Pixi HTMLText with run-aware HTML"
```

### Task B3: Update text-edit-underline spec to assert HTMLText output

**Files:**

- Modify: `apps/web/e2e/text-edit-underline.spec.ts`

- [ ] **Step 1: Replace Graphics-existence checks with HTMLText content checks**

The spec already only screenshots, but add a content assertion:

```ts
const html = await page.evaluate((id: string) => {
  const sg = (
    window as unknown as {
      __narrative_scene_graph?: {
        getContainer: (id: string) => { children: Array<{ text?: string }> } | undefined
      }
    }
  ).__narrative_scene_graph
  const c = sg?.getContainer(id)
  const tn = c?.children.find((ch) => typeof ch.text === 'string')
  return tn?.text ?? ''
}, target.id)
expect(html.toLowerCase()).toContain('<u>')
```

- [ ] **Step 2: Run all underline specs**

Run: `pnpm --filter web exec playwright test e2e/text-edit-underline.spec.ts --reporter=list`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/web/e2e/text-edit-underline.spec.ts
git commit -m "test(richtext): underline spec asserts HTMLText <u> markup"
```

### Task B4: Run-formatted rendering smoke test

**Files:**

- Create: `apps/web/e2e/rich-text-render.spec.ts`

- [ ] **Step 1: Write spec — apply per-range italic via testApi, screenshot**

```ts
import { test, expect } from '@playwright/test'

test('per-range italic renders only the formatted run', async ({ page }) => {
  test.setTimeout(45_000)
  await page.setViewportSize({ width: 1920, height: 1080 })
  await page.goto('http://localhost:5173/deck/GoYLg0H4-wSp')
  await page.waitForFunction(() => window.__narrative_test_api !== undefined, null, {
    timeout: 15_000,
  })
  await page.waitForTimeout(1500)

  const target = await page.evaluate(() => {
    const api = window.__narrative_test_api!
    for (const sid of api.listSlideIds()) {
      const t = api.debugObjectTypes(sid).find((o) => o.type === 'text')
      if (t !== undefined) return { id: t.id, slideId: sid }
    }
    return null
  })
  if (target === null) throw new Error('no text obj')

  await page.evaluate(
    ({ id, slideId }) => {
      const api = window.__narrative_test_api!
      api.updateObject(
        id,
        {
          text: 'hello world',
          fontSize: 64,
          width: 800,
          height: 200,
          italic: undefined,
          underline: undefined,
        },
        slideId,
      )
      api.applyTextFormat(id, 6, 5, { italic: true }, slideId)
    },
    { id: target.id, slideId: target.slideId },
  )
  await page.waitForTimeout(400)

  const html = await page.evaluate((id: string) => {
    const sg = (
      window as unknown as {
        __narrative_scene_graph?: {
          getContainer: (id: string) => { children: Array<{ text?: string }> } | undefined
        }
      }
    ).__narrative_scene_graph
    const c = sg?.getContainer(id)
    const tn = c?.children.find((ch) => typeof ch.text === 'string')
    return tn?.text ?? ''
  }, target.id)
  expect(html.toLowerCase()).toContain('<i>world</i>')
  expect(html.toLowerCase()).not.toContain('<i>hello</i>')
})
```

(`applyTextFormat` lands in Task B5.)

- [ ] **Step 2: Mark the spec skipped initially (pending applyTextFormat)**

Use `test.skip(...)` for now; un-skip in Task B5.

- [ ] **Step 3: Commit**

```bash
git add apps/web/e2e/rich-text-render.spec.ts
git commit -m "test(richtext): smoke spec for per-range italic rendering (skipped pending testApi)"
```

### Task B5: testApi.applyTextFormat

**Files:**

- Modify: `apps/web/src/state/testApi.ts`

- [ ] **Step 1: Add to TestApi interface**

```ts
applyTextFormat(
  objectId: string,
  start: number,
  length: number,
  attrs: { italic?: boolean; underline?: boolean; fontWeight?: number; color?: number },
  slideId?: string,
): void
```

- [ ] **Step 2: Implement using Y.Text.format**

```ts
applyTextFormat(objectId, start, length, attrs, slideId) {
  const targetSlideId = slideId ?? listSlides(deckCtx)[0]?.id
  if (!targetSlideId) return
  const ctx = getSlideObjectsCtx(deckCtx, targetSlideId)
  if (!ctx) return
  for (let i = 0; i < ctx.objects.length; i++) {
    const m = ctx.objects.get(i)
    if (m.get('id') !== objectId) continue
    const yt = m.get('text')
    if (yt instanceof Y.Text) {
      yt.format(start, length, attrs as Record<string, unknown>)
    }
    return
  }
},
```

- [ ] **Step 3: Un-skip rich-text-render spec, run it**

Remove `test.skip` in `rich-text-render.spec.ts`.

Run: `pnpm --filter web exec playwright test e2e/rich-text-render.spec.ts --reporter=list`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/state/testApi.ts apps/web/e2e/rich-text-render.spec.ts
git commit -m "test(richtext): applyTextFormat in testApi + un-skip per-range render"
```

### Task B6: Phase B acceptance — visual + spec sweep

- [ ] **Step 1: Run every P15 spec + new rich-text spec**

Run: `pnpm --filter web exec playwright test e2e/text-edit-position.spec.ts e2e/text-edit-wrap.spec.ts e2e/text-edit-underline.spec.ts e2e/text-edit-screenshots.spec.ts e2e/rich-text-render.spec.ts --reporter=list`
Expected: all PASS.

- [ ] **Step 2: Delete the probe**

Remove `apps/web/e2e/probe-html-text.spec.ts` and the dev-only probe route in `main.tsx`.

```bash
git rm apps/web/e2e/probe-html-text.spec.ts
git commit -am "chore(richtext): remove HTMLText probe"
```

- [ ] **Step 3: Tag**

```bash
git tag richtext-phase-b-complete
git push --tags
```

---

## Phase C — Edit overlay: contenteditable bound to Y.Text

Goal at end of Phase C: the inline edit surface is a `contenteditable` div instead of a `<textarea>`. The div's content tracks the Y.Text content via input handlers. Caret + selection still align with Pixi (via the existing textNode.y mirror). The overlay reports its current selection range to a `textEditSelection` store so the inspector can read it.

### Task C1: textEditSelection context

**Files:**

- Create: `apps/web/src/state/textEditSelection.ts`
- Create: `apps/web/src/state/textEditSelection.test.ts`

- [ ] **Step 1: Write failing test**

```ts
import { describe, it, expect } from 'vitest'
import {
  setActiveTextEditSelection,
  getActiveTextEditSelection,
  clearActiveTextEditSelection,
} from './textEditSelection.js'

describe('textEditSelection', () => {
  it('returns null by default', () => {
    clearActiveTextEditSelection()
    expect(getActiveTextEditSelection()).toBeNull()
  })

  it('returns the last set range', () => {
    setActiveTextEditSelection({ objectId: 't1', start: 5, length: 3 })
    expect(getActiveTextEditSelection()).toEqual({ objectId: 't1', start: 5, length: 3 })
  })

  it('clear resets to null', () => {
    setActiveTextEditSelection({ objectId: 't1', start: 0, length: 1 })
    clearActiveTextEditSelection()
    expect(getActiveTextEditSelection()).toBeNull()
  })
})
```

- [ ] **Step 2: Run, verify failures**

Run: `pnpm --filter web test -- textEditSelection`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
// apps/web/src/state/textEditSelection.ts
export interface TextEditSelectionRange {
  objectId: string
  start: number
  length: number
}

let active: TextEditSelectionRange | null = null
const listeners = new Set<() => void>()

export function setActiveTextEditSelection(r: TextEditSelectionRange | null): void {
  active = r
  for (const l of listeners) l()
}

export function clearActiveTextEditSelection(): void {
  setActiveTextEditSelection(null)
}

export function getActiveTextEditSelection(): TextEditSelectionRange | null {
  return active
}

export function subscribeToTextEditSelection(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}
```

- [ ] **Step 4: Verify pass**

Run: `pnpm --filter web test -- textEditSelection`
Expected: 3 PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/state/textEditSelection.ts apps/web/src/state/textEditSelection.test.ts
git commit -m "feat(richtext): textEditSelection store"
```

### Task C2: TextEditOverlay → contenteditable div

**Files:**

- Modify: `apps/web/src/ui/TextEditOverlay.tsx`

- [ ] **Step 1: Replace `<textarea>` with `<div contentEditable>`**

The div renders `dangerouslySetInnerHTML={{ __html: buildHtml(...) }}` once on mount; subsequent re-renders are skipped (let the user's edits flow through to Y.Text, not the other way around). All keystroke / paste / input handling routes through `onInput` → diff DOM ↔ Y.Text → write deltas.

- [ ] **Step 2: Implement onInput handler**

For Phase C the simplest correct strategy is: on every `input`, read the textContent of the editable div, then call `updateObject(...,{ text: newPlain })` so the existing Task A4 path replaces Y.Text contents while preserving identity. Inline formatting is preserved by reading the DOM's inline tags and translating to Y.Text format ops; OR — for Phase C only — accept that `<i>`/`<u>` typed via document.execCommand won't survive the round-trip; selection-driven format buttons land in Phase D and DO survive.

(This is the trade-off documented in the brainstorm: keystrokes are flat-text, format toggles are run-aware.)

- [ ] **Step 3: Track selection on selectionchange**

```ts
useEffect(() => {
  const el = editorRef.current
  if (el === null) return
  const onSel = () => {
    const sel = window.getSelection()
    if (sel === null || sel.rangeCount === 0 || !el.contains(sel.anchorNode)) {
      clearActiveTextEditSelection()
      return
    }
    const range = sel.getRangeAt(0)
    const start = nodeOffsetToTextIndex(el, range.startContainer, range.startOffset)
    const end = nodeOffsetToTextIndex(el, range.endContainer, range.endOffset)
    setActiveTextEditSelection({
      objectId: obj.id,
      start: Math.min(start, end),
      length: Math.abs(end - start),
    })
  }
  document.addEventListener('selectionchange', onSel)
  return () => document.removeEventListener('selectionchange', onSel)
}, [obj.id])
```

`nodeOffsetToTextIndex` walks the editable div's text nodes to convert (DOMNode, offset) → flat character index.

- [ ] **Step 4: Style — keep transparent text + caret + selection so Pixi underneath remains authoritative**

Reuse existing CSS (color: transparent, caret-color visible, ::selection translucent) — same as the textarea before.

- [ ] **Step 5: Run all P15 specs (selection assertions still expect a textarea — update)**

Specs that target `page.locator('textarea')` switch to `page.locator('[data-text-edit]')`. The overlay now renders `<div data-text-edit … />`.

Run: `pnpm --filter web exec playwright test e2e/text-edit-position.spec.ts --reporter=list`
Expected: PASS after locator update.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/ui/TextEditOverlay.tsx apps/web/e2e/text-edit-position.spec.ts apps/web/e2e/text-edit-screenshots.spec.ts apps/web/e2e/text-edit-wrap.spec.ts apps/web/e2e/text-edit-underline.spec.ts
git commit -m "feat(richtext): TextEditOverlay uses contenteditable bound to Y.Text"
```

### Task C3: Phase C acceptance

- [ ] **Step 1: Manual test — type in a text box, save, reload**

Verify content survives reload (Phase A migration) and renders correctly (Phase B).

- [ ] **Step 2: Run every spec**

Run: `pnpm --filter web exec playwright test e2e/text-edit-position.spec.ts e2e/text-edit-wrap.spec.ts e2e/text-edit-underline.spec.ts e2e/text-edit-screenshots.spec.ts e2e/rich-text-render.spec.ts --reporter=list`
Expected: all PASS.

- [ ] **Step 3: Tag**

```bash
git tag richtext-phase-c-complete
git push --tags
```

---

## Phase D — Inspector wires italic / underline / fontWeight / color to selection

Goal at end of Phase D: clicking italic in the inspector while a range is selected formats only that range; clicking with no range still updates the box-wide default.

### Task D1: Inspector consults textEditSelection on toggle

**Files:**

- Modify: `apps/web/src/ui/Inspector.tsx`

- [ ] **Step 1: Helper that decides format-vs-default**

```ts
function applyTextStyle(
  obj: TextObject,
  patch: (p: SlideObjectPatch<TextObject>) => void,
  attr: keyof RichAttrs,
  next: boolean | number,
  doc: Y.Doc,
): void {
  const sel = getActiveTextEditSelection()
  const yt = obj.text instanceof Y.Text ? obj.text : null
  if (sel !== null && sel.objectId === obj.id && sel.length > 0 && yt !== null) {
    doc.transact(() => {
      yt.format(sel.start, sel.length, { [attr]: next } as Record<string, unknown>)
    })
    return
  }
  patch({ [attr]: next === true ? true : next === false ? undefined : next } as never)
}
```

- [ ] **Step 2: Replace italic/underline button onClicks**

```ts
onClick={() => applyTextStyle(obj, patch, 'italic', !(obj.italic === true), doc)}
```

- [ ] **Step 3: Same for fontWeight (FontWeightSelect) and color (ColorInput) — pass attr name and value**

- [ ] **Step 4: Run rich-text-render spec PLUS a new selection-aware test**

```ts
// apps/web/e2e/rich-text-formatting.spec.ts
test('italic toggle with a selection only formats that range', async ({ page }) => {
  // … goto deck, set text "hello world", select chars 6-11, click inspector italic, assert html contains <i>world</i> only
})
```

Run: `pnpm --filter web exec playwright test e2e/rich-text-formatting.spec.ts --reporter=list`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/ui/Inspector.tsx apps/web/e2e/rich-text-formatting.spec.ts
git commit -m "feat(richtext): inspector toggles apply to selection range when active"
```

### Task D2: Phase D acceptance

- [ ] **Step 1: Manual + spec sweep**

Run: `pnpm --filter web exec playwright test e2e/text-edit-position.spec.ts e2e/text-edit-wrap.spec.ts e2e/text-edit-underline.spec.ts e2e/text-edit-screenshots.spec.ts e2e/rich-text-render.spec.ts e2e/rich-text-formatting.spec.ts --reporter=list`
Expected: all PASS.

- [ ] **Step 2: Tag**

```bash
git tag richtext-phase-d-complete
git push --tags
```

---

## Phase E — Backwards-compat reload spec + final acceptance

### Task E1: Migration spec for legacy plain-string decks

**Files:**

- Create: `apps/web/e2e/rich-text-migration.spec.ts`

- [ ] **Step 1: Write spec**

```ts
test('legacy text:string deck loads, renders, and edits without data loss', async ({ page }) => {
  // … goto deck, programmatically replace the obj's text Y.Map slot with a plain string via testApi.injectLegacyText(),
  // reload, verify renders, then perform an edit — assert it migrated to Y.Text and the new content is preserved.
})
```

- [ ] **Step 2: Add testApi.injectLegacyText**

Inserts a plain string into the Y.Map under 'text' (replacing any existing value).

- [ ] **Step 3: Run spec**

Run: `pnpm --filter web exec playwright test e2e/rich-text-migration.spec.ts --reporter=list`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/web/e2e/rich-text-migration.spec.ts apps/web/src/state/testApi.ts
git commit -m "test(richtext): legacy plain-string deck migration"
```

### Task E2: Final acceptance + handoff doc

- [ ] **Step 1: Run every text spec**

Run: `pnpm --filter web exec playwright test e2e/text-edit-position.spec.ts e2e/text-edit-wrap.spec.ts e2e/text-edit-underline.spec.ts e2e/text-edit-screenshots.spec.ts e2e/rich-text-render.spec.ts e2e/rich-text-formatting.spec.ts e2e/rich-text-migration.spec.ts --reporter=list`
Expected: all PASS.

- [ ] **Step 2: Run typecheck + lint + unit tests**

```bash
pnpm -r typecheck
pnpm -r lint
pnpm -r test
```

Expected: all green.

- [ ] **Step 3: Update CHANGELOG / handoff**

Add `docs/handoff/richtext-yjs-handoff.md` covering: schema change, migration notes, renderer/editor split, known limitations (concurrent insert inside a run is character-level CRDT-merged; only italic/underline/fontWeight/color are run attributes — no per-run fontFamily/fontSize yet).

- [ ] **Step 4: Commit + tag + open PR**

```bash
git add docs/handoff/richtext-yjs-handoff.md
git commit -m "docs(richtext): handoff notes"
git tag richtext-complete
git push --tags
gh pr create --title "richtext: Y.Text + HTMLText inline formatting" --body "..."
```

---

## Self-Review Notes (recorded for the executing agent)

- **Spec coverage**: every requirement in the brief has a task. vAlign top/middle/bottom + multi-line growing-up — preserved by Phase A's untouched applyVerticalAlign + Phase B's HTMLText measured height. Align left/center/right — preserved by applyHorizontalAlign. Descender-safe rendering — preserved by Pixi padding + clip mask extension (carry forward; HTMLText also respects style.padding). breakWords — buildStyle still sets it. Editor overlay transparency — Task C2. Existing 22 specs — explicitly run at every phase boundary. Backwards compat — Tasks A4 + E1.
- **Placeholder scan**: every code step has the actual code. The probe spec in B1 is intentionally exploratory (we don't know HTMLText's exact metrics yet); empirical findings from B1 feed B2.
- **Type consistency**: `RichAttrs` is defined once in `richText.ts` and re-exported; Inspector and testApi import from there.
