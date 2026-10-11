import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LOG_ROTATE_BYTES, createLogger, maskSecrets } from './log.js'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'narrative-log-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('log', () => {
  it('masks a sign-in link, its ticket and state', () => {
    const link = `narrative://auth/complete?ticket=ndt_${'a'.repeat(43)}&state=${'b'.repeat(43)}`
    expect(maskSecrets(link)).toBe('narrative://auth/complete?ticket=***&state=***')
  })

  it('masks credentials by prefix and verifiers in a form body', () => {
    expect(maskSecrets(`token nrt_${'x'.repeat(43)} here`)).toBe('token nrt_*** here')
    expect(maskSecrets(`ticket=ndt_x&verifier=${'v'.repeat(43)}`)).toBe('ticket=***&verifier=***')
  })

  it('writes masked JSON lines, fields included', () => {
    const log = createLogger(dir, { mirror: false })
    log.warn('deep link ignored', { url: 'narrative://auth/complete?ticket=ndt_abc&state=s' })
    const line = JSON.parse(readFileSync(path.join(dir, 'main.log'), 'utf8').trim())
    expect(line).toMatchObject({ level: 'warn', message: 'deep link ignored' })
    expect(line.url).toBe('narrative://auth/complete?ticket=***&state=***')
  })

  it('rotates past the size limit', () => {
    const log = createLogger(dir, { mirror: false })
    const big = 'x'.repeat(64 * 1024)
    for (let i = 0; i < LOG_ROTATE_BYTES / big.length + 2; i++) log.info(big)
    expect(statSync(path.join(dir, 'main.log.1')).size).toBeGreaterThan(0)
    expect(statSync(path.join(dir, 'main.log')).size).toBeLessThanOrEqual(LOG_ROTATE_BYTES)
  })
})
