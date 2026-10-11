import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import servers from '../../servers.json'
import { UPDATE_NAMESPACE, buildManifest, parsePublicKeyLine } from './updateSignature.js'
import { verifyDownloadedUpdate, type VerifyDeps } from './updateVerify.js'

const FEED = 'https://narrative.example.com/desktop/'
const NAME = 'narrative-1.2.3-linux-x86_64.AppImage'
let dir: string
let publicKey: string
let file: string
let signature: string

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'narrative-verify-'))
  const key = path.join(dir, 'key')
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', '', '-f', key])
  publicKey = readFileSync(`${key}.pub`, 'utf8').trim()
  file = path.join(dir, NAME)
  writeFileSync(file, 'release bytes')
  const manifestFile = path.join(dir, 'manifest')
  const sha = createHash('sha512').update('release bytes').digest('hex')
  writeFileSync(manifestFile, buildManifest(NAME, '1.2.3', sha))
  execFileSync('ssh-keygen', ['-q', '-Y', 'sign', '-n', UPDATE_NAMESPACE, '-f', key, manifestFile])
  signature = readFileSync(`${manifestFile}.sig`, 'utf8')
})
afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

function deps(sig: string | null = signature): VerifyDeps & { asked: string[] } {
  const asked: string[] = []
  return {
    feedBase: FEED,
    publicKey,
    asked,
    fetchText: async (url) => {
      asked.push(url)
      return sig
    },
  }
}

const update = (over: Partial<{ downloadedFile: string; version: string }> = {}) => ({
  downloadedFile: file,
  version: '1.2.3',
  files: [{ url: NAME }],
  ...over,
})

describe('verifying a downloaded update', () => {
  it('accepts the signed release, fetching its signature from the feed', async () => {
    const d = deps()
    expect(await verifyDownloadedUpdate(update(), d)).toEqual({ ok: true })
    expect(d.asked).toEqual([`${FEED}${NAME}.manifest.sig`])
  })

  it('refuses a missing signature, another version, changed bytes and a foreign file', async () => {
    expect((await verifyDownloadedUpdate(update(), deps(null))).ok).toBe(false)
    expect((await verifyDownloadedUpdate(update({ version: '1.2.4' }), deps())).ok).toBe(false)
    const tampered = path.join(dir, 'tampered', NAME)
    execFileSync('mkdir', ['-p', path.dirname(tampered)])
    writeFileSync(tampered, 'evil bytes')
    expect((await verifyDownloadedUpdate(update({ downloadedFile: tampered }), deps())).ok).toBe(
      false,
    )
    const other = path.join(dir, 'other.AppImage')
    writeFileSync(other, 'release bytes')
    expect(await verifyDownloadedUpdate(update({ downloadedFile: other }), deps())).toEqual({
      ok: false,
      reason: 'not a file of this release',
    })
  })

  it('pins a real ssh-ed25519 key in servers.json', () => {
    expect(parsePublicKeyLine(servers.updatePublicKey).length).toBe(51)
  })
})
