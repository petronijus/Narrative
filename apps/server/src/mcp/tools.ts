/**
 * mcp/tools.ts — MCP tools, generated from the command registry (ADR 0010:
 * MCP is a projection of the registry, never a second door). Nothing here
 * is hand-written per command; a new command appears as a tool on the next
 * start.
 *
 * Per command, one tool:
 *   name         the command id with `.` → `_` (agentSurface.ts explains why)
 *   description  the command's description (written for a model), with every
 *                command mention rewritten to its tool name, the input forms
 *                of a union input, one line on how the user confirms (only
 *                for tools that may need it, worded for the session's
 *                client — see `ConfirmationMode`), and one example call
 *                unless the input is trivial (see `needsExample`). The
 *                target rules, `runId`, how a confirmation proceeds, and
 *                the fields that mean the same everywhere
 *                (vocabulary.ts) are NOT repeated per tool: the server
 *                instructions say them once (guidance.ts).
 *   inputSchema  the command's input as JSON Schema (zod, `io: 'input'`),
 *                compacted (schemaCompact.ts: uninformative bounds dropped,
 *                discriminated unions collapsed, cheap `$defs` inlined —
 *                the tool list is in every session's context) and without
 *                the shared field descriptions (vocabulary.ts), plus the
 *                transport arguments, bare (`{ type: 'string' }`):
 *                  deck scope    `deckId`; also `componentId` for commands
 *                                that accept a component master
 *                                (`acceptsComponent`) — exactly one of the
 *                                two, which the host enforces (JSON Schema's
 *                                oneOf is not allowed at the root of a
 *                                Claude tool), and the host refuses a
 *                                componentId for every other command
 *                  folder scope  `folderId`
 *                  user scope    none
 *                  every tool    optional `runId`
 *                  tools that may need the user's confirmation
 *                  (`confirm: 'always'` or `confirmWhen`), for clients that
 *                  may be handed a link (no form question): optional
 *                  `confirmationId` — the id Narrative issued with a
 *                  `confirmation_required` error, AFTER the user approved it
 *                  on Narrative's page (mcp/confirm.ts). Never a yes/no the
 *                  model could set.
 *                An input whose own property has one of those names keeps
 *                it and the transport argument is left out: today
 *                `component.stamp` (its own componentId: it targets decks
 *                only) and `agent.revert` (its own runId). A deck- or
 *                folder-scoped input with its own deckId / folderId, a
 *                component-accepting input with its own componentId, or any
 *                input with `confirmationId`, fails the start (mcp.test.ts
 *                pins the cases).
 *   annotations  from the registry's explicit metadata (types.ts; the
 *                registry refuses inconsistent combinations, registry.ts
 *                `commandMetadataProblems`); a hint equal to the MCP
 *                default (readOnlyHint / idempotentHint false) is left out:
 *                readOnlyHint     `readOnly: true` — document queries and
 *                                 server reads (deck_list, share_links_list,
 *                                 media_url, …), which clients may run
 *                                 without asking
 *                destructiveHint  writes only: `undo: 'irreversible'`
 *                                 (false for every other write; omitted on
 *                                 read-only tools, where the spec ignores it)
 *                idempotentHint   read-only tools, and writes marked
 *                                 `idempotent: true` (set-to-value commands
 *                                 whose repeat changes nothing more — the
 *                                 contract suite runs each example twice);
 *                                 false for every other write
 *                openWorldHint    commands that can fetch a URL
 */

import { z } from 'zod'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'
import type { ElicitationSupport } from './confirm.js'
import { compactInputSchema } from './schemaCompact.js'
import { SHARED_DESCRIPTIONS } from './vocabulary.js'
import { compactSharedShapes } from './sharedShapes.js'
import {
  commandFetchesUrls,
  rewriteCommandMentionsAsToolNames,
  toolNameForCommand,
  type AnyCommandDef,
  type CommandRegistry,
  type CommandScope,
} from '@narrative/commands'

/** Arguments the transport adds next to a command's own input. */
export type TransportArgument = 'deckId' | 'componentId' | 'folderId' | 'runId' | 'confirmationId'

/**
 * The transport arguments' schemas. Deliberately bare: they repeat on
 * almost every tool (≈ 13 KB of the tool list with a description each), and
 * what they mean — where the ids come from, that `componentId` targets a
 * component master instead of a deck — is said once in the server's
 * instructions (guidance.ts `instructions`). Lengths are the server's to
 * enforce.
 */
const TARGET_SCHEMAS = {
  deckId: { type: 'string' },
  componentId: { type: 'string' },
  folderId: { type: 'string' },
} as const

