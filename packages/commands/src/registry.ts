/**
 * commands/src/registry.ts
 *
 * `defineCommand` gives each definition full inference of its input/output
 * types; `CommandRegistry` is the lookup every host uses. The registry is
 * the capability source of truth (ADR 0010): the MCP tool list, the HTTP
 * batch API and the generated capability manifest are all derived from it.
 */

import type { z } from 'zod'
import type { CommandDef } from './types.js'

const ID_PATTERN = /^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*){1,3}$/

export function defineCommand<I extends z.ZodType, O extends z.ZodType>(
  def: CommandDef<I, O>,
): CommandDef<I, O> {
  return def
}

/** A registered command with its types erased, as hosts see it. */
export type AnyCommandDef = CommandDef<z.ZodType, z.ZodType>

export class CommandRegistry {
  private readonly byId = new Map<string, AnyCommandDef>()

  register(def: CommandDef<z.ZodType, z.ZodType>): this {
    if (!ID_PATTERN.test(def.id)) {
      throw new Error(`command id '${def.id}' must look like '<domain>.<verb>'`)
    }
    if (!def.id.startsWith(`${def.domain}.`)) {
      throw new Error(`command '${def.id}' must start with its domain '${def.domain}.'`)
    }
    if (this.byId.has(def.id)) throw new Error(`command '${def.id}' is registered twice`)
    this.byId.set(def.id, def)
    return this
  }

  registerAll(defs: ReadonlyArray<CommandDef<z.ZodType, z.ZodType>>): this {
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
