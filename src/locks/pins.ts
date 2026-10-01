// The consumer's records: `mica-pin v1` and the locks/ directory (docs/spec/release-lock.md section 4),
// and the two-key commit pin `mica-tools-pin v1` (4.2, 9.2).
import { existsSync, readdirSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { Refused, ToolError } from '../errors.ts'
import { checkLock, type Lock } from './lock.ts'
import { checkUpstream } from './upstream.ts'
import { Checker, COMMIT, RELEASE, REPOSITORY, SCOPE, SCOPED, SHA256, partition, textOf } from './rules.ts'

export type Pin = Record<string, string | null>

function pairsOf(lines: string[]): [string, string | null][] {
  return lines.map(line => line.includes('=') ? [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)] : [line, null])
}

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i])
}

/** One `locks/pins/<repository>[.<scope>].pin`. */
export function readPin(path: string, check: Checker = new Checker()): Pin {
  const lines = textOf(path, check).slice(0, -1).split('\n')
  if (lines[0] !== '# mica-pin v1') check.refuse('header', path)
  const pairs = pairsOf(lines.slice(1))
  const values: Pin = Object.fromEntries(pairs)
  const offline = values.RELEASE === 'offline'
  const scoped = Object.hasOwn(values, 'SCOPE')
  const expected = ['REPOSITORY', ...(scoped ? ['SCOPE'] : []), 'RELEASE', 'SHA256SUMS', ...(offline ? ['CHECKOUT'] : [])]
  if (!sameList(pairs.map(([k]) => k), expected)) check.refuse('pin-format', path)
  check.field(REPOSITORY.test(values.REPOSITORY ?? '') && SHA256.test(values.SHA256SUMS ?? '')
    && (offline || RELEASE.test(values.RELEASE ?? '')) && (!scoped || SCOPE.test(values.SCOPE ?? '')), path)
  if (offline) check.field(isAbsolute(values.CHECKOUT ?? ''), path)
  return values
}

/**
 * A two-key commit pin: the header, then exactly REPOSITORY and COMMIT in that order, comment lines allowed after
 * the header (lock 9.2).
 */
export function readCommitPin(path: string, header: string): { repository: string, commit: string } {
  const lines = textOf(path).slice(0, -1).split('\n')
  if (lines[0] !== header) throw new Refused('header', path)
  const pairs = pairsOf(lines.slice(1).filter(line => !line.startsWith('#')))
  if (!sameList(pairs.map(([k]) => k), ['REPOSITORY', 'COMMIT'])) throw new Refused('pin-format', path)
  const values = Object.fromEntries(pairs)
  if (!(REPOSITORY.test(values.REPOSITORY ?? '') && COMMIT.test(values.COMMIT ?? ''))) throw new Refused('field-value', path)
  return { repository: values.REPOSITORY!, commit: values.COMMIT! }
}

export const TOOLS_PIN_HEADER = '# mica-tools-pin v1'

/** The pin of the build tools in locks/ (release-lock.md 4.2): no lock pairs with it. */
export const TOOLS_PIN = 'mica-build-tools.pin'

/** `locks/mica-build-tools.pin`, whose repository is this one's. */
export function readToolsPin(path: string): string {
  const pin = readCommitPin(path, TOOLS_PIN_HEADER)
  if (pin.repository !== 'mica-build-tools') throw new Refused('field-value', `${path} names ${pin.repository}, not mica-build-tools`)
  return pin.commit
}

/** One input of locks/: `<repository>[.<scope>]`, its pin and its lock. */
export type Input = { name: string, pin: Pin, lock: Lock }

export type Mode = 'ci' | 'local'

/** CI mode under `CI` or `GITHUB_ACTIONS`, where an offline pin is refused (section 4). */
export function modeOf(env: NodeJS.ProcessEnv = process.env): Mode {
  return env.CI || env.GITHUB_ACTIONS ? 'ci' : 'local'
}

/** Every input of a locks/ directory, checked (section 4); locks/upstream.lock has no pin and is not one. */
export function checkPins(directory: string, mode: Mode): Input[] {
  if (!existsSync(directory)) throw new ToolError(`${directory} does not exist`)
  const pinsDir = join(directory, 'pins')
  const pins = existsSync(pinsDir) ? readdirSync(pinsDir).filter(f => f.endsWith('.pin')).map(f => f.slice(0, -4)).sort() : []
  const locks = readdirSync(directory).filter(f => f.endsWith('.lock') && f !== 'upstream.lock').map(f => f.slice(0, -5)).sort()
  const records = new Map<string, Pin>()
  for (const name of pins) {
    const values = readPin(join(pinsDir, name + '.pin'))
    const [repository, scope] = partition(name, '.')
    if (values.REPOSITORY !== repository) throw new Refused('name-mismatch', name)
    if ((values.SCOPE ?? '') !== scope) throw new Refused('scope-mismatch', name)
    if (Object.hasOwn(values, 'SCOPE') !== SCOPED.has(repository)) throw new Refused('release-scope', name)
    records.set(name, values)
  }
  for (const name of pins) if (!locks.includes(name)) throw new Refused('pin-without-lock', name)
  for (const name of locks) if (!pins.includes(name)) throw new Refused('lock-without-pin', name)
  const inputs: Input[] = []
  for (const [name, pin] of records) {
    let lock: Lock
    try {
      lock = checkLock(join(directory, name + '.lock'))
    }
    catch (e) {
      if (e instanceof Refused) throw new Refused('lock-invalid', `${name}.lock: ${e.rule}${e.detail ? ` ${e.detail}` : ''}`)
      throw e
    }
    if (lock.repository !== pin.REPOSITORY) throw new Refused('lock-invalid', `${name}.lock names ${lock.repository}`)
    if (lock.scope !== (pin.SCOPE ?? '')) throw new Refused('scope-mismatch', name)
    if (lock.release !== pin.RELEASE) throw new Refused('release-mismatch', name)
    if (Object.hasOwn(pin, 'CHECKOUT') && mode === 'ci') throw new Refused('checkout-in-ci', name)
    inputs.push({ name, pin, lock })
  }
  return inputs
}

/** `locks check`: every input of locks/, and locks/upstream.lock and locks/mica-build-tools.pin when they exist. */
export function checkLocks(directory: string, mode: Mode): Input[] {
  const inputs = checkPins(directory, mode)
  const upstream = join(directory, 'upstream.lock')
  if (existsSync(upstream)) checkUpstream(upstream)
  const tools = join(directory, TOOLS_PIN)
  if (existsSync(tools)) readToolsPin(tools)
  return inputs
}
