// `locks/upstream.lock`, the third-party inputs of a repository (docs/spec/release-lock.md 4.1).
import { existsSync } from 'node:fs'
import { ToolError } from '../errors.ts'
import { LOCK_HEADER } from './lock.ts'
import {
  ARCH, Checker, COMMIT, NAME, SHA256, VERSION, checkUpstreamImage, isSorted, linesOf, type Row, type SortKey,
} from './rules.ts'

const UPSTREAM_COLUMNS: Record<string, number> = { image: 5, source: 6, git: 5 }
const ORDER = Object.keys(UPSTREAM_COLUMNS)

/** Checks one locks/upstream.lock and returns its rows. */
export function checkUpstream(path: string, check: Checker = new Checker()): Row[] {
  const rows = linesOf(path, LOCK_HEADER, check)
  for (const row of rows) {
    if (row[0] === 'release') check.refuse('upstream-release-row', path)
    if (!Object.hasOwn(UPSTREAM_COLUMNS, row[0]!)) check.refuse('kind-unknown', row[0])
    if (row.length !== UPSTREAM_COLUMNS[row[0]!]) check.refuse('column-count', row.join('\t'))
  }
  const keys = new Set<string>(), sortKeys: SortKey[] = []
  for (const row of rows) {
    const kind = row[0]!
    const text = row.join('\t')
    let key: string[]
    if (kind === 'image') {
      if (row[1] !== 'upstream') check.refuse('image-source', text)
      checkUpstreamImage(row, check)
      key = [row[1]!, row[2]!, row[3]!]
    }
    else if (kind === 'source') {
      check.field(NAME.test(row[1]!) && (ARCH.has(row[2]!) || row[2] === 'all') && VERSION.test(row[3]!)
        && SHA256.test(row[4]!) && row[5]!.startsWith('https://'), text)
      key = [row[1]!, row[2]!]
    }
    else {
      check.field(NAME.test(row[1]!) && row[2]!.startsWith('https://') && row[3] && COMMIT.test(row[4]!), text)
      key = [row[1]!]
    }
    const full = JSON.stringify([kind, ...key])
    if (keys.has(full)) check.refuse('duplicate-key', text)
    keys.add(full)
    sortKeys.push([ORDER.indexOf(kind), ...key])
  }
  if (!isSorted(sortKeys)) check.refuse('sort-order', path)
  return rows
}

const GIT_FIELDS: Record<string, number> = { url: 2, ref: 3, commit: 4 }
const SOURCE_FIELDS: Record<string, number> = { version: 3, sha256: 4, url: 5 }

/** One field of a `git` row: a missing row or field is an error naming it, so nothing runs on an empty pin. */
export function gitField(path: string, name: string, what: string): string {
  if (!Object.hasOwn(GIT_FIELDS, what)) throw new ToolError(`a git row has url, ref and commit, not ${what}`)
  const row = upstreamRows(path).find(r => r[0] === 'git' && r[1] === name)
  if (row === undefined) throw new ToolError(`${path} pins no git tree ${name}`)
  return row[GIT_FIELDS[what]!]!
}

/** One field of a `source` row. */
export function sourceField(path: string, name: string, arch: string, what: string): string {
  if (!Object.hasOwn(SOURCE_FIELDS, what)) throw new ToolError(`a source row has version, sha256 and url, not ${what}`)
  const row = upstreamRows(path).find(r => r[0] === 'source' && r[1] === name && r[2] === arch)
  if (row === undefined) throw new ToolError(`${path} pins no source ${name} for ${arch}`)
  return row[SOURCE_FIELDS[what]!]!
}

function upstreamRows(path: string): Row[] {
  if (!existsSync(path)) throw new ToolError(`${path} does not exist`)
  return checkUpstream(path)
}
