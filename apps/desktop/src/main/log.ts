/**
 * main/log.ts
 *
 * The shell's log: JSON lines in `<logs>/main.log`, rotated at 5 MB (one
 * previous file kept), mirrored to stderr when unpackaged. Every string is
 * masked first: a sign-in link, a ticket or a verifier never reaches the
 * file (security review of D0 steps 2–4, M2c).
 */

import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import path from 'node:path'

export const LOG_ROTATE_BYTES = 5 * 1024 * 1024
const MASK = '***'

/** Mask Narrative credentials and sign-in parameters in `value`. */
export function maskSecrets(value: string): string {
  return (
    value
      // Any Narrative credential by its prefix (apps/server/src/auth/credentialPatterns.ts).
      .replace(/\b(nrt|nmo|nmr|nmc|nms|nus|nrr|ndt)_[A-Za-z0-9_-]+/g, `$1_${MASK}`)
      // Query or form values that are secrets without a prefix.
      .replace(
        /\b((?:code_)?verifier|state|desktop_state|ticket|share_token)=[^&#\s"']*/g,
        `$1=${MASK}`,
      )
  )
}

function maskDeep(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return maskSecrets(value)
  if (depth > 8 || value === null || typeof value !== 'object') return value
  if (value instanceof Error) {
    return {
      name: value.name,
      message: maskSecrets(value.message),
      stack: maskSecrets(value.stack ?? ''),
    }
  }
  if (Array.isArray(value)) return value.map((v) => maskDeep(v, depth + 1))
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, maskDeep(v, depth + 1)]))
}

export type LogLevel = 'info' | 'warn' | 'error'

export interface Logger {
  info(message: string, fields?: Record<string, unknown>): void
  warn(message: string, fields?: Record<string, unknown>): void
  error(message: string, fields?: Record<string, unknown>): void
}

/** A logger writing to `<dir>/main.log`. */
export function createLogger(dir: string, opts: { mirror: boolean }): Logger {
  const file = path.join(dir, 'main.log')
  let ready = false
  const write = (level: LogLevel, message: string, fields?: Record<string, unknown>): void => {
    const line = `${JSON.stringify({
      time: new Date().toISOString(),
      level,
      message: maskSecrets(message),
      ...(fields ? (maskDeep(fields) as Record<string, unknown>) : {}),
    })}\n`
    if (opts.mirror) process.stderr.write(line)
    try {
      if (!ready) {
        mkdirSync(dir, { recursive: true })
        ready = true
      }
      let size = 0
      try {
        size = statSync(file).size
      } catch {
        size = 0
      }
      if (size + line.length > LOG_ROTATE_BYTES) renameSync(file, `${file}.1`)
      appendFileSync(file, line, { mode: 0o600 })
    } catch {
      // A log that cannot be written must never take the app down.
    }
  }
  return {
    info: (m, f) => write('info', m, f),
    warn: (m, f) => write('warn', m, f),
    error: (m, f) => write('error', m, f),
  }
}
