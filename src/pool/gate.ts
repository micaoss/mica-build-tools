// `pool gate` (design 3.3.3): the gates of docs/spec/build-rules.md section 6 that the archives of the pools answer
// by themselves. The gates that read a repository's own declarations or build -- every archive maps to a producer
// or a pin, enablement links match their declaration, two builds are byte-identical -- stay with the repository.
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ToolError } from '../errors.ts'
import { controlEntries, controlFields, installedPath, payloadEntries } from '../deb/archive.ts'
import { fileKind, poolItems } from './items.ts'

const MAINTAINER_SCRIPTS = new Set(['preinst', 'postinst', 'prerm', 'postrm'])

/** The package names of a relationship field, versions and alternatives dropped. */
function names(field: string | undefined): Set<string> {
  return new Set((field ?? '').split(/[,|]/).map(v => v.trim().split(/[\s(:]/)[0]!).filter(v => v !== ''))
}

type Archive = { file: string, name: string, conflicts: Set<string> }

/** Every problem the gates find in the pools of these architectures under `debs` (`_out/debs`). */
export function gate(debs: string, arches: string[]): { archives: number, problems: string[] } {
  const problems: string[] = []
  const alls = new Map<string, { arch: string, sha256: string }>()
  let archives = 0
  for (const arch of arches) {
    if (!['amd64', 'arm64'].includes(arch)) throw new ToolError(`'${arch}' is not amd64 or arm64`)
    const pool = join(debs, arch, 'pool')
    const files = existsSync(pool) ? readdirSync(pool).filter(f => fileKind(f) === 'archive').sort() : []
    let unreadable = false
    // An item (lock 1.2.7) is held to its name and its version, and to nothing of its type.
    let items: ReturnType<typeof poolItems> = []
    try {
      items = poolItems(pool, arch)
    }
    catch (e) {
      if (!(e instanceof ToolError)) throw e
      problems.push(e.message)
      unreadable = true
    }
    if (files.length === 0 && items.length === 0 && !unreadable) throw new ToolError(`${pool} holds no archive and no item`)
    for (const i of items) {
      archives += 1
      if (/[~+]git|\.dirty/.test(i.version)) problems.push(`${arch}/pool/${i.file}: version ${i.version} carries a commit or dirty stamp`)
    }
    const owners = new Map<string, Archive>()
    for (const file of files) {
      archives += 1
      const path = join(pool, file)
      const at = `${arch}/pool/${file}`
      const fail = (what: string) => problems.push(`${at}: ${what}`)
      const control = controlEntries(path)
      const fields = controlFields(new TextDecoder().decode(control.find(e => installedPath(e.name) === 'control')?.body ?? new Uint8Array()))
      const name = fields.Package ?? '', version = fields.Version ?? '', architecture = fields.Architecture ?? ''
      if (file !== `${name}_${version}_${architecture}.deb`) fail(`is not named ${name}_${version}_${architecture}.deb`)
      if (architecture !== arch && architecture !== 'all') fail(`is Architecture ${architecture}, not ${arch} or all`)
      if (/[~+]git|\.dirty/.test(version)) fail(`version ${version} carries a commit or dirty stamp`)
      if (!/^[a-z0-9][a-z0-9-]*$/.test(fields['Mica-Source-Repo'] ?? '')) fail('carries no Mica-Source-Repo')
      if ('Mica-Source-Commit' in fields) fail('carries Mica-Source-Commit')
      if ('Replaces' in fields) fail('declares Replaces')
      for (const entry of control) {
        const member = installedPath(entry.name)
        if (member === 'conffiles') fail('carries DEBIAN/conffiles')
        if (MAINTAINER_SCRIPTS.has(member)) {
          const parsed = Bun.spawnSync(['sh', '-n'], { stdin: entry.body, stderr: 'pipe' })
          if (parsed.exitCode !== 0) fail(`${member} is not valid POSIX sh: ${parsed.stderr.toString().trim()}`)
        }
      }
      const self: Archive = { file, name, conflicts: names(fields.Conflicts) }
      const payload = payloadEntries(path)
      const copyright = payload.find(e => installedPath(e.name) === `usr/share/doc/${name}/copyright`)
      if (copyright === undefined || copyright.type !== '0' || copyright.body.length === 0) fail(`carries no non-empty /usr/share/doc/${name}/copyright`)
      for (const entry of payload) {
        if (entry.type === '5') continue
        const member = installedPath(entry.name)
        const other = owners.get(member)
        if (other === undefined) { owners.set(member, self); continue }
        if (other.name === name) continue
        if (!(self.conflicts.has(other.name) && other.conflicts.has(name))) fail(`ships /${member}, which ${other.file} ships too, and the two do not conflict with each other`)
      }
      if (architecture === 'all') {
        const sha256 = createHash('sha256').update(readFileSync(path)).digest('hex')
        const seen = alls.get(file)
        if (seen === undefined) alls.set(file, { arch, sha256 })
        else if (seen.sha256 !== sha256) fail(`differs from ${seen.arch}/pool/${file}; an all archive is the same bytes in every pool`)
      }
    }
  }
  return { archives, problems }
}
