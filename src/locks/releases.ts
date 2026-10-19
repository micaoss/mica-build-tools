// Pinned releases against what GitHub serves (docs/spec/build-rules.md section 1; release-lock.md section 4 and 7):
// `locks verify`, `locks move` and `local-lock`. Downloads are anonymous.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { Refused, ToolError } from '../errors.ts'
import { git } from '../process.ts'
import { checkLock, type Lock } from './lock.ts'
import { checkLocks, checkPins, modeOf } from './pins.ts'
import { latestRelease } from '../release/latest.ts'
import { REFERENCE, RELEASE, REPOSITORY, SCOPE, SCOPED, partition, rpartition } from './rules.ts'

const RELEASES = 'https://github.com/micaoss/{repository}/releases/download/{release}/'

/** Where a release's assets are downloaded from; MICA_RELEASES_URL replaces the GitHub form (tests). */
export function assetBase(repository: string, tag: string, env: NodeJS.ProcessEnv = process.env): string {
  return (env.MICA_RELEASES_URL ?? RELEASES).replace('{repository}', repository).replace('{release}', tag)
}

function sha256(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex')
}

async function download(url: string): Promise<Uint8Array> {
  const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(120000) })
  if (!response.ok) throw new ToolError(`${url}: HTTP ${response.status}`)
  return new Uint8Array(await response.arrayBuffer())
}

/** The entries of a SHA256SUMS: `<sha256>  <file>` lines, nothing else. */
export function parseSums(text: string): [string, string][] {
  return text.split('\n').filter(l => l !== '').map((line) => {
    const m = /^([0-9a-f]{64}) [ *](.+)$/.exec(line)
    if (m === null) throw new ToolError(`'${line}' is not a SHA256SUMS line`)
    return [m[1]!, m[2]!]
  })
}

/** A release's tag: the scope, a dot and the release for a scoped repository. */
function tagOf(scope: string, release: string): string {
  return scope ? `${scope}.${release}` : release
}

/** Verifies the assets of one release: SHA256SUMS hashes to `trust` (when given), lists exactly the lock, and the lock matches. */
async function fetchRelease(repository: string, tag: string, trust?: string): Promise<{ sums: Uint8Array, lock: Uint8Array }> {
  const base = assetBase(repository, tag)
  const sums = await download(base + 'SHA256SUMS')
  if (trust !== undefined && sha256(sums) !== trust)
    throw new ToolError(`the SHA256SUMS of ${repository} ${tag} hashes to ${sha256(sums)}, and the pin records ${trust}`)
  const listed = parseSums(new TextDecoder().decode(sums))
  if (listed.length !== 1 || listed[0]![1] !== `${repository}.lock`)
    throw new ToolError(`the SHA256SUMS of ${repository} ${tag} does not list exactly ${repository}.lock`)
  const lock = await download(base + `${repository}.lock`)
  if (sha256(lock) !== listed[0]![0]) throw new ToolError(`${repository}.lock of ${repository} ${tag} does not hash to its SHA256SUMS line`)
  return { sums, lock }
}

/** `locks verify`: every pinned lock is its release's asset. Returns one line per input. */
export async function verifyLocks(locks: string): Promise<string[]> {
  const lines: string[] = []
  for (const input of checkLocks(locks, 'ci')) {
    const { pin, lock, name } = input
    const { lock: served } = await fetchRelease(pin.REPOSITORY!, tagOf(lock.scope, lock.release), pin.SHA256SUMS!)
    if (Buffer.compare(Buffer.from(served), readFileSync(join(locks, `${name}.lock`))) !== 0)
      throw new ToolError(`the ${pin.REPOSITORY}.lock of ${pin.REPOSITORY} ${tagOf(lock.scope, lock.release)} is not locks/${name}.lock as committed`)
    lines.push(`${name} ${pin.RELEASE}: SHA256SUMS ${pin.SHA256SUMS} lists locks/${name}.lock, verified`)
  }
  return lines
}

function pinText(repository: string, scope: string, release: string, sums: string, checkout?: string): string {
  return '# mica-pin v1\n' + `REPOSITORY=${repository}\n` + (scope ? `SCOPE=${scope}\n` : '') + `RELEASE=${release}\n`
    + `SHA256SUMS=${sums}\n` + (checkout === undefined ? '' : `CHECKOUT=${checkout}\n`)
}

/** Writes a lock and its pin together, each by rename, and touches no other file. */
function writePair(locks: string, name: string, lock: Uint8Array, pin: string): void {
  mkdirSync(join(locks, 'pins'), { recursive: true })
  writeFileSync(join(locks, `.${name}.lock.new`), lock)
  writeFileSync(join(locks, 'pins', `.${name}.pin.new`), pin)
  renameSync(join(locks, `.${name}.lock.new`), join(locks, `${name}.lock`))
  renameSync(join(locks, 'pins', `.${name}.pin.new`), join(locks, 'pins', `${name}.pin`))
}

function splitInput(input: string): { repository: string, scope: string } {
  const [repository, scope] = partition(input, '.')
  if (!REPOSITORY.test(repository) || (scope !== '' && !SCOPE.test(scope)))
    throw new ToolError(`'${input}' is not <repository>[.<scope>]`)
  if ((scope !== '') !== SCOPED.has(repository)) throw new Refused('release-scope', input)
  return { repository, scope }
}