/** Optional on every tool; the instructions explain it (a run from agent_startRun). */
const RUN_ID_SCHEMA = { type: 'string' } as const

/** Bare like the others: the instructions say where it comes from and when to send it. */
const CONFIRMATION_ID_SCHEMA = { type: 'string' } as const

/** Confirmation ids are 22 base64url characters (agent/confirmations.ts). */
const CONFIRMATION_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/

/** A JSON Schema object (as produced by z.toJSONSchema). */
type JsonSchema = Record<string, unknown>

export interface ToolEntry {
  def: AnyCommandDef
  name: string
  scope: CommandScope
  /** Transport arguments this tool takes (a clash with an input property removes one). */
  targetArguments: ReadonlyArray<'deckId' | 'componentId' | 'folderId'>
  acceptsRunId: boolean
  /**
   * May need the user's confirmation before it runs: `confirm: 'always'`
   * (always), or `confirmWhen` (depending on the input, e.g. a URL download).
   */
  mayNeedConfirmation: boolean
  /**
   * The tool as listed to each kind of client (see {@link ConfirmationMode}):
   * the same but for what a confirmation looks like, and `confirmationId`,
   * which clients that confirm through a link need.
   */
  tools: Readonly<Record<ConfirmationMode, Tool>>
}

/**
 * How a session's client lets the user confirm (mcp/confirm.ts): a question
 * in the client (`form`), a Narrative page the client opens while the call
 * waits (`url`), or a link the model hands the user, then a retry with the
 * `confirmationId` (`link`). A form question the client dismisses falls back
 * to the link too, so `form` tools mention it.
 */
export type ConfirmationMode = 'form' | 'url' | 'link'

export function confirmationModeOf(support: ElicitationSupport): ConfirmationMode {
  return support.form ? 'form' : support.url ? 'url' : 'link'
}

/** The per-tool line about confirmation: accurate for how THIS client confirms. */
function confirmationLine(def: AnyCommandDef, mode: ConfirmationMode): string | null {
  const always = def.confirm === 'always'
  const conditional = typeof def.confirmWhen === 'function'
  if (!always && !conditional) return null
  // What follows a confirmation (declined, dismissed, the retry with a
  // confirmationId) is said once in the instructions; this line says only
  // THAT the user is asked, and how in this client.
  const what = always
    ? conditional
      ? 'Irreversible, and a URL download needs its host approved by the user (base64 does not):'
      : 'Irreversible:'
    : 'A URL download needs its host approved by the user (base64 does not):'
  switch (mode) {
    case 'form':
      return `${what} Narrative asks the user in your client first.`
    case 'url':
      return `${what} Narrative opens a confirmation page and the call waits for the answer.`
    case 'link':
      return `${what} the call returns confirmation_required with a link for the user.`
  }
}

export class ToolSchemaError extends Error {}

function stripSchemaDialect(schema: JsonSchema): JsonSchema {
  const { $schema: _dialect, ...rest } = schema
  return rest
}

function resolveRootRef(branch: JsonSchema, root: JsonSchema): JsonSchema {
  const ref = branch['$ref']
  if (typeof ref !== 'string') return branch
  const match = /^#\/\$defs\/(.+)$/.exec(ref)
  const defs = root['$defs'] as Record<string, JsonSchema> | undefined
  const target = match ? defs?.[decodeURIComponent(match[1]!)] : undefined
  if (target === undefined) throw new ToolSchemaError(`cannot resolve ${ref}`)
  return target
}

/**
 * MCP requires a tool's input schema to be `type: 'object'` at the root, and
 * the Anthropic API rejects `anyOf` / `oneOf` / `allOf` there. A command
 * whose input is a union of objects (`object.update`: one object or many)
 * is flattened: every property of every alternative, required only where
 * every alternative requires it, strict when every alternative is. The
 * alternatives are named in the returned `forms` for the description; the
 * server still validates against the real union, so nothing is lost.
 */
