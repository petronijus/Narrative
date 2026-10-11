/**
 * scripts/sign-release.mjs
 *
 * Sign the desktop app's release artefacts (ADR 0014,
 * docs/plans/desktop-d0-spec.md §3.11). For every file it writes
 * `<file>.manifest` — name, version, SHA-512 — and `<file>.manifest.sig`, an
 * SSH signature of that manifest (`ssh-keygen -Y sign`, namespace
 * narrative-desktop-update) made through an SSH agent: by default the
 * 1Password agent, which holds "Narrative desktop update signing key" and
 * asks Petr to approve each signature. The private key never reaches this
 * process, the disk or the shell history. The shell verifies the signature
 * against the public key pinned in servers.json before it installs anything.
 *
 *   node scripts/sign-release.mjs <artefact>…
 *     [--agent <socket>]       default: the 1Password agent of this OS
 *     [--public-key <line>]    default: servers.json updatePublicKey
 *     [--version <x.y.z>]      default: package.json version
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  createReadStream,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const NAMESPACE = 'narrative-desktop-update'

/** The 1Password SSH agent's socket on this OS. */
function onePasswordAgent() {
  return process.platform === 'darwin'
    ? path.join(os.homedir(), 'Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock')
    : path.join(os.homedir(), '.1password/agent.sock')
}

/**
 * @param {string[]} argv
 * @returns {{ files: string[], agent: string, publicKey: string | null, version: string | null }}
 */
function parseArgs(argv) {
  /** @type {{ files: string[], agent: string, publicKey: string | null, version: string | null }} */
  const opts = { files: [], agent: onePasswordAgent(), publicKey: null, version: null }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? ''
    const value = () => {
      const next = argv[++i]
      if (next === undefined) throw new Error(`${arg} needs a value`)
      return next
    }
    if (arg === '--agent') opts.agent = value()
    else if (arg === '--public-key') opts.publicKey = value()
    else if (arg === '--version') opts.version = value()
    else if (arg.startsWith('--')) throw new Error(`unknown option ${arg}`)
    else opts.files.push(path.resolve(arg))
  }
  return opts
}

/**
 * @param {string} file
 * @returns {Promise<string>}
 */
function sha512(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha512')
    createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', reject)
  })
}

const opts = parseArgs(process.argv.slice(2))
if (opts.files.length === 0) {
  console.error('sign-release: name the artefacts to sign')
  process.exit(2)
}
const readJson = (/** @type {string} */ file) =>
  JSON.parse(readFileSync(path.join(root, file), 'utf8'))
const publicKey = opts.publicKey ?? readJson('servers.json').updatePublicKey
const version = opts.version ?? readJson('package.json').version
if (!existsSync(opts.agent)) {
  console.error(`sign-release: no SSH agent at ${opts.agent} (is 1Password's SSH agent on?)`)
  process.exit(1)
}

const scratch = mkdtempSync(path.join(os.tmpdir(), 'narrative-sign-'))
try {
  const keyFile = path.join(scratch, 'update.pub')
  writeFileSync(keyFile, `${publicKey}\n`)
  for (const file of opts.files) {
    const manifest = `narrative-desktop-update v1\nfile ${path.basename(file)}\nversion ${version}\nsha512 ${await sha512(file)}\n`
    const manifestFile = `${file}.manifest`
    writeFileSync(manifestFile, manifest)
    rmSync(`${manifestFile}.sig`, { force: true })
    execFileSync('ssh-keygen', ['-q', '-Y', 'sign', '-n', NAMESPACE, '-f', keyFile, manifestFile], {
      env: { ...process.env, SSH_AUTH_SOCK: opts.agent },
      stdio: ['ignore', 'inherit', 'inherit'],
    })
    console.log(`signed ${path.basename(file)}`)
  }
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
