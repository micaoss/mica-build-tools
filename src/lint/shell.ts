// shell-lint (design 3.5): in a script that sets pipefail, a reader on the right of a pipe that exits before its
// input ends kills the writer with SIGPIPE, and the pipeline then fails or passes depending on how much the writer
// had already written. The file list comes from git, so a script is covered the day it lands.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ToolError } from '../errors.ts'
import { git } from '../process.ts'

/** The readers that stop early, each with its name and its remedy. */
const READERS: [RegExp, string, string][] = [
  [/\|\s*(command\s+)?e?grep(\s+-[A-Za-z]*q[A-Za-z]*)+/, 'an early-exiting grep', '\'grep -c ... >/dev/null\''],
  [/\|\s*(command\s+)?e?grep(\s+-[A-Za-z]*m[A-Za-z]*)+\s*[0-9]/, 'a grep bounded by -m', '\'grep ...\' and bound the result afterwards'],
  [/\|\s*head(\s|$)/, 'head', '\'awk "NR <= N"\''],
  [/\|\s*sed[^|]*[0-9]+\s*q/, 'a sed that quits', '\'awk "NR <= N"\''],
  [/\|\s*awk[^|]*\sexit/, 'an awk that exits', 'an awk that reads to the end of its input'],
  [/\|\s*read(\s|$)/, 'a bare read', 'a \'while ... read\' loop that runs to the end, or a command substitution'],
]

/** The findings in one file's text; none when it does not set pipefail. */
export function lintText(path: string, text: string): string[] {
  if (!text.includes('pipefail')) return []
  const findings: string[] = []
  text.split('\n').forEach((line, i) => {
    if (/^\s*#/.test(line)) return
    for (const [pattern, name, remedy] of READERS) {
      if (pattern.test(line))
        findings.push(`${path}:${i + 1}: ${name} on the right of a pipe, in a file that sets pipefail: the pipeline reports failure exactly when the reader stops early. Use ${remedy}`)
    }
  })
  return findings
}

/** Lints the tracked files the pathspecs name (default `*.sh`) in the repository at `root`. */
export function lint(root: string, pathspecs: string[]): { scanned: number, findings: string[] } {
  const unmerged = git(['-C', root, 'diff', '--name-only', '--diff-filter=U'])
  if (!unmerged.ok) throw new ToolError(`${root} is not a git checkout`)
  if (unmerged.out.trim() !== '')
    throw new ToolError(`the tree has unresolved merge conflicts (${unmerged.out.trim().split('\n').join(', ')}); resolve them first`)
  const listed = git(['-C', root, 'ls-files', '--', ...(pathspecs.length > 0 ? pathspecs : ['*.sh'])])
  const files = [...new Set(listed.out.split('\n').filter(f => f !== ''))].sort()
  if (files.length === 0) throw new ToolError('no file matched; this lint would pass by finding nothing')
  let scanned = 0
  const findings: string[] = []
  for (const file of files) {
    const path = join(root, file)
    if (!existsSync(path)) continue
    const text = readFileSync(path, 'utf8')
    if (!text.includes('pipefail')) continue
    scanned += 1
    findings.push(...lintText(file, text))
  }
  if (scanned === 0) throw new ToolError('no file sets pipefail; the scan matched nothing and would report clean')
  return { scanned, findings }
}
