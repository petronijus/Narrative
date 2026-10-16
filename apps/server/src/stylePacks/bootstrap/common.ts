/**
 * stylePacks/bootstrap/common.ts — what every brand importer shares
 * (agentic A4.7, docs/plans/a4-style-packs.md): unit conversions to the
 * 1920×1080 canvas, text styles deduplicated by what they set, the
 * provenance of the sources, the check every pack passes before it is
 * written (the schema, then `validateStylePack`), and a try-out of it as a
 * folder would use it (`tryPack`).
 */

import { execFileSync } from 'node:child_process'
import { relative } from 'node:path'
import { StylePackSchema, validateStylePack, type Slide, type StylePack } from '@narrative/shared'
import type { FolderTokensSnapshot } from '@narrative/slide-model'
import { checkDeck, compileStylePack, planLayout } from '@narrative/commands'

export const CANVAS_W = 1920
export const CANVAS_H = 1080

/** A canvas fraction to 4 decimals (≈ 0.2 px): what a pack stores. */
export const frac = (v: number): number => Math.round(v * 10_000) / 10_000
/** Px to the half pixel. */
export const px = (v: number): number => Math.round(v * 2) / 2

/** A pack id from a source name: lower case, hyphens. */
export function packId(name: string): string {
  const id = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return /^[a-z]/.test(id) ? id.slice(0, 48) : `x-${id}`.slice(0, 48)
}

/** Where a source came from: the repo, its commit, the path inside it. */
export function sourceOf(
  repoRoot: string,
  file: string,
): { repo: string; commit: string; path: string } {
  let commit = 'unknown'
  try {
    commit = execFileSync('git', ['-C', repoRoot, 'rev-parse', '--short', 'HEAD'], {
      encoding: 'utf8',
    }).trim()
  } catch {
    /* not a git checkout: the commit stays unknown */
  }
  const name = repoRoot.replace(/\/+$/, '').split('/').pop() ?? repoRoot
  return { repo: name, commit, path: relative(repoRoot, file) }
}

/**
 * Text styles keyed by what they set: the same style met again (Contoso repeats
 * its title on 46 layouts) gets the id it got first; a different one with
 * the same base name gets the size appended.
 */
export class StyleBook {
  readonly styles: Record<string, StylePack['textStyles'][string]> = {}
  private readonly bySignature = new Map<string, string>()

  add(base: string, style: StylePack['textStyles'][string]): string {
    const { name: _name, ...rest } = style
    const signature = JSON.stringify(rest)
    const known = this.bySignature.get(signature)
    if (known !== undefined) return known
    let id = packId(base)
    if (this.styles[id] !== undefined) id = `${id}-${Math.round(style.size)}`
    let n = 2
    while (this.styles[id] !== undefined) id = `${packId(base)}-${Math.round(style.size)}-${n++}`
    this.styles[id] = style
    this.bySignature.set(signature, id)
    return id
  }
}

/** The pack checked whole; the issues, or the parsed pack. */
export function checkPack(pack: unknown): { pack: StylePack } | { issues: string[] } {
  const parsed = StylePackSchema.safeParse(pack)
  if (!parsed.success)
    return {
      issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    }
  const issues = validateStylePack(parsed.data)
  if (issues.length > 0) return { issues: issues.map((i) => `${i.path}: ${i.message}`) }
  return { pack: parsed.data }
}

/** Today, as the provenance records it. */
export const today = (): string => new Date().toISOString().slice(0, 10)

/** The pack without the text styles nothing names (a derived pack inherits all of its parent's). */
export function withUsedTextStyles(pack: StylePack): StylePack {
  const used = new Set<string>()
  const visit = (v: unknown, key?: string): void => {
    if (Array.isArray(v)) v.forEach((x) => visit(x))
    else if (v !== null && typeof v === 'object')
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) visit(x, k)
    else if (key === 'textStyle' && typeof v === 'string') used.add(v)
  }
  visit({ layouts: pack.layouts, components: pack.components, furniture: pack.furniture })
  return {
    ...pack,
    textStyles: Object.fromEntries(Object.entries(pack.textStyles).filter(([id]) => used.has(id))),
  }
}

/**
 * A pack tried out as a folder would use it: compiled, every layout laid
 * out on an empty slide, the result checked with the pack's own rules (no
 * measurement). Problems that stop a layout are `failures`; the checker's
 * findings on the empty layouts are counted per rule, for the record (a
 * placeholder picture or an unfilled footer field is expected there).
 */
export function tryPack(pack: StylePack): {
  failures: string[]
  findings: Record<string, number>
} {
  const failures: string[] = []
  const findings: Record<string, number> = {}
  const plan = compileStylePack(pack, {
    tokens: { colors: {}, textStyles: {}, effectStyles: {} },
    fonts: null,
  })
  const tokens: FolderTokensSnapshot = { colors: {}, textStyles: {}, effectStyles: {} }
  for (const t of plan.colors)
    tokens.colors[t.id] = { id: t.id, ...t.fields, origin: t.origin } as never
  for (const t of plan.textStyles)
    tokens.textStyles[t.id] = { id: t.id, builtin: false, ...t.fields, origin: t.origin } as never
  const slides: Slide[] = []
  pack.layouts.forEach((layout, i) => {
    try {
      const laid = planLayout({
        pack,
        layoutId: layout.id,
        tokens,
        meta: {},
        objects: [],
        current: undefined,
        slideNumber: i + 1,
      })
      slides.push({
        id: `s${i + 1}`,
        objects: laid.add,
        animations: [],
        transition: { kind: 'none', durationMs: 0 },
        background: laid.background,
        layout: laid.layout,
      } as Slide)
    } catch (e) {
      failures.push(`layouts[${i}] ${layout.id}: ${(e as Error).message}`)
    }
  })
  const report = checkDeck({
    pack,
    tokens,
    meta: {},
    slides: slides.map((slide, index) => ({ slide, index })),
    measurement: null,
  })
  for (const f of report.findings)
    findings[`${f.level} ${f.rule}`] = (findings[`${f.level} ${f.rule}`] ?? 0) + 1
  return { failures, findings }
}
