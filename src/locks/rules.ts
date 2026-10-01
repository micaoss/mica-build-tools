// What every reader of docs/spec/release-lock.md shares: the file rules of 1.1, the value forms of 1.2,
// and the refusal context that makes the collect mode of 9.4 possible.
import { readFileSync } from 'node:fs'
import { Refused } from '../errors.ts'

/**
 * Where a refusal goes. The default refuses at the first rule broken, which is the contract expected.tsv names.
 * The collect mode (9.4) suppresses each rule it has found and runs again, so a suppressed check lets the reader
 * continue past it; where the continuation reads what the check was protecting, the reader stops (`Stop`) rather
 * than guess, which is the one direction a mode hunting extra rules may err in.
 */
export class Checker {
  constructor(readonly suppress: ReadonlySet<string> = new Set()) {}

  refuse(rule: string, detail = ''): void {
    if (!this.suppress.has(rule)) throw new Refused(rule, detail)
  }

  field(ok: unknown, detail = ''): void {
    if (!ok) this.refuse('field-value', detail)
  }
}

/** The continuation of a suppressed check reached a value the check was protecting. */
export class Stop extends Error {}

/** A value that must exist once the checks before it held; its absence is a `Stop`. */
export function need<T>(value: T | undefined | null, what: string): T {
  if (value === undefined || value === null) throw new Stop(what)
  return value
}

export const REPOSITORY = /^[a-z0-9][a-z0-9-]*$/
export const RELEASE = /^[0-9]{8}-[0-9]{4}$/
export const COMMIT = /^[0-9a-f]{40}$/
export const SHA256 = /^[0-9a-f]{64}$/
/** A scope or a product: a name, or a product named under its board (`<board>.<product>`). */
export const SCOPE = /^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)?$/
/** A board: one name. */
export const BOARD = /^[a-z0-9][a-z0-9-]*$/
export const NAME = /^[a-z0-9][a-z0-9.+-]*$/
export const VERSION = /^[A-Za-z0-9.+~:-]+$/
export const ARCH = new Set(['amd64', 'arm64'])
export const PLATFORM = new Set(['index', 'amd64', 'arm64', '386'])
export const UPSTREAM_NAME = /^[a-z0-9][a-z0-9._/-]*(?::[A-Za-z0-9._-]+)?$/
export const UPSTREAM_REFERENCE = /^[a-z0-9-]+(?:\.[a-z0-9-]+)+(?::[0-9]+)?\/[a-z0-9._/-]+(?::[A-Za-z0-9._-]+)?@sha256:[0-9a-f]{64}$/
export const REFERENCE = /^(?<registry>ghcr\.io\/micaoss|local)\/(?<repository>[a-z0-9][a-z0-9-]*)(?::(?<tag>[A-Za-z0-9._-]+))?@sha256:(?<digest>[0-9a-f]{64})$/
/** The repositories that release by scope (1.0). */
export const SCOPED = new Set(['mica-build'])

export type Row = string[]

/** The text of a file under the rules of 1.1: UTF-8, LF, a final LF, no CR. A BOM is a character, not a mark. */
export function textOf(path: string, check: Checker = new Checker()): string {
  const data = readFileSync(path)
  let text = ''
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data)
  }
  catch {
    check.refuse('encoding', `${path} is not UTF-8`)
  }
  if (!text.endsWith('\n') || text.includes('\r')) check.refuse('encoding', `${path}: a CR or no final LF`)
  return text
}

/** The rows of a `# mica-lock v1` file: comments dropped, every other line split on tabs. */
export function linesOf(path: string, header: string, check: Checker = new Checker()): Row[] {
  const lines = textOf(path, check).slice(0, -1).split('\n')
  if (lines[0] !== header) check.refuse('header', `${path}: line 1 is not '${header}'`)
  const rows: Row[] = []
  for (const line of lines.slice(1)) {
    if (line === '' || line.endsWith('\t') || line.startsWith(' ')) check.refuse('encoding', `${path}: ${JSON.stringify(line)}`)
    if (line.startsWith('#')) continue
    rows.push(line.split('\t'))
  }
  return rows
}

/** Python's str.partition: before the first separator and after it; (value, '') without one. */
export function partition(value: string, sep: string): [string, string] {
  const i = value.indexOf(sep)
  return i < 0 ? [value, ''] : [value.slice(0, i), value.slice(i + sep.length)]
}

/** Python's str.rpartition, keeping the two outer parts: ('', value) without a separator. */
export function rpartition(value: string, sep: string): [string, string] {
  const i = value.lastIndexOf(sep)
  return i < 0 ? ['', value] : [value.slice(0, i), value.slice(i + sep.length)]
}

export type SortKey = (number | string)[]

/** Compares sort keys as the reference compares its tuples: the kind's position, then each key as bytes. */
export function compareKeys(a: SortKey, b: SortKey): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const x = a[i]!, y = b[i]!
    const c = typeof x === 'number' && typeof y === 'number'
      ? x - y
      : Buffer.compare(Buffer.from(String(x)), Buffer.from(String(y)))
    if (c !== 0) return c
  }
  return a.length - b.length
}

export function isSorted(keys: SortKey[]): boolean {
  return keys.every((key, i) => i === 0 || compareKeys(keys[i - 1]!, key) <= 0)
}

/** An `image upstream` row's name, platform and reference (1.2.1), shared by release locks and upstream.lock. */
export function checkUpstreamImage(row: Row, check: Checker): void {
  check.field(UPSTREAM_NAME.test(row[2]!) && PLATFORM.has(row[3]!), row.join('\t'))
  if (!row[4]!.includes('@sha256:')) check.refuse('reference-digest', row[4])
  if (row[4]!.startsWith('ghcr.io/micaoss/') || row[4]!.startsWith('local/')) check.refuse('reference-upstream', row[4])
  check.field(UPSTREAM_REFERENCE.test(row[4]!), row[4])
}
