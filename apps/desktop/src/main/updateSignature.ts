/**
 * main/updateSignature.ts
 *
 * Whether a downloaded update is one Petr released (ADR 0015,
 * docs/plans/desktop-d0-spec.md §3.11). Every artefact in the update feed
 * comes with a manifest — its name, version and SHA-512 — signed with the
 * dedicated key held in 1Password ("Narrative desktop update signing key"),
 * as an SSH signature (`ssh-keygen -Y sign`, OpenSSH PROTOCOL.sshsig). The
 * shell pins that key's public half and installs nothing whose manifest it
 * cannot verify; HTTPS and the feed's own hashes come from the same server
 * as the file and prove nothing about who made it.
 *
 * Pure (node:crypto only): tested with keys `ssh-keygen` makes in the test.
 */

import { createHash, createPublicKey, verify } from 'node:crypto'

export const UPDATE_NAMESPACE = 'narrative-desktop-update'
const MAGIC = Buffer.from('SSHSIG')
const ARMOR_BEGIN = '-----BEGIN SSH SIGNATURE-----'
const ARMOR_END = '-----END SSH SIGNATURE-----'

/** The signed statement about one artefact. */
export function buildManifest(file: string, version: string, sha512Hex: string): string {
  return `narrative-desktop-update v1\nfile ${file}\nversion ${version}\nsha512 ${sha512Hex}\n`
}

class Reader {
  private offset = 0
  constructor(private readonly buf: Buffer) {}
  bytes(n: number): Buffer {
    if (n < 0 || this.offset + n > this.buf.length) throw new Error('truncated')
    const out = this.buf.subarray(this.offset, this.offset + n)
    this.offset += n
    return out
  }
  uint32(): number {
    return this.bytes(4).readUInt32BE(0)
  }
  string(): Buffer {
    return this.bytes(this.uint32())
  }
  get done(): boolean {
    return this.offset === this.buf.length
  }
}

function sshString(value: Buffer | string): Buffer {
  const body = typeof value === 'string' ? Buffer.from(value, 'utf8') : value
  const len = Buffer.alloc(4)
  len.writeUInt32BE(body.length, 0)
  return Buffer.concat([len, body])
}

/** The wire form of an `ssh-ed25519 AAAA…` public key line. */
export function parsePublicKeyLine(line: string): Buffer {
  const [type, b64] = line.trim().split(/\s+/)
  if (type !== 'ssh-ed25519' || b64 === undefined) throw new Error('not an ssh-ed25519 key')
  const blob = Buffer.from(b64, 'base64')
  const r = new Reader(blob)
  if (r.string().toString() !== 'ssh-ed25519' || r.string().length !== 32 || !r.done) {
    throw new Error('malformed ssh-ed25519 key')
  }
  return blob
}

interface ParsedSignature {
  publicKey: Buffer
  namespace: string
  hashAlgorithm: string
  signature: Buffer
}

function parseArmored(armored: string): ParsedSignature {
  const text = armored.trim()
  if (!text.startsWith(ARMOR_BEGIN) || !text.endsWith(ARMOR_END)) throw new Error('no armor')
  const b64 = text.slice(ARMOR_BEGIN.length, text.length - ARMOR_END.length).replace(/\s+/g, '')
  const r = new Reader(Buffer.from(b64, 'base64'))
  if (!r.bytes(6).equals(MAGIC)) throw new Error('no SSHSIG magic')
  if (r.uint32() !== 1) throw new Error('unknown SSHSIG version')
  const publicKey = r.string()
  const namespace = r.string().toString('utf8')
  r.string() // reserved
  const hashAlgorithm = r.string().toString('utf8')
  const sigBlob = new Reader(r.string())
  if (!r.done) throw new Error('trailing data')
  if (sigBlob.string().toString() !== 'ssh-ed25519') throw new Error('not an Ed25519 signature')
  const signature = sigBlob.string()
  if (signature.length !== 64 || !sigBlob.done) throw new Error('malformed signature')
  return { publicKey, namespace, hashAlgorithm, signature }
}

/**
 * Whether `armored` is a valid signature of `message` by `publicKeyLine`
 * in the update namespace. Never throws: anything malformed is false.
 */
export function verifyUpdateSignature(
  message: string,
  armored: string,
  publicKeyLine: string,
): boolean {
  try {
    const pinned = parsePublicKeyLine(publicKeyLine)
    const sig = parseArmored(armored)
    if (!sig.publicKey.equals(pinned)) return false
    if (sig.namespace !== UPDATE_NAMESPACE || sig.hashAlgorithm !== 'sha512') return false
    const keyReader = new Reader(pinned)
    keyReader.string()
    const raw = keyReader.string()
    const key = createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: raw.toString('base64url') },
      format: 'jwk',
    })
    const signed = Buffer.concat([
      MAGIC,
      sshString(UPDATE_NAMESPACE),
      sshString(''),
      sshString('sha512'),
      sshString(createHash('sha512').update(message, 'utf8').digest()),
    ])
    return verify(null, signed, key, sig.signature)
  } catch {
    return false
  }
}
