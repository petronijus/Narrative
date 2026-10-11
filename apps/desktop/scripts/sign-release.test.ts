/**
 * scripts/sign-release.test.ts
 *
 * The release signer against a throwaway ssh-agent and key (never the
 * 1Password one): what it writes is what the shell verifies.
 */

import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildManifest, verifyUpdateSignature } from '../src/main/updateSignature.js'
import { createHash } from 'node:crypto'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
let dir: string
let agent: ChildProcess
let sock: string
let publicKey: string

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'narrative-signer-'))
  sock = path.join(dir, 'agent.sock')
  agent = spawn('ssh-agent', ['-D', '-a', sock], { stdio: 'ignore' })
  for (let i = 0; i < 50; i++) {
    try {
      execFileSync('ssh-add', ['-l'], {
        env: { ...process.env, SSH_AUTH_SOCK: sock },
        stdio: 'ignore',
      })
      break
    } catch (err) {
      // Exit 1 = the agent answers but holds no key yet: it is up.
      if ((err as { status?: number }).status === 1) break
      await new Promise((r) => setTimeout(r, 50))
    }
  }
  const key = path.join(dir, 'key')
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', '', '-f', key])
  execFileSync('ssh-add', ['-q', key], { env: { ...process.env, SSH_AUTH_SOCK: sock } })
  publicKey = readFileSync(`${key}.pub`, 'utf8').trim()
}, 30_000)

afterAll(() => {
  agent.kill()
  rmSync(dir, { recursive: true, force: true })
})

describe('sign-release', () => {
  it('signs a manifest the shell accepts, through the agent', () => {
    const artefact = path.join(dir, 'narrative-9.9.9-linux-x86_64.AppImage')
    writeFileSync(artefact, 'the app')
    execFileSync(
      process.execPath,
      [
        'scripts/sign-release.mjs',
        artefact,
        '--agent',
        sock,
        '--public-key',
        publicKey,
        '--version',
        '9.9.9',
      ],
      { cwd: root, stdio: 'ignore' },
    )
    const sha = createHash('sha512').update('the app').digest('hex')
    const manifest = buildManifest(path.basename(artefact), '9.9.9', sha)
    expect(readFileSync(`${artefact}.manifest`, 'utf8')).toBe(manifest)
    const signature = readFileSync(`${artefact}.manifest.sig`, 'utf8')
    expect(verifyUpdateSignature(manifest, signature, publicKey)).toBe(true)
  })

  it('refuses without an agent', () => {
    expect(() =>
      execFileSync(
        process.execPath,
        ['scripts/sign-release.mjs', path.join(dir, 'x'), '--agent', path.join(dir, 'none.sock')],
        { cwd: root, stdio: 'ignore' },
      ),
    ).toThrow()
  })
})
