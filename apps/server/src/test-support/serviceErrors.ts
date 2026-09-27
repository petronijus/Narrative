/**
 * test-support/serviceErrors.ts — await a service call that must fail and
 * return its ServiceError (status, code, message) for assertions.
 *
 * Excluded from the build (tsconfig.build.json: src/test-support/**).
 */

import { ServiceError } from '../services/errors.js'

export async function serviceErrorOf(p: Promise<unknown>): Promise<ServiceError> {
  try {
    await p
  } catch (e) {
    if (e instanceof ServiceError) return e
    throw e
  }
  throw new Error('expected the call to fail with a ServiceError')
}
