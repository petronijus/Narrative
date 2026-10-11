/**
 * commands/src/commands/serverShared.ts — schemas and helpers shared by the
 * commands that call server services (decks, folders, sharing, media,
 * components, PowerPoint, tokens). Outputs mirror the service records in
 * ../services/*.ts, curated to what a model needs (zod strips the rest).
 */

import { z } from 'zod'
import { CommandError } from '../errors.js'
import type { BinarySource, DocumentRef } from '../services/common.js'
import type { CommandContext, ConditionalConfirmation, RouteRef } from '../types.js'

/** Metadata every server-service command shares. */
export const serverCommand = {
  hosts: ['server'],
  implementedWith: [],
} as const

export const GET = (path: string): RouteRef => ({ method: 'GET', path })
export const POST = (path: string): RouteRef => ({ method: 'POST', path })
export const PUT = (path: string): RouteRef => ({ method: 'PUT', path })
export const PATCH = (path: string): RouteRef => ({ method: 'PATCH', path })
export const DELETE = (path: string): RouteRef => ({ method: 'DELETE', path })

export const IdSchema = z.string().min(1).max(64)
export const RoleSchema = z.enum(['viewer', 'editor', 'owner'])
const IsoTime = z.string().describe('ISO 8601 timestamp')

/** The deck a `deck`-scoped server command acts on (the host resolved and authorised it). */
export function targetDeckId(ctx: CommandContext): string {
  const id = ctx.target?.deckId
  if (id === undefined) {
    throw new CommandError(
      'no_target',
      ctx.target?.componentId !== undefined
        ? 'this command acts on a deck, not on a component master'
        : 'this command acts on a deck; name the deck (deckId)',
    )
  }
  return id
}

/**
 * The document a deck-scoped command that also accepts a component master
 * acts on: `{ componentId }` for a master, else `{ deckId }`.
 */
export function targetDocument(ctx: CommandContext): DocumentRef {
  const componentId = ctx.target?.componentId
  return componentId !== undefined ? { componentId } : { deckId: targetDeckId(ctx) }
}

/** Whether two refs name the same document (a deck and a master never are). Structural. */
export function sameDocument(a: DocumentRef, b: DocumentRef): boolean {
  return 'deckId' in a && 'deckId' in b
    ? a.deckId === b.deckId
    : 'componentId' in a && 'componentId' in b && a.componentId === b.componentId
}

/** The folder a `folder`-scoped server command acts on. */
export function targetFolderId(ctx: CommandContext): string {
  const id = ctx.target?.folderId
  if (id === undefined) {
    throw new CommandError('no_target', 'this command acts on a folder; name the folder (folderId)')
  }
  return id
}

// ---------------------------------------------------------------------------
// File input
// ---------------------------------------------------------------------------

/** Longest inline base64 accepted (≈ 48 MB of file); larger files go by URL. */
export const MAX_BASE64_CHARS = 64 * 1024 * 1024

export const FilenameSchema = z
  .string()
  .min(1)
  .max(255)
  .describe('File name hint, e.g. "logo.png" (the bytes decide the type)')
export const MimeHintSchema = z
  .string()
  .min(1)
  .max(127)
  .regex(/^[\w.+-]+\/[\w.+-]+$/, 'a MIME type like image/png')
  .describe('MIME type hint, e.g. "image/png" (the bytes decide the type)')

export const FileSourceSchema = z
  .union([
    z.strictObject({
      url: z
        .url({ protocol: /^https?$/ })
        .max(2048)
        .describe(
          'Public http(s) URL the server downloads (ports 80/443 only; private and internal addresses are ' +
            'refused, redirects re-checked)',
        ),
      filename: FilenameSchema.optional(),
      mimeType: MimeHintSchema.optional(),
    }),
    z.strictObject({
      base64: z
        .string()
        .min(1)
        .max(MAX_BASE64_CHARS)
        .describe('The file as base64, or as a data: URL (data:image/png;base64,…)'),
      filename: FilenameSchema.optional(),
      mimeType: MimeHintSchema.optional(),
    }),
  ])
  .describe('The file: { url } for something on the web, or { base64 } for bytes you have')

