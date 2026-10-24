// Snapshot rows of locks/upstream.lock (docs/spec/release-lock.md 4.1.1): a `git` row whose ref is a dated branch
// `mica/<family>-<YYYYMMDD>[-<HHMM>]` of a mirror. `locks update` moves such a row to the greatest snapshot of its
// family, read from the mirror's branch heads; every other `git` row stays as it is.
import { Refused, ToolError } from '../errors.ts'
import { git } from '../process.ts'
import type { Row } from './rules.ts'

const SNAPSHOT = /^mica\/([a-z0-9]+(?:-[a-z0-9]+)*)-([0-9]{8})(-[0-9]{4})?$/

/** The family of a snapshot ref, or undefined for a ref that is no snapshot. */
export function snapshotFamily(ref: string): string | undefined {
  return SNAPSHOT.exec(ref)?.[1]
}

/** The branch heads of `git ls-remote` output: branch name (without refs/heads/) to commit. */
export function branchHeads(listing: string): Map<string, string> {
  const heads = new Map<string, string>()
  for (const line of listing.split('\n')) {
    const m = /^([0-9a-f]{40})\trefs\/heads\/(.+)$/.exec(line)
    if (m !== null) heads.set(m[2]!, m[1]!)
  }
  return heads
}

/**
 * Where one `git` row moves: undefined when its ref is no snapshot or it already names the greatest snapshot of
 * its family; else the new ref and commit. Refused `snapshot-moved` when the row's own branch has another head.
 */
export function snapshotMove(row: Row, listing: string): { ref: string, commit: string } | undefined {
  const [, name, url, ref, commit] = row as [string, string, string, string, string]
  const family = snapshotFamily(ref)
  if (family === undefined) return undefined
  const heads = [...branchHeads(listing)].filter(([branch]) => snapshotFamily(branch) === family)
  const own = heads.find(([branch]) => branch === ref)
  if (own !== undefined && own[1] !== commit)
    throw new Refused('snapshot-moved', `git ${name}: ${url} ${ref} is ${own[1]}, and the row names ${commit}`)
  if (heads.length === 0) throw new ToolError(`git ${name}: ${url} has no branch mica/${family}-<YYYYMMDD>`)
  const [latest, head] = heads.reduce((a, b) => (b[0] > a[0] ? b : a))
  return latest > ref ? { ref: latest, commit: head } : undefined
}

/** The snapshot branches of one family, from the mirror itself. */
export function listSnapshots(url: string, family: string): string {
  const r = git(['ls-remote', url, `refs/heads/mica/${family}-*`])
  if (!r.ok) throw new ToolError(`git ls-remote ${url} failed: ${r.err.trim()}`)
  return r.out
}

/** An upstream.lock text with the `git` rows named in `moves` at their new ref and commit, every other line kept. */
export function withSnapshots(text: string, moves: ReadonlyMap<string, { ref: string, commit: string }>): string {
  return text.split('\n').map((line) => {
    const row = line.split('\t'), move = row[0] === 'git' ? moves.get(row[1]!) : undefined
    return move === undefined ? line : [row[0], row[1], row[2], move.ref, move.commit].join('\t')
  }).join('\n')
}
