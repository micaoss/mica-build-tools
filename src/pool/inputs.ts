// The inputs declaration and hash (design 3.3.1): a producer directory's `mica-inputs` names its packages and
// everything that decides their bytes; the hash is the sha256 of a manifest of those files and lock rows and the
// architecture. It guards a version against inputs that changed without a bump; it never decides reuse.
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, readlinkSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { ToolError } from '../errors.ts'
import { resolve as resolveImage } from '../locks/from.ts'
import { checkLocks, modeOf } from '../locks/pins.ts'
import { partition, textOf } from '../locks/rules.ts'
import { checkUpstream } from '../locks/upstream.ts'
import { git } from '../process.ts'

export const INPUTS_FILE = 'mica-inputs'
const HEADER = '# mica-inputs v1'
const NAME = /^[a-z0-9][a-z0-9.+-]*$/

export type Declaration = {
  /** The producer directory, relative to the repository root. */
  dir: string
  packages: string[]
  paths: string[]
  sources: string[]
  gits: string[]
  images: string[]
}

/** Reads `<dir>/mica-inputs`. */
export function readDeclaration(root: string, dir: string): Declaration {
  const rel = relative(root, resolve(root, dir)) || '.'
  if (rel.startsWith('..')) throw new ToolError(`${dir} is outside the repository ${root}`)
  const file = join(root, rel, INPUTS_FILE)
  if (!existsSync(file)) throw new ToolError(`${rel}/${INPUTS_FILE} does not exist`)
  const lines = textOf(file).slice(0, -1).split('\n')
  if (lines[0] !== HEADER) throw new ToolError(`line 1 of ${rel}/${INPUTS_FILE} is not '${HEADER}'`)
  const declaration: Declaration = { dir: rel, packages: [], paths: [], sources: [], gits: [], images: [] }
  for (const line of lines.slice(1)) {
    if (line.startsWith('#')) continue
    const [kind, value] = partition(line, ' ')
    if (value === '' || value !== value.trim()) throw new ToolError(`${rel}/${INPUTS_FILE}: '${line}' is not <kind> <value>`)
    if (kind === 'package' && NAME.test(value)) declaration.packages.push(value)
    else if (kind === 'path') declaration.paths.push(value)
    else if (kind === 'source' && /^[a-z0-9][a-z0-9.+-]*\*?$/.test(value)) declaration.sources.push(value)
    else if (kind === 'git' && NAME.test(value)) declaration.gits.push(value)
    else if (kind === 'image') declaration.images.push(value)
    else throw new ToolError(`${rel}/${INPUTS_FILE}: '${line}' is not a declaration line`)
  }
  if (declaration.packages.length === 0) throw new ToolError(`${rel}/${INPUTS_FILE} declares no package`)
  return declaration
}

/** Every producer of the repository: each tracked `mica-inputs`, a package declared by one producer only. */
export function producers(root: string): Declaration[] {
  const listed = git(['-C', root, 'ls-files', '-z', '--', INPUTS_FILE, `*/${INPUTS_FILE}`])
  if (!listed.ok) throw new ToolError(`${root} is not a git checkout`)
  const all = listed.out.split('\0').filter(f => f !== '').sort()
    .map(f => readDeclaration(root, f === INPUTS_FILE ? '.' : f.slice(0, -INPUTS_FILE.length - 1)))
  const owner = new Map<string, string>()
  for (const d of all) {
    for (const p of d.packages) {
      if (owner.has(p)) throw new ToolError(`the package ${p} is declared by ${owner.get(p)} and ${d.dir}`)
      owner.set(p, d.dir)
    }
  }
  return all
}

/** The producer that declares a package. */
export function producerOf(root: string, pkg: string): Declaration {
  const found = producers(root).find(d => d.packages.includes(pkg))
  if (found === undefined) throw new ToolError(`no ${INPUTS_FILE} of this repository declares the package ${pkg}`)
  return found
}

function tracked(root: string, pathspecs: string[]): string[] {
  const r = git(['-C', root, 'ls-files', '-z', '--', ...pathspecs])
  if (!r.ok) throw new ToolError(`git ls-files ${pathspecs.join(' ')} failed in ${root}`)
  return r.out.split('\0').filter(f => f !== '')
}

const sha256 = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex')
const bytes = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b))

/** The manifest lines of a producer at an architecture. */
export function manifest(root: string, declaration: Declaration, arch: string): string[] {
  if (!['amd64', 'arm64', 'all'].includes(arch)) throw new ToolError(`'${arch}' is not amd64, arm64 or all`)
  const where = `${declaration.dir}/${INPUTS_FILE}`
  // Exclusions narrow the whole set, the producer directory included; every other pathspec must match something.
  for (const spec of declaration.paths.filter(p => !p.startsWith(':(exclude')))
    if (tracked(root, [spec]).length === 0) throw new ToolError(`${where}: path ${spec} matches no tracked file`)

  const kept = new Set(tracked(root, [declaration.dir, ...declaration.paths]))
  const fileLines = [...kept].sort(bytes).map((path) => {
    const full = join(root, path)
    const stats = lstatSync(full)
    if (stats.isSymbolicLink()) return `${sha256(`link:${readlinkSync(full)}`)} l ${path}`
    return `${sha256(new Uint8Array(readFileSync(full)))} ${stats.mode & 0o111 ? 'x' : '-'} ${path}`
  })
  const rows: string[] = []
  if (declaration.sources.length > 0 || declaration.gits.length > 0) {
    const upstream = checkUpstream(join(root, 'locks/upstream.lock'))
    for (const source of declaration.sources) {
      const match = (name: string) => source.endsWith('*') ? name.startsWith(source.slice(0, -1)) : name === source
      const found = upstream.filter(r => r[0] === 'source' && match(r[1]!) && (arch === 'all' || r[2] === arch || r[2] === 'all'))
      if (found.length === 0) throw new ToolError(`${where}: source ${source} names no row of locks/upstream.lock at ${arch}`)
      rows.push(...found.map(r => `row ${r.join(' ')}`))
    }
    for (const name of declaration.gits) {
      const found = upstream.filter(r => r[0] === 'git' && r[1] === name)
      if (found.length === 0) throw new ToolError(`${where}: git ${name} names no row of locks/upstream.lock`)
      rows.push(...found.map(r => `row ${r.join(' ')}`))
    }
  }
  if (declaration.images.length > 0) {
    const locks = join(root, 'locks')
    const inputs = checkLocks(locks, modeOf())
    for (const selector of declaration.images) rows.push(`row image ${selector} ${resolveImage(selector, inputs, locks)}`)
  }
  return [...fileLines, ...[...new Set(rows)].sort(bytes), `arch ${arch}`]
}

export function inputsHash(root: string, declaration: Declaration, arch: string): string {
  return sha256(manifest(root, declaration, arch).map(l => l + '\n').join(''))
}