/** Checks a downloaded or offline lock and that its release row is the one asked for. */
function lockFor(path: string, repository: string, scope: string, release: string): Lock {
  let lock: Lock
  try {
    lock = checkLock(path)
  }
  catch (e) {
    if (e instanceof Refused) throw new Refused('lock-invalid', `${path}: ${e.rule}${e.detail ? ` ${e.detail}` : ''}`)
    throw e
  }
  if (lock.repository !== repository) throw new Refused('lock-invalid', `${path} names ${lock.repository}`)
  if (lock.scope !== scope) throw new Refused('scope-mismatch', `${path} names the scope '${lock.scope}'`)
  if (lock.release !== release) throw new Refused('release-mismatch', `${path} names the release ${lock.release}`)
  return lock
}

/** A release of an input, downloaded and verified, not yet written. */
export type Move = { input: string, repository: string, tag: string, release: string, lock: Uint8Array, pin: string, sums: string }

/** The latest release of an input that carries its lock: the one a move takes when none is named. */
export async function latestOf(input: string): Promise<string> {
  const { repository, scope } = splitInput(input)
  const tag = await latestRelease(repository, { asset: `${repository}.lock`, scope })
  if (tag === undefined) throw new ToolError(`${repository} has no published release carrying ${repository}.lock${scope ? ` for ${scope}` : ''}`)
  const release = rpartition(tag, '.')[1]
  if (tag !== tagOf(scope, release)) throw new ToolError(`the latest release of ${input} is ${tag}, in the <scope>/<release> form, which a lock does not carry`)
  return release
}

/** One input at a release (the latest carrying its lock when none is named), downloaded and verified. */
export async function resolveMove(locks: string, input: string, named?: string): Promise<Move> {
  const { repository, scope } = splitInput(input)
  if (named !== undefined && !RELEASE.test(named)) throw new ToolError(`'${named}' is not <YYYYMMDD-HHMM>`)
  const release = named ?? await latestOf(input)
  const tag = tagOf(scope, release)
  const { sums, lock } = await fetchRelease(repository, tag)
  // Checked from a scratch directory, so that resolving writes nothing under locks/.
  const scratch = mkdtempSync(join(tmpdir(), 'mica-lock-'))
  try {
    writeFileSync(join(scratch, `${input}.lock`), lock)
    lockFor(join(scratch, `${input}.lock`), repository, scope, release)
  }
  finally {
    rmSync(scratch, { recursive: true, force: true })
  }
  return { input, repository, tag, release, lock, pin: pinText(repository, scope, release, sha256(sums)), sums: sha256(sums) }
}

/** Writes a resolved move: the lock and its pin, and no other file. */
export function writeMove(locks: string, move: Move): void {
  writePair(locks, move.input, move.lock, move.pin)
}

/** `locks move`: that release's lock and pin replace the input's, verified; no other file changes. */
export async function moveLock(locks: string, input: string, release?: string): Promise<string> {
  const move = await resolveMove(locks, input, release)
  writeMove(locks, move)
  return `locks/${input}.lock and locks/pins/${input}.pin: ${move.repository} ${move.tag}, SHA256SUMS ${move.sums}`
}

/** The digests a lock names in an OCI layout: references and package archives. */
function namedDigests(lock: Lock): string[] {
  const digests: string[] = []
  for (const row of lock.rows) {
    for (const value of row.slice(1)) {
      const m = REFERENCE.exec(value)
      if (m?.groups?.registry === 'local') digests.push(m.groups.digest!)
    }
    if (row[0] === 'package') digests.push(row[4]!)
  }
  return [...new Set(digests)].sort()
}

/**
 * `local-lock` (lock section 7): verifies a checkout's `_out/offline/` -- its SHA256SUMS over the lock and every
 * digest the lock names in its OCI layout -- then writes the lock unchanged and the offline pin. Refused under CI.
 */
export function localLock(locks: string, input: string, checkoutArg: string, env: NodeJS.ProcessEnv = process.env): string {
  if (modeOf(env) === 'ci') throw new Refused('checkout-in-ci', `an offline pin of ${input} is never written under CI`)
  const { repository, scope } = splitInput(input)
  const checkout = resolve(checkoutArg)
  if (!isAbsolute(checkout) || !existsSync(checkout)) throw new ToolError(`${checkoutArg} is not a directory`)
  const out = join(checkout, '_out/offline')
  const lockFile = `${input}.lock`
  if (!existsSync(join(out, 'SHA256SUMS'))) throw new ToolError(`${out}/SHA256SUMS does not exist; run make offline in ${checkout}`)
  const sumsBytes = readFileSync(join(out, 'SHA256SUMS'))
  const listed = parseSums(sumsBytes.toString())
  if (listed.length !== 1 || listed[0]![1] !== lockFile) throw new ToolError(`${out}/SHA256SUMS does not list exactly ${lockFile}`)
  const bytes = readFileSync(join(out, lockFile))
  if (sha256(bytes) !== listed[0]![0]) throw new ToolError(`${out}/${lockFile} does not hash to its SHA256SUMS line`)
  const lock = lockFor(join(out, lockFile), repository, scope, 'offline')
  const head = git(['-C', checkout, 'rev-parse', 'HEAD']).out.trim()
  if (head !== lock.commit) throw new ToolError(`${out}/${lockFile} names ${lock.commit}, and ${checkout} is at ${head || 'no commit'}`)
  for (const digest of namedDigests(lock)) {
    const blob = join(out, 'oci/blobs/sha256', digest)
    if (!existsSync(blob)) throw new ToolError(`${out}/oci holds no blob ${digest}, which ${lockFile} names`)
    if (sha256(readFileSync(blob)) !== digest) throw new Refused('cache-corrupt', `${blob} does not hash to its name`)
  }
  writePair(locks, input, new Uint8Array(bytes), pinText(repository, scope, 'offline', sha256(sumsBytes), checkout))
  checkPins(locks, 'local')
  return `locks/${input}.lock and locks/pins/${input}.pin: ${repository} offline at ${lock.commit} from ${checkout} (local only; never a release input)`
}
