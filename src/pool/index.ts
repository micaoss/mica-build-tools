// `pool index` (design 3.3): Packages, SHA256SUMS and manifest.txt beside _out/debs/<arch>/pool, read out of the
// archives with no dpkg. Packages is what `dpkg-scanpackages --multiversion pool` writes (dpkg 1.22): the fields of
// Dpkg::Control's repository order, then any other field by name, then the stanzas by package and version.
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ToolError } from '../errors.ts'
import { controlText } from '../deb/archive.ts'
import { fileKind } from './items.ts'

/** Dpkg::Control::FieldsCore's order for CTRL_REPO_PKG. */
const ORDER = [
  'Package', 'Package-Type', 'Source', 'Version', 'Kernel-Version', 'Built-For-Profiles', 'Auto-Built-Package',
  'Architecture', 'Subarchitecture', 'Installer-Menu-Item', 'Build-Essential', 'Essential', 'Protected', 'Origin',
  'Bugs', 'Maintainer', 'Installed-Size', 'Pre-Depends', 'Depends', 'Recommends', 'Suggests', 'Enhances',
  'Conflicts', 'Breaks', 'Replaces', 'Provides', 'Built-Using', 'Static-Built-Using', 'Filename', 'Size',
  'MD5sum', 'SHA1', 'SHA256', 'Section', 'Priority', 'Multi-Arch', 'Homepage', 'Description', 'Tag', 'Task',
]
const RANK = new Map(ORDER.map((name, i) => [name, i]))

/** A control paragraph as Dpkg::Control::HashCore parses it: names as written, values with continuations. */
export function parseControl(text: string): [string, string][] {
  const fields: [string, string][] = []
  for (const line of text.split('\n')) {
    if (line === '') continue
    const continuation = /^\s(\s*\S.*)$/.exec(line)
    if (continuation) {
      if (fields.length === 0) throw new ToolError(`a continuation line before any field: ${JSON.stringify(line)}`)
      const last = fields[fields.length - 1]!
      last[1] += '\n' + (/^\.+$/.test(continuation[1]!) ? continuation[1]!.slice(1) : continuation[1]!)
      continue
    }
    const m = /^(\S+?)\s*:\s*(.*?)\s*$/.exec(line)
    if (m === null) throw new ToolError(`not a control line: ${JSON.stringify(line)}`)
    fields.push([m[1]!, m[2]!])
  }
  return fields
}

function byteCompare(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a), Buffer.from(b))
}

/** One paragraph as Dpkg::Control::HashCore writes it. */
export function formatControl(fields: [string, string][]): string {
  const sorted = [...fields].sort(([a], [b]) => {
    const ra = RANK.get(a), rb = RANK.get(b)
    if (ra !== undefined && rb !== undefined) return ra - rb
    if (ra !== undefined) return -1
    if (rb !== undefined) return 1
    return byteCompare(a, b)
  })
  let out = ''
  for (const [key, value] of sorted) {
    const lines = value.split('\n')
    while (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
    const [first, ...rest] = lines
    out += `${key}:${first ? ` ${first}` : ''}\n`
    for (const raw of rest) {
      const line = raw.replace(/\s+$/, '')
      out += line === '' || /^\.+$/.test(line) ? ` .${line}\n` : ` ${line}\n`
    }
  }
  return out
}

function digest(algorithm: string, data: Uint8Array): string {
  return createHash(algorithm).update(data).digest('hex')
}

export type Indexed = { packages: string, sums: string, manifest: string, archives: number }

/** The index of the archives in `<dist>/pool`, every one of them `arch` or `all`. */
export function indexPool(dist: string, arch: string): Indexed {
  const pool = join(dist, 'pool')
  const files = existsSync(pool) ? readdirSync(pool).filter(f => fileKind(f) === 'archive').sort(byteCompare) : []
  if (files.length === 0) throw new ToolError(`${pool} holds no archive`)
  const stanzas: { name: string, version: string, text: string }[] = []
  let sums = ''
  let manifest = '#package\tversion\tarchitecture\tinstalled-size\tsha256\tfile\tsource-repo\n'
  for (const file of files) {
    const path = join(pool, file)
    const bytes = new Uint8Array(readFileSync(path))
    const fields = parseControl(controlText(path))
    const get = (name: string) => fields.find(([k]) => k === name)?.[1] ?? ''
    if (get('Package') === '') throw new ToolError(`pool/${file} has no Package field`)
    if (get('Architecture') !== arch && get('Architecture') !== 'all') throw new ToolError(`pool/${file} is Architecture ${get('Architecture')}, not ${arch}`)
    const sha256 = digest('sha256', bytes)
    fields.push(['Filename', `pool/${file}`], ['MD5sum', digest('md5', bytes)], ['SHA1', digest('sha1', bytes)], ['SHA256', sha256], ['Size', String(bytes.length)])
    stanzas.push({ name: get('Package'), version: get('Version'), text: formatControl(fields) })
    sums += `${sha256}  pool/${file}\n`
    manifest += [get('Package'), get('Version'), get('Architecture'), get('Installed-Size'), sha256, `pool/${file}`, get('Mica-Source-Repo')].join('\t') + '\n'
  }
  stanzas.sort((a, b) => byteCompare(a.name, b.name) || byteCompare(a.version, b.version))
  return { packages: stanzas.map(s => s.text + '\n').join(''), sums, manifest, archives: files.length }
}

export function writeIndex(dist: string, arch: string): string {
  const index = indexPool(dist, arch)
  writeFileSync(join(dist, 'Packages'), index.packages)
  writeFileSync(join(dist, 'SHA256SUMS'), index.sums)
  writeFileSync(join(dist, 'manifest.txt'), index.manifest)
  return `${arch}: ${index.archives} package(s)`
}