function objectRoot(schema: JsonSchema, commandId: string): { root: JsonSchema; forms: string[] } {
  if (schema['type'] === 'object') return { root: schema, forms: [] }
  const branches = (schema['anyOf'] ?? schema['oneOf']) as JsonSchema[] | undefined
  if (!Array.isArray(branches) || branches.length === 0) {
    throw new ToolSchemaError(
      `command '${commandId}': input must be an object (or a union of objects)`,
    )
  }
  const objects = branches.map((b) => resolveRootRef(b, schema))
  if (!objects.every((o) => o['type'] === 'object')) {
    throw new ToolSchemaError(
      `command '${commandId}': every alternative of its input must be an object`,
    )
  }
  const properties: Record<string, JsonSchema> = {}
  const variantsOf: Record<string, JsonSchema[]> = {}
  for (const o of objects) {
    for (const [key, value] of Object.entries(
      (o['properties'] ?? {}) as Record<string, JsonSchema>,
    )) {
      ;(variantsOf[key] ??= []).push(value)
    }
  }
  for (const [key, variants] of Object.entries(variantsOf)) {
    const distinct = variants.filter(
      (v, i) => variants.findIndex((w) => JSON.stringify(w) === JSON.stringify(v)) === i,
    )
    properties[key] = distinct.length === 1 ? distinct[0]! : { anyOf: distinct }
  }
  const requiredSets = objects.map((o) => new Set((o['required'] ?? []) as string[]))
  const required = [...requiredSets[0]!].filter((k) => requiredSets.every((s) => s.has(k)))
  const forms = objects.map((o) => {
    const req = new Set((o['required'] ?? []) as string[])
    const keys = Object.keys((o['properties'] ?? {}) as object).map((k) =>
      req.has(k) ? k : `${k}?`,
    )
    return `{ ${keys.join(', ')} }`
  })
  const root: JsonSchema = {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {}),
    ...(objects.every((o) => o['additionalProperties'] === false)
      ? { additionalProperties: false }
      : {}),
    ...(schema['$defs'] !== undefined ? { $defs: schema['$defs'] } : {}),
    ...(typeof schema['description'] === 'string' ? { description: schema['description'] } : {}),
  }
  return { root, forms }
}

/** Drop every `description` the instructions already give once (vocabulary.ts). */
function stripSharedDescriptions(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripSharedDescriptions)
  if (value === null || typeof value !== 'object') return value
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (k === 'description' && typeof v === 'string' && SHARED_DESCRIPTIONS.has(v)) continue
    out[k] = stripSharedDescriptions(v)
  }
  return out
}

/** Rewrite command mentions inside every `description` of a JSON Schema. */
function rewriteSchemaDescriptions(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(rewriteSchemaDescriptions)
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([k, v]) => [
      k,
      k === 'description' && typeof v === 'string'
        ? rewriteCommandMentionsAsToolNames(v)
        : rewriteSchemaDescriptions(v),
    ]),
  )
}

/**
 * A command's input as the tool's JSON Schema. `keepShared` keeps the
 * descriptions vocabulary.ts moves to the instructions — for the test that
 * checks the vocabulary against what the commands really say.
 */
export function commandInputJsonSchema(
  def: AnyCommandDef,
  {
    keepShared = false,
    keepShapes = keepShared,
  }: {
    /** Keep the shared field descriptions and shapes (vocabulary.ts, sharedShapes.ts). */
    keepShared?: boolean
    /** Keep only the shared shapes: the schema as sharedShapes.ts matches it. */
    keepShapes?: boolean
  } = {},
): { root: JsonSchema; forms: string[] } {
  let raw: JsonSchema
  try {
    raw = z.toJSONSchema(def.input, { io: 'input', reused: 'ref' }) as JsonSchema
  } catch (e) {
    throw new ToolSchemaError(
      `command '${def.id}': input is not representable as JSON Schema: ${(e as Error).message}`,
    )
  }
  const { root, forms } = objectRoot(stripSchemaDialect(raw), def.id)
  const compact = compactInputSchema(rewriteSchemaDescriptions(root) as JsonSchema)
  // The shared descriptions and shapes are said once in the instructions
  // (vocabulary.ts, sharedShapes.ts); `keepShared` shows them in full.
  if (keepShared) return { root: compact, forms }
  const stripped = stripSharedDescriptions(compact) as JsonSchema
  return { root: keepShapes ? stripped : (compactSharedShapes(stripped) as JsonSchema), forms }
}

function targetArgumentsFor(
  def: AnyCommandDef,
  scope: CommandScope,
  inputProperties: ReadonlySet<string>,
) {
  if (scope === 'user') return [] as const
  if (scope === 'folder') {
    if (inputProperties.has('folderId'))
      throw new ToolSchemaError(
        `command '${def.id}': folder scope, but its input has its own folderId`,
      )
    return ['folderId'] as const
  }
  if (inputProperties.has('deckId'))
    throw new ToolSchemaError(`command '${def.id}': deck scope, but its input has its own deckId`)
  // Only commands that really work on a component master offer `componentId`
  // (the registry's `acceptsComponent`); the host refuses it for the rest.
  if (def.acceptsComponent !== true) return ['deckId'] as const
  if (inputProperties.has('componentId'))
    throw new ToolSchemaError(
      `command '${def.id}': accepts a component master as its target, but its input has its own componentId`,
    )
  return ['deckId', 'componentId'] as const
}

