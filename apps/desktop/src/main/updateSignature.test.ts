/**
 * The update signature check against real `ssh-keygen -Y sign` output,
 * with throwaway keys made here (never the 1Password key).
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  UPDATE_NAMESPACE,
  buildManifest,
  parsePublicKeyLine,
  verifyUpdateSignature,
} from './updateSignature.js'

let dir: string
let publicKey: string
let otherKey: string

function keygen(name: string): string {
  const file = path.join(dir, name)
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', '', '-f', file])
  return readFileSync(`${file}.pub`, 'utf8').trim()
}

function sign(message: string, key = 'release', namespace = UPDATE_NAMESPACE): string {
  const file = path.join(dir, `msg-${Math.abs(hash(message + key + namespace))}`)
  writeFileSync(file, message)
  execFileSync('ssh-keygen', ['-q', '-Y', 'sign', '-n', namespace, '-f', path.join(dir, key), file])
  return readFileSync(`${file}.sig`, 'utf8')
}

const hash = (s: string): number => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7)

const manifest = buildManifest('narrative-1.2.3-linux-x86_64.AppImage', '1.2.3', 'ab'.repeat(64))

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'narrative-sshsig-'))
  publicKey = keygen('release')
  otherKey = keygen('other')
})
afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('update signatures', () => {
  it('accepts a manifest signed with the pinned key', () => {
    expect(verifyUpdateSignature(manifest, sign(manifest), publicKey)).toBe(true)
  })

  it('refuses a changed manifest: another file, version or hash', () => {
    const signature = sign(manifest)
    for (const changed of [
      buildManifest('narrative-1.2.3-linux-x86_64.AppImage.evil', '1.2.3', 'ab'.repeat(64)),
      buildManifest('narrative-1.2.3-linux-x86_64.AppImage', '1.2.4', 'ab'.repeat(64)),
      buildManifest('narrative-1.2.3-linux-x86_64.AppImage', '1.2.3', 'cd'.repeat(64)),
    ]) {
      expect(verifyUpdateSignature(changed, signature, publicKey)).toBe(false)
    }
  })

  it('refuses another key, another namespace and a damaged signature', () => {
    expect(verifyUpdateSignature(manifest, sign(manifest, 'other'), publicKey)).toBe(false)
    expect(verifyUpdateSignature(manifest, sign(manifest), otherKey)).toBe(false)
    expect(verifyUpdateSignature(manifest, sign(manifest, 'release', 'git'), publicKey)).toBe(false)
    const armored = sign(manifest)
    const lines = armored.trim().split('\n')
    const truncated = [...lines.slice(0, 2), ...lines.slice(-1)].join('\n')
    expect(verifyUpdateSignature(manifest, truncated, publicKey)).toBe(false)
    // One character of the last body line (the signature's own bytes).
    const body = lines.slice(1, -1)
    const last = body.at(-1)!
    const swapped = last.slice(0, 4) + (last[4] === 'A' ? 'B' : 'A') + last.slice(5)
    const flipped = [lines[0], ...body.slice(0, -1), swapped, lines.at(-1)].join('\n')
    expect(flipped).not.toBe(armored.trim())
    expect(verifyUpdateSignature(manifest, flipped, publicKey)).toBe(false)
    expect(verifyUpdateSignature(manifest, '', publicKey)).toBe(false)
  })

  it('reads only ssh-ed25519 public keys', () => {
    expect(parsePublicKeyLine(publicKey).length).toBe(51)
    expect(() => parsePublicKeyLine('ssh-rsa AAAAB3NzaC1yc2E=')).toThrow()
  })
})
