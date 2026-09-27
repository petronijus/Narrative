/**
 * services/errors.ts
 *
 * How a service fails. `ServiceError` IS a `CommandError` (so the command
 * runner and the MCP / batch hosts map it by `code` like any other command
 * failure) and additionally carries the HTTP status and JSON body the route
 * that shares the service answers with — the routes keep their exact
 * responses while the logic lives in one place.
 */

import type { FastifyReply } from 'fastify'
import { CommandError, type CommandErrorCode } from '@narrative/commands'

export class ServiceError extends CommandError {
  readonly status: number
  readonly body: Record<string, unknown>

  constructor(
    code: CommandErrorCode,
    status: number,
    message: string,
    extraBody: Record<string, unknown> = {},
  ) {
    super(code, message)
    this.name = 'ServiceError'
    this.status = status
    this.body = { error: message, ...extraBody }
  }
}

export const notFound = (message: string): ServiceError =>
  new ServiceError('not_found', 404, message)
export const forbidden = (message = 'Forbidden'): ServiceError =>
  new ServiceError('forbidden', 403, message)
export const badRequest = (message: string, extra?: Record<string, unknown>): ServiceError =>
  new ServiceError('invalid_input', 400, message, extra)
export const conflict = (message: string, extra?: Record<string, unknown>): ServiceError =>
  new ServiceError('conflict', 409, message, extra)
export const tooLarge = (message: string): ServiceError =>
  new ServiceError('invalid_input', 413, message)
export const unsupportedType = (message: string): ServiceError =>
  new ServiceError('invalid_input', 415, message)
export const unprocessable = (message: string, extra?: Record<string, unknown>): ServiceError =>
  new ServiceError('invalid_input', 422, message, extra)
export const failed = (message: string, status = 500): ServiceError =>
  new ServiceError('failed', status, message)

/**
 * Answer a route with a service failure. Anything that is not a
 * `ServiceError` is rethrown for Fastify's error handler (a 500).
 */
export function sendServiceError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof ServiceError) return reply.status(err.status).send(err.body)
  throw err
}