/** Transport argument names: not part of what an example has to show. */
const TRANSPORT_ARGUMENTS: ReadonlySet<string> = new Set<TransportArgument>([
  'deckId',
  'componentId',
  'folderId',
  'runId',
  'confirmationId',
])

/**
 * Whether an example call earns its bytes: the input is a union (several
 * input forms, flattened by `objectRoot`), or has a nested
 * object or an array, or more than two properties. A tool whose input is at
 * most two plain values (deck_rename's `title`, share_links_revoke's link
 * id) is fully said by its schema; 39 tools, ≈ 3 KB of the list.
 */
function needsExample(root: JsonSchema, hasForms: boolean): boolean {
  if (hasForms) return true
  const own = Object.entries((root['properties'] ?? {}) as Record<string, JsonSchema>).filter(
    ([k]) => !TRANSPORT_ARGUMENTS.has(k),
  )
  if (own.length > 2) return true
  return own.some(([, v]) => {
    const json = JSON.stringify(v)
    return (
      v['type'] === 'array' || json.includes('"properties"') || /"(anyOf|oneOf|\$ref)"/.test(json)
    )
  })
}

/**
 * The first example as a call, target placeholder first (the argument a
 * model most often forgets). No title: the call says what it does, and the
 * titles were ≈ 3 KB of the list.
 */
function exampleCall(
  def: AnyCommandDef,
  scope: CommandScope,
  root: JsonSchema,
  hasForms: boolean,
  /** The input schema before the shared shapes are compacted: what decides whether an example is needed. */
  fullRoot: JsonSchema = root,
): string | null {
  const example = def.examples[0]
  if (example === undefined || !needsExample(fullRoot, hasForms)) return null
  const target =
    scope === 'deck' ? { deckId: '<deckId>' } : scope === 'folder' ? { folderId: '<folderId>' } : {}
  const input =
    typeof example.input === 'object' && example.input !== null
      ? (example.input as Record<string, unknown>)
      : {}
  const args =
    def.id === 'ops.apply' ? { ...target, ...opsInToolNames(input) } : { ...target, ...input }
  return `Example: ${JSON.stringify(args)}`
}

/** Show `ops.apply` examples with tool names inside `ops`, as the model sees the tools. */
function opsInToolNames(input: Record<string, unknown>): Record<string, unknown> {
  const ops = input['ops']
  if (!Array.isArray(ops)) return input
  return {
    ...input,
    ops: ops.map((op: unknown) =>
      typeof op === 'object' &&
      op !== null &&
      typeof (op as { command?: unknown }).command === 'string'
        ? { ...op, command: toolNameForCommand((op as { command: string }).command) }
        : op,
    ),
  }
}

export function annotationsFor(def: AnyCommandDef): NonNullable<Tool['annotations']> {
  const readOnly = def.readOnly === true
  // No `title` here: the tool's own `title` carries it (annotations.title is
  // the older duplicate of the same field).
  // Hints equal to the MCP defaults (readOnlyHint and idempotentHint
  // default to false) are left out; destructiveHint and openWorldHint
  // default to TRUE, so they are always stated.
  return {
    ...(readOnly
      ? { readOnlyHint: true, idempotentHint: true }
      : {
          destructiveHint: def.undo === 'irreversible',
          ...(def.idempotent === true ? { idempotentHint: true } : {}),
        }),
    openWorldHint: commandFetchesUrls(def),
  }
}

