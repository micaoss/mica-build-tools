// The version stamp of a tree: <VERSION>+git<commit12>[.dirty]-1 (docs/spec/build-rules.md section 6). VERSION is
// the repository's one-line version file; `.dirty` names a tree no commit reproduces.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ToolError } from '../errors.ts'
import { git } from '../process.ts'

export function version(root: string): string {
  const file = join(root, 'VERSION')
  if (!existsSync(file)) throw new ToolError(`${file} does not exist`)
  const lines = readFileSync(file, 'utf8').split('\n').filter(l => l !== '')
  if (lines.length !== 1) throw new ToolError(`${file} must hold exactly one non-empty line`)
  const declared = lines[0]!.replace(/\s/g, '')
  if (!/^[0-9][A-Za-z0-9.~]*$/.test(declared)) throw new ToolError(`${file} declares '${declared}', which is not a Debian upstream version`)
  const commit = git(['-C', root, 'rev-parse', '--short=12', 'HEAD'])
  if (!commit.ok) throw new ToolError(`${root} has no commit to stamp`)
  const dirty = git(['-C', root, 'status', '--porcelain']).out === '' ? '' : '.dirty'
  return `${declared}+git${commit.out.trim()}${dirty}-1`
}
