/**
 * commands/src/registry.ts
 *
 * `defineCommand` gives each definition full inference of its input/output
 * types; `CommandRegistry` is the lookup every host uses. The registry is
 * the capability source of truth (ADR 0010): the MCP tool list, the HTTP
 * batch API and the generated capability manifest are all derived from it.
 */

import type { z } from 'zod'
import { commandFetchesUrls } from './agentSurface.js'
import type { CommandDef } from './types.js'

const ID_PATTERN = /^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*){1,3}$/

export function defineCommand<I extends z.ZodType, O extends z.ZodType, L = undefined>(
  def: CommandDef<I, O, L>,
): CommandDef<I, O, L> {
  return def
}

/** A registered command with its types erased, as hosts see it. */
export type AnyCommandDef = CommandDef<z.ZodType, z.ZodType, unknown>

const DOCUMENT_EFFECTS = new Set(['doc', 'folderDoc', 'componentDoc'])

/**
 * Metadata rules the MCP annotations rely on (see `readOnly` and
 * `idempotent` in types.ts). Empty when `def` is consistent. `register`
 * refuses a command with any problem, so a registry that exists is a
 * consistent one; the parity suite lists them for the whole default
 * registry at once.
 */
export function commandMetadataProblems(
  def: Pick<
    AnyCommandDef,
    | 'id'
    | 'domain'
    | 'effects'
    | 'undo'
    | 'confirm'
    | 'readOnly'
    | 'idempotent'
    | 'undoneBy'
    | 'readsDocument'
    | 'readsFolderTokens'
  >,
): string[] {
  const problems: string[] = []
  if (def.readOnly === true) {
    const docEffects = def.effects.filter((e) => DOCUMENT_EFFECTS.has(e))
    if (docEffects.length > 0)
      problems.push(`read-only, but it has document effects (${docEffects.join(', ')})`)
    if (def.undo !== 'n/a') problems.push(`read-only, but undo is '${def.undo}' (must be 'n/a')`)
    if (def.confirm !== 'never')
      problems.push(`read-only, but confirm is '${def.confirm}' (must be 'never')`)
    if (def.idempotent !== undefined)
      problems.push('read-only commands are idempotent by definition; drop `idempotent`')
  } else {
    if (def.effects.length === 0) problems.push('has no effects, so it must declare readOnly: true')
    if (def.domain === 'query') problems.push('query commands must declare readOnly: true')
    if (def.idempotent === true && def.undo === 'n/a')
      problems.push("idempotent is for writes, but undo is 'n/a'")
  }
  const serverUndoable =
    def.undo === 'undoable' && !def.effects.some((e) => DOCUMENT_EFFECTS.has(e))
  if (serverUndoable && def.undoneBy === undefined)
    problems.push(
      'undoable without a document effect, so it must name its counter-command in `undoneBy` (agent.revert only undoes documents)',
    )
  if (!serverUndoable && def.undoneBy !== undefined)
    problems.push('`undoneBy` is only for undoable commands without a document effect')
  // Folder tokens serve a document command (the host provides them next to
  // `ctx.deck`); anywhere else nothing would load them.
  const usesDocument =
    def.effects.includes('doc') || def.effects.length === 0 || def.readsDocument === true
  if (def.readsFolderTokens === true && !usesDocument)
    problems.push('`readsFolderTokens` is for commands that use the target document')
  return problems
}

/**
 * Target rules (see `acceptsComponent` in types.ts). Empty when `def` is
 * consistent; `register` refuses a command with any problem.
 *   - Only a deck-scoped command can work on a component master instead.
 *   - A pure document edit (effects exactly `['doc']`) must: a master is a
 *     document like a deck, and an edit command that could not reach one
 *     would be a silent gap in what an agent can do to a master.
 */
export function commandTargetProblems(
  def: Pick<AnyCommandDef, 'scope' | 'effects' | 'acceptsComponent'>,
): string[] {
  const problems: string[] = []
  const scope = def.scope ?? 'deck'
  if (def.acceptsComponent === true && scope !== 'deck')
    problems.push(`acceptsComponent is for deck-scoped commands, but its scope is '${scope}'`)
  if (
    scope === 'deck' &&
    def.effects.length > 0 &&
    def.effects.every((e) => e === 'doc') &&
    def.acceptsComponent !== true
  )
    problems.push('a document edit must accept a component master too (acceptsComponent: true)')
  return problems
}

/**
 * Confirmation rules the host and the MCP surface rely on. Empty when `def`
 * is consistent; `register` refuses a command with any problem.
 *
 *   - A command whose input can make the server fetch a URL (it embeds the
 *     shared file source, `commandFetchesUrls`) must declare `confirmWhen`,
 *     so every URL fetch is confirmed naming its host (an exfiltration
 *     channel otherwise: the URL can carry whatever the model read).
 *   - A read-only command never asks: no `confirmWhen` either.
 *   - An irreversible command that only edits the document (effects exactly
 *     `['doc']`) must be `confirm: 'always'`. Document edits are the
 *     batchable kind, and a batch is one change applied without stopping to
 *     ask anyone — so such a command must be excluded from batches, which
 *     `confirm: 'always'` does (run.ts `isBatchable`), and must ask the user
 *     when it runs on its own.
 */
export function commandConfirmationProblems(
  def: Pick<AnyCommandDef, 'input' | 'effects' | 'undo' | 'confirm' | 'readOnly' | 'confirmWhen'>,
): string[] {
  const problems: string[] = []
  const conditional = typeof def.confirmWhen === 'function'
  if (def.readOnly === true && conditional)
    problems.push('read-only commands never ask the user; drop `confirmWhen`')
  if (!conditional && commandFetchesUrls(def))
    problems.push(
      'its input can make the server fetch a URL, so it must declare `confirmWhen` (see urlFetchConfirmation)',
    )
  if (
    def.undo === 'irreversible' &&
    def.effects.length > 0 &&
    def.effects.every((e) => e === 'doc') &&
    def.confirm !== 'always'
  )
    problems.push(
      "an irreversible document edit must be confirm: 'always' (it must never run unconfirmed inside a batch)",
    )
  return problems
}

export class CommandRegistry {
  private readonly byId = new Map<string, AnyCommandDef>()

  register(def: AnyCommandDef): this {
    if (!ID_PATTERN.test(def.id)) {
      throw new Error(`command id '${def.id}' must look like '<domain>.<verb>'`)
    }
    if (!def.id.startsWith(`${def.domain}.`)) {
      throw new Error(`command '${def.id}' must start with its domain '${def.domain}.'`)
    }
    const problems = [
      ...commandMetadataProblems(def),
      ...commandConfirmationProblems(def),
      ...commandTargetProblems(def),
    ]
    if (problems.length > 0) {
      throw new Error(`command '${def.id}' has inconsistent metadata: ${problems.join('; ')}`)
    }
    if (this.byId.has(def.id)) throw new Error(`command '${def.id}' is registered twice`)
    this.byId.set(def.id, def)
    return this
  }

  registerAll(defs: ReadonlyArray<AnyCommandDef>): this {
    for (const def of defs) this.register(def)
    return this
  }

  get(id: string): AnyCommandDef | undefined {
    return this.byId.get(id)
  }

  has(id: string): boolean {
    return this.byId.has(id)
  }

  /** All commands, sorted by id so every derived artifact is deterministic. */
  list(): AnyCommandDef[] {
    return [...this.byId.values()].sort((a, b) => a.id.localeCompare(b.id))
  }
}
