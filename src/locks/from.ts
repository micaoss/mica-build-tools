// Images by digest out of locks/ (docs/spec/release-lock.md 1.2.1; docs/spec/build-rules.md section 2).
//
// A selector is `<source>:<name>[@<platform>]`: a repository's image row of that repository's lock in locks/
// (its index unless a platform is given), or `upstream:<name>`, an upstream row of locks/mica-build-env.lock --
// the only place a third-party image comes from. mica-build-env, which has no lock of its own to read, takes its
// upstream images from its locks/upstream.lock, whose rows its lock carries unchanged.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ToolError } from '../errors.ts'
import type { Input } from './pins.ts'
import { partition, type Row } from './rules.ts'
import { checkUpstream } from './upstream.ts'

const SELECTOR = /^[a-z0-9][a-z0-9-]*:[a-z0-9][a-z0-9._/:-]*(@(index|amd64|arm64|386))?$/
const PAIR = /^([A-Za-z_][A-Za-z0-9_]*)=(.+)$/

/** The image rows a selector can name: every producer lock's, and locks/upstream.lock's when no build-env lock exists. */
function imageRows(inputs: Input[], locks: string): Row[] {
  const rows = inputs.flatMap(i => i.lock.rows.filter(r => r[0] === 'image'))
  if (!inputs.some(i => i.lock.repository === 'mica-build-env') && existsSync(join(locks, 'upstream.lock')))
    rows.push(...checkUpstream(join(locks, 'upstream.lock')).filter(r => r[0] === 'image'))
  return rows
}

/** The one reference a selector names. */
export function resolve(selector: string, inputs: Input[], locks: string): string {
  if (!SELECTOR.test(selector)) throw new ToolError(`'${selector}' is not an image selector <source>:<name>[@<platform>]`)
  const [source, rest] = partition(selector, ':')
  const at = rest.lastIndexOf('@')
  const name = at < 0 ? rest : rest.slice(0, at), platform = at < 0 ? '' : rest.slice(at + 1)
  const found = imageRows(inputs, locks).filter(r => r[1] === source && r[2] === name
    && (source === 'upstream' ? !platform || r[3] === platform : r[3] === (platform || 'index')))
  const references = [...new Set(found.map(r => r[4]!))].sort()
  if (references.length !== 1) {
    throw new ToolError(`${references.length} image row(s) for ${selector} in locks/`
      + (references.length === 0 && source === 'upstream' ? '; a third-party image comes only from the upstream rows of locks/mica-build-env.lock' : ''))
  }
  return references[0]!
}

/** `--build-arg` lines for `<ARG>=<selector>` pairs. */
export function buildArgs(pairs: string[], inputs: Input[], locks: string): string[] {
  const out: string[] = []
  for (const pair of pairs) {
    const m = PAIR.exec(pair)
    if (m === null) throw new ToolError(`'${pair}' is not <ARG_NAME>=<selector>`)
    out.push('--build-arg', `${m[1]}=${resolve(m[2]!, inputs, locks)}`)
  }
  return out
}

const SYNTAX = /^#\s*syntax\s*=\s*(\S+)\s*$/i
const DIGEST = /@sha256:[0-9a-f]{64}$/

/**
 * build-rules.md section 2 over one Dockerfile: it names no image directly. Every `FROM` is a global build argument declared
 * with no default, a stage named before it, or `scratch`; a `# syntax=` directive names its image by digest.
 * Returns the problems, empty when there is none.
 */
export function checkDockerfile(path: string): string[] {
  const problems: string[] = []
  const lines: string[] = []
  let joined = ''
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    if (joined === '' && /^\s*#/.test(raw)) { lines.push(raw); continue }
    joined += raw
    if (joined.endsWith('\\')) { joined = joined.slice(0, -1); continue }
    lines.push(joined)
    joined = ''
  }
  if (joined !== '') lines.push(joined)
  const globalArgs = new Map<string, boolean>()
  const stages = new Set<string>()
  let seenFrom = false, directives = true
  lines.forEach((line, i) => {
    const where = `${path}:${i + 1}`
    const syntax = SYNTAX.exec(line)
    if (directives && syntax) {
      if (!DIGEST.test(syntax[1]!)) problems.push(`${where}: the syntax image ${syntax[1]} is not pinned by digest`)
      return
    }
    if (!/^\s*#/.test(line) && line.trim() !== '') directives = false
    const words = line.trim().split(/\s+/)
    const instruction = words[0]?.toUpperCase()
    if (instruction === 'ARG' && !seenFrom) {
      for (const decl of words.slice(1)) {
        const [argName] = partition(decl, '=')
        globalArgs.set(argName, decl.includes('='))
      }
    }
    if (instruction !== 'FROM') return
    seenFrom = true
    const rest = words.slice(1).filter(w => !w.startsWith('--'))
    const image = rest[0] ?? ''
    const arg = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/.exec(image)
    if (arg) {
      const hasDefault = globalArgs.get(arg[1]!)
      if (hasDefault === undefined) problems.push(`${where}: FROM ${image} is no global ARG declared before the first FROM`)
      else if (hasDefault) problems.push(`${where}: FROM ${image} takes an ARG with a default; a FROM's argument has none`)
    }
    else if (image === '' || (image !== 'scratch' && !stages.has(image.toLowerCase()))) {
      problems.push(`${where}: FROM ${image} names an image directly; take it as a build argument with no default`)
    }
    if (rest.length >= 3 && rest[1]!.toUpperCase() === 'AS') stages.add(rest[2]!.toLowerCase())
  })
  if (!seenFrom) problems.push(`${path}: no FROM`)
  return problems
}

export function checkDockerfiles(paths: string[]): void {
  const problems = paths.flatMap(checkDockerfile)
  if (problems.length > 0) throw new ToolError(problems.join('\n'))
}
