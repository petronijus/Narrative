import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildEnv, clientEnvFiles } from './webBuild.js'

describe('the client variables of a perf build', () => {
  it("reads only VITE_* from the env files, in Vite's order", () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'perf-env-'))
    writeFileSync(path.join(dir, '.env'), 'VITE_BYPASS_AUTH=true\nVITE_A=env\nSECRET=x\n')
    writeFileSync(path.join(dir, '.env.local'), 'VITE_A=local\n')
    writeFileSync(path.join(dir, '.env.production'), 'VITE_A=mode\nVITE_B=mode\n')
    writeFileSync(path.join(dir, '.env.profiling'), 'VITE_B=other-mode\n')
    expect(clientEnvFiles(dir, 'production')).toEqual({
      VITE_BYPASS_AUTH: 'true',
      VITE_A: 'mode',
      VITE_B: 'mode',
    })
  })

  it("gives the process's own variables and the production endpoints precedence", () => {
    const env = buildEnv(
      { VITE_A: 'process', VITE_API_URL: 'http://x' },
      { VITE_A: 'file', VITE_BYPASS_AUTH: 'true', VITE_API_URL: 'http://file' },
    )
    expect(env['VITE_A']).toBe('process')
    expect(env['VITE_BYPASS_AUTH']).toBe('true')
    expect(env['VITE_API_URL']).toBe('/api')
    expect(env['NODE_ENV']).toBe('production')
  })
})
