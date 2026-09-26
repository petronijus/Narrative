/**
 * commands/src/errors.ts
 *
 * Typed failures. Every host maps a `CommandError` to its transport (MCP
 * tool error, HTTP status) by `code`, so the codes are part of the public
 * contract — add, never repurpose.
 */

import type { z } from 'zod'

export type CommandErrorCode =
  | 'unknown_command'
  | 'invalid_input'
  | 'forbidden'
  | 'wrong_host'
  | 'no_target'
  | 'not_found'
  | 'conflict'
  | 'not_batchable'
  | 'failed'

export interface CommandIssue {
  path: ReadonlyArray<PropertyKey>
  message: string
}

export class CommandError extends Error {
  readonly code: CommandErrorCode
  readonly issues: readonly CommandIssue[]
  /** Index of the failing op when raised from a batch. */
  readonly opIndex: number | undefined

  constructor(
    code: CommandErrorCode,
    message: string,
    options: { issues?: readonly CommandIssue[]; opIndex?: number; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'CommandError'
    this.code = code
    this.issues = options.issues ?? []
    this.opIndex = options.opIndex
  }

  withOpIndex(opIndex: number): CommandError {
    return new CommandError(this.code, `op ${opIndex}: ${this.message}`, {
      issues: this.issues,
      opIndex,
      cause: this,
    })
  }
}

export function issuesFromZod(error: z.ZodError): CommandIssue[] {
  return error.issues.map((i) => ({ path: i.path, message: i.message }))
}

export function notFound(what: string, id: string): CommandError {
  return new CommandError('not_found', `${what} '${id}' does not exist`)
}
