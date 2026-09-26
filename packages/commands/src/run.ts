/**
 * commands/src/run.ts
 *
 * The one way to execute a command. Every host — the editor UI, the MCP
 * server, the HTTP batch API — goes through `runCommand` / `runCommandSync`
 * / `runBatch`, so validation, role checks, host checks and transaction
 * attribution are enforced in one place instead of per call site.
 */

import * as Y from 'yjs'
import type { DeckMutationContext } from '@narrative/slide-model'
import type { AnyCommandDef, CommandRegistry } from './registry.js'
import { CommandError, issuesFromZod } from './errors.js'
import { ROLE_RANK, type CommandContext, type CommandInvocation } from './types.js'

interface Prepared {
  def: AnyCommandDef
  input: unknown
}

/** Look up, authorise and validate an invocation. Never writes. */
function prepare(
  registry: CommandRegistry,
  ctx: CommandContext,
  commandId: string,
  rawInput: unknown,
): Prepared {
  const def = registry.get(commandId)
  if (def === undefined) throw new CommandError('unknown_command', `unknown command '${commandId}'`)
  if (!def.hosts.includes(ctx.host)) {
    throw new CommandError(
      'wrong_host',
      `command '${commandId}' cannot run on the ${ctx.host} host (runs on: ${def.hosts.join(', ')})`,
    )
  }
  if (ROLE_RANK[ctx.actor.role] < ROLE_RANK[def.role]) {
    throw new CommandError(
      'forbidden',
      `command '${commandId}' needs the ${def.role} role; the caller is ${ctx.actor.role}`,
    )
  }
  const parsed = def.input.safeParse(rawInput)
  if (!parsed.success) {
    throw new CommandError('invalid_input', `invalid input for '${commandId}'`, {
      issues: issuesFromZod(parsed.error),
    })
  }
  if (def.effects.includes('doc') && ctx.deck === undefined) {
    throw new CommandError('no_target', `command '${commandId}' needs a target deck document`)
  }
  return { def, input: parsed.data }
}

function finish(def: AnyCommandDef, raw: unknown): unknown {
  // Outputs are validated too: they are the contract agents program against,
  // and a handler that drifts from its declared output is a bug to surface
  // here rather than in a client.
  const parsed = def.output.safeParse(raw)
  if (!parsed.success) {
    throw new CommandError(
      'failed',
      `command '${def.id}' produced output that violates its schema`,
      {
        issues: issuesFromZod(parsed.error),
      },
    )
  }
  return parsed.data
}

function executeSync(def: AnyCommandDef, ctx: CommandContext, input: unknown): unknown {
  const invoke = (): unknown => {
    const result = def.handler(ctx, input)
    if (result instanceof Promise) {
      throw new CommandError(
        'failed',
        `command '${def.id}' is asynchronous and cannot run synchronously`,
      )
    }
    return result
  }
  if (ctx.deck === undefined || def.transaction === 'self') return finish(def, invoke())
  let raw: unknown
  ctx.deck.doc.transact(() => {
    raw = invoke()
  }, ctx.origin)
  return finish(def, raw)
}

/**
 * Run a synchronous (document) command. The UI uses this so it can act on
 * the result immediately (e.g. select the copies a duplicate returned).
 * Throws `CommandError`.
 */
export function runCommandSync(
  registry: CommandRegistry,
  ctx: CommandContext,
  commandId: string,
  rawInput: unknown,
): unknown {
  const { def, input } = prepare(registry, ctx, commandId, rawInput)
  return executeSync(def, ctx, input)
}

/** Run any command, synchronous or not. Throws (rejects with) `CommandError`. */
export async function runCommand(
  registry: CommandRegistry,
  ctx: CommandContext,
  commandId: string,
  rawInput: unknown,
): Promise<unknown> {
  const { def, input } = prepare(registry, ctx, commandId, rawInput)
  if (def.effects.includes('doc') || def.transaction === 'self') return executeSync(def, ctx, input)
  return finish(def, await def.handler(ctx, input))
}

function isBatchable(def: AnyCommandDef): boolean {
  return def.transaction !== 'self' && def.effects.every((e) => e === 'doc')
}

export interface BatchResult {
  results: unknown[]
}

/**
 * Run several document commands as ONE change.
 *
 * `atomic: true` (default): every input is validated first; the ops then
 * run on a FORK of the deck document, and only if all of them succeed is
 * the fork's delta applied to the live document — in one transaction with
 * `ctx.origin`, so it is one undo step and one update on the wire. A
 * failure anywhere leaves the live document untouched. The fork reuses the
 * live document's clientID so its clock simply continues the live one; the
 * whole batch is synchronous, so nothing can interleave between fork and
 * apply, and a failed fork is discarded before its clock is ever published.
 *
 * `atomic: false`: ops run in order in one live transaction; a failing op is
 * reported and skipped, earlier ops stay applied.
 */
export function runBatch(
  registry: CommandRegistry,
  ctx: CommandContext,
  ops: ReadonlyArray<CommandInvocation>,
  options: { atomic?: boolean } = {},
): BatchResult {
  const atomic = options.atomic ?? true
  const prepared = ops.map((op, i) => {
    try {
      const p = prepare(registry, ctx, op.command, op.input)
      if (!isBatchable(p.def)) {
        throw new CommandError(
          'not_batchable',
          `command '${op.command}' touches more than the deck document and cannot run in a batch`,
        )
      }
      return p
    } catch (e) {
      throw e instanceof CommandError ? e.withOpIndex(i) : e
    }
  })
  const live = ctx.deck
  if (live === undefined) {
    if (prepared.length === 0) return { results: [] }
    throw new CommandError('no_target', 'a batch needs a target deck document')
  }

  if (!atomic) {
    const results: unknown[] = []
    live.doc.transact(() => {
      prepared.forEach(({ def, input }, i) => {
        try {
          results.push(executeSync(def, ctx, input))
        } catch (e) {
          const err =
            e instanceof CommandError ? e : new CommandError('failed', String(e), { cause: e })
          results.push({ error: { code: err.code, message: err.withOpIndex(i).message } })
        }
      })
    }, ctx.origin)
    return { results }
  }

  const stateVector = Y.encodeStateVector(live.doc)
  const fork = new Y.Doc({ gc: live.doc.gc })
  fork.clientID = live.doc.clientID
  Y.applyUpdate(fork, Y.encodeStateAsUpdate(live.doc))
  const forkDeck: DeckMutationContext = {
    doc: fork,
    slides: fork.getArray<Y.Map<unknown>>('slides'),
  }
  const forkCtx: CommandContext = { ...ctx, deck: forkDeck }
  const results: unknown[] = []
  try {
    fork.transact(() => {
      prepared.forEach(({ def, input }, i) => {
        try {
          results.push(executeSync(def, forkCtx, input))
        } catch (e) {
          throw e instanceof CommandError
            ? e.withOpIndex(i)
            : new CommandError('failed', String(e), { cause: e, opIndex: i })
        }
      })
    })
    const delta = Y.encodeStateAsUpdate(fork, stateVector)
    Y.applyUpdate(live.doc, delta, ctx.origin)
  } finally {
    fork.destroy()
  }
  return { results }
}
