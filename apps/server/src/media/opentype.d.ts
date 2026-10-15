/**
 * media/opentype.d.ts
 *
 * opentype.js 2 ships no typings (and `@types/opentype.js` describes 1.x),
 * so this declares the slice of its ESM build that `fontMetadata.ts` reads.
 *
 * The import names the ESM build by path: the package has no `exports`
 * map, and its two builds disagree — `main` (CommonJS, what Node picks)
 * offers only a default export, `module` (what Vite and Vitest pick) only
 * named ones. `dist/opentype.mjs` is ESM everywhere.
 */

declare module 'opentype.js/dist/opentype.mjs' {
  /** One name-table string per language code (`en`, `de`, …). */
  export type LocalizedName = Partial<Record<string, string>>

  /** Name-table records of one platform, keyed by property (`fontFamily`, `postScriptName`, …). */
  export type PlatformNames = Partial<Record<string, LocalizedName>>

  export interface FontNames {
    windows?: PlatformNames
    macintosh?: PlatformNames
    unicode?: PlatformNames
  }

  export interface Os2Table {
    usWeightClass?: number
    fsSelection?: number
  }

  export interface FvarAxis {
    tag?: string
    minValue?: number
    defaultValue?: number
    maxValue?: number
  }

  export interface FvarTable {
    axes?: FvarAxis[]
  }

  /** Throws on a buffer that is not an OpenType / TrueType font. */
  export function parse(buffer: ArrayBuffer): Font

  // ─── Writing (the tests build their fonts) ──────────────────────────────

  export class Path {}

  export class Glyph {
    constructor(options: { name: string; advanceWidth: number; path: Path; unicode?: number })
  }

  export interface FontOptions {
    familyName: string
    styleName: string
    unitsPerEm: number
    ascender: number
    descender: number
    glyphs: Glyph[]
    weightClass?: number
    italicAngle?: number
    tables?: { fvar?: FvarTable & { instances: unknown[] } }
  }

  export class Font {
    constructor(options: FontOptions)
    names: FontNames
    tables: { os2?: Os2Table; fvar?: FvarTable; [table: string]: unknown }
    toArrayBuffer(): ArrayBuffer
  }
}