export type FileSourceInput = z.output<typeof FileSourceSchema>

/**
 * The host a `{ url }` file source downloads from, as the user should read
 * it: `URL#host` (lower-case, punycode, a non-default port kept), or null
 * for `{ base64 }` (nothing is fetched) and for a URL that does not parse
 * (validation refuses it anyway).
 */
export function fileSourceUrlHost(source: FileSourceInput | undefined): string | null {
  if (source === undefined || !('url' in source)) return null
  try {
    return new URL(source.url).host.toLowerCase()
  } catch {
    return null
  }
}

/**
 * `confirmWhen` for every command whose input embeds the shared file source:
 * a `{ url }` source makes the server download from a host the model chose,
 * so the user approves that host first (ConditionalConfirmation `url_fetch`
 * in types.ts). `sources` picks the file sources out of the validated input.
 * Inline `{ base64 }` bytes need no confirmation — nothing leaves the server.
 * The registry refuses a URL-fetching command without `confirmWhen`
 * (registry.ts `commandConfirmationProblems`), so a new file-taking command
 * cannot forget this.
 */
export function urlFetchConfirmation<I>(
  sources: (input: I) => ReadonlyArray<FileSourceInput | undefined>,
): (input: I) => ConditionalConfirmation | null {
  return (input) => {
    const hosts = [
      ...new Set(
        sources(input)
          .map(fileSourceUrlHost)
          .filter((h): h is string => h !== null),
      ),
    ]
    if (hosts.length === 0) return null
    return {
      kind: 'url_fetch',
      reason:
        'Narrative will download a file from the web. The address itself can carry information to that site, ' +
        'so only allow hosts you expect.',
      details: hosts.map((host) => ({ label: 'Downloads from', value: host })),
      hosts,
    }
  }
}

export function toBinarySource(input: FileSourceInput): BinarySource {
  const hints = {
    ...(input.filename !== undefined ? { filename: input.filename } : {}),
    ...(input.mimeType !== undefined ? { mimeType: input.mimeType } : {}),
  }
  return 'url' in input
    ? { kind: 'url', url: input.url, ...hints }
    : { kind: 'base64', data: input.base64, ...hints }
}

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

export const DeckOutput = z.object({
  id: z.string(),
  title: z.string(),
  folderId: z.string().nullable(),
  ownerUserId: z.string(),
  thumbnailUrl: z.string().nullable().describe('Signed thumbnail URL; null until one was rendered'),
  createdAt: IsoTime,
  updatedAt: IsoTime,
})

export const DeckWithRoleOutput = DeckOutput.extend({
  viewerRole: RoleSchema.describe("The caller's role on the deck"),
})

/** A deck as `deck.list` returns it: just enough to pick one. */
export const DeckListItemOutput = z.object({
  id: z.string(),
  title: z.string(),
  folderId: z.string().nullable(),
  updatedAt: IsoTime.describe('Last change to the content, title or folder (ISO 8601)'),
  role: RoleSchema.describe("The caller's role on the deck"),
})

export const FolderOutput = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: IsoTime,
})

export const FontFaceOutput = z.object({
  assetId: z.string(),
  family: z.string().nullable().describe('CSS font-family to use in text (fontFamily)'),
  weight: z.number().nullable(),
  style: z.string().nullable(),
  postscriptName: z.string().nullable(),
  url: z.string().describe('Short-lived download URL of the font file'),
  sizeBytes: z.number(),
  uploadedAt: IsoTime,
})

export const ComponentOutput = z.object({
  id: z.string(),
  folderId: z.string(),
  name: z.string(),
  thumbnailUrl: z.string().nullable(),
  createdAt: IsoTime,
  updatedAt: IsoTime,
})

export const TokenRebindOutput = z.object({
  rebound: z.number().describe('References now pointing at a same-named token of the destination'),
  literalised: z.number().describe('Colour references replaced by their literal colour'),
  detached: z.number().describe('Text-style links removed (the text keeps its look)'),
  unmatched: z.number().describe('References left as they were (dangling, or effect styles)'),
})