function buildEntry(def: AnyCommandDef): ToolEntry {
  const scope = def.scope ?? 'deck'
  const name = toolNameForCommand(def.id)
  const { root, forms } = commandInputJsonSchema(def)
  // Whether a tool shows an example call is decided on the full shapes: a
  // compacted slide reference is still an input a model gets wrong.
  const { root: fullRoot } = commandInputJsonSchema(def, { keepShapes: true })
  const inputProps = (root['properties'] ?? {}) as Record<string, JsonSchema>
  const own = new Set(Object.keys(inputProps))
  if (own.has('confirmationId'))
    throw new ToolSchemaError(
      `command '${def.id}': 'confirmationId' is reserved for out-of-band confirmations`,
    )
  const targetArguments = targetArgumentsFor(def, scope, own)
  const acceptsRunId = !own.has('runId')
  const mayNeedConfirmation = def.confirm === 'always' || typeof def.confirmWhen === 'function'

  const transportProps: Record<string, JsonSchema> = {}
  for (const t of targetArguments) transportProps[t] = { ...TARGET_SCHEMAS[t] }
  if (acceptsRunId) transportProps['runId'] = { ...RUN_ID_SCHEMA }

  const describe = (mode: ConfirmationMode): string =>
    [
      rewriteCommandMentionsAsToolNames(def.description),
      forms.length > 0 ? `Input forms (send exactly one): ${forms.join(' | ')}.` : null,
      confirmationLine(def, mode),
      exampleCall(def, scope, root, forms.length > 0, fullRoot),
    ]
      .filter((x): x is string => x !== null)
      .join('\n\n')

  const schemaWith = (extra: Record<string, JsonSchema>): Tool['inputSchema'] => ({
    ...root,
    type: 'object',
    // Transport arguments first: they are what a model most often forgets.
    properties: { ...transportProps, ...extra, ...inputProps },
    ...(scope === 'folder'
      ? { required: ['folderId', ...((root['required'] as string[] | undefined) ?? [])] }
      : {}),
  })
  const annotations = annotationsFor(def)
  const toolFor = (mode: ConfirmationMode): Tool => ({
    name,
    title: def.title,
    description: describe(mode),
    inputSchema: schemaWith(
      mayNeedConfirmation && mode !== 'form'
        ? { confirmationId: { ...CONFIRMATION_ID_SCHEMA } }
        : {},
    ),
    annotations,
  })
  const form = toolFor('form')
  const tools: Record<ConfirmationMode, Tool> = mayNeedConfirmation
    ? { form, url: toolFor('url'), link: toolFor('link') }
    : { form, url: form, link: form }
  return {
    def,
    name,
    scope,
    targetArguments,
    acceptsRunId,
    mayNeedConfirmation,
    tools,
  }
}

export class ToolCatalog {
  private readonly byName = new Map<string, ToolEntry>()

  constructor(registry: CommandRegistry) {
    for (const def of registry.list()) {
      const entry = buildEntry(def)
      if (this.byName.has(entry.name))
        throw new ToolSchemaError(`duplicate tool name '${entry.name}'`)
      this.byName.set(entry.name, entry)
    }
  }

  get(name: string): ToolEntry | undefined {
    return this.byName.get(name)
  }

  entries(): ToolEntry[] {
    return [...this.byName.values()]
  }

  /** The tool list for one session, as its client confirms (`confirmationId` only where a link needs it). */
  list(mode: ConfirmationMode): Tool[] {
    return this.entries().map((e) => e.tools[mode])
  }
}

export interface SplitArguments {
  target: { deckId?: string; componentId?: string; folderId?: string }
  runId?: string
  /** A server-issued confirmation id the model passed back. */
  confirmationId?: string
  input: Record<string, unknown>
}

export class ArgumentError extends Error {}

/**
 * Separate the transport arguments from the command's own input. Only the
 * transport arguments this tool declares are taken out; everything else is
 * the input, which the runner validates strictly (unknown keys fail there),
 * so a misplaced `folderId` on a deck tool is reported, not ignored.
 */
export function splitArguments(
  entry: ToolEntry,
  args: Readonly<Record<string, unknown>>,
): SplitArguments {
  const input: Record<string, unknown> = { ...args }
  const target: SplitArguments['target'] = {}
  for (const key of entry.targetArguments) {
    if (!(key in input)) continue
    const value = input[key]
    delete input[key]
    if (value === undefined || value === null) continue
    if (typeof value !== 'string' || value.length === 0 || value.length > 128)
      throw new ArgumentError(`\`${key}\` must be a non-empty id`)
    target[key] = value
  }
  let runId: string | undefined
  if (entry.acceptsRunId && 'runId' in input) {
    const value = input['runId']
    delete input['runId']
    if (value !== undefined && value !== null) {
      if (typeof value !== 'string' || value.length === 0 || value.length > 64)
        throw new ArgumentError('`runId` must be a run id from agent_startRun')
      runId = value
    }
  }
  let confirmationId: string | undefined
  // Taken out for every client: a server-issued id the user approved is as
  // good as a form answer, whichever way the client talks.
  if (entry.mayNeedConfirmation && 'confirmationId' in input) {
    const value = input['confirmationId']
    delete input['confirmationId']
    if (value !== undefined && value !== null) {
      if (typeof value !== 'string' || !CONFIRMATION_ID_PATTERN.test(value))
        throw new ArgumentError(
          '`confirmationId` must be the id Narrative returned with confirmation_required',
        )
      confirmationId = value
    }
  }
  return {
    target,
    ...(runId === undefined ? {} : { runId }),
    ...(confirmationId === undefined ? {} : { confirmationId }),
    input,
  }
}
