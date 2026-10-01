// `deb pack` (design 3.3.2): one archive from a staged tree, under the packing contract, run
// by a package's Dockerfile in the build image of the archive's architecture (dpkg-deb builds; nothing else of
// dpkg is used, and the archive is read back with this repository's own reader). The compression is xz, named
// rather than left to the host's dpkg, whose default differs (Ubuntu's is zstd).
//
// The control template declares its Version literally and Source-Date-Epoch beside it, bumped together; neither
// carries a commit, a snapshot or a dirty stamp. It carries @ARCH@ and never Installed-Size, Mica-Source-Repo or
// Mica-Source-Commit: the first is computed here, the second written, the third refused. Every mtime is the epoch,
// the archive is root:root, md5sums are sorted, and the packed payload is compared with the staged tree.
import { createHash } from 'node:crypto'
import {
  chmodSync, cpSync, existsSync, lstatSync, lutimesSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { basename, join } from 'node:path'
import { ToolError } from '../errors.ts'
import { run } from '../process.ts'
import { controlFields, controlText, installedPath, payloadEntries } from './archive.ts'

const MAINTAINER_SCRIPTS = new Set(['preinst', 'postinst', 'prerm', 'postrm'])
const REQUIRED = ['Package', 'Version', 'Architecture', 'Maintainer', 'Section', 'Priority', 'Description']
const WRITTEN = ['Installed-Size', 'Mica-Source-Repo', 'Mica-Source-Commit']
const RELATIONS = /^(?:Pre-)?Depends$|^Recommends$|^Suggests$|^Provides$|^Conflicts$|^Breaks$|^Replaces$/
/** A Debian version of its own: no commit, snapshot or dirty stamp. */
const VERSION = /^(?:\d+:)?\d[A-Za-z0-9.+~-]*$/

export type PackRequest = {
  root: string
  control: string
  arch: 'amd64' | 'arm64' | 'all'
  out: string
  /** The repository written as Mica-Source-Repo. */
  repository: string
  /** The SOURCE_DATE_EPOCH the build runs under. */
  epoch: string
  scripts?: string
  substitutions?: Record<string, string>
}

/** The Version and Source-Date-Epoch a control template declares. */
export function declaration(template: string, file: string): { version: string, epoch: number } {
  const fields = controlFields(template)
  const version = fields.Version ?? '', epoch = fields['Source-Date-Epoch'] ?? ''
  if (!VERSION.test(version) || /[~+]git|\.dirty/.test(version))
    throw new ToolError(`${file} declares Version '${version}', not a Debian version of its own (no commit, snapshot or dirty stamp)`)
  if (!/^[1-9]\d*$/.test(epoch)) throw new ToolError(`${file} declares Source-Date-Epoch '${epoch}', not a whole number of seconds`)
  return { version, epoch: Number(epoch) }
}

function walk(root: string, rel = ''): string[] {
  const out: string[] = []
  for (const name of readdirSync(join(root, rel)).sort()) {
    const path = rel ? `${rel}/${name}` : name
    out.push(path)
    if (lstatSync(join(root, path)).isDirectory()) out.push(...walk(root, path))
  }
  return out
}

/** dpkg-deb's Installed-Size: KiB per regular file or symlink, one per other entry. */
export function installedSize(root: string): number {
  let total = 0
  for (const path of walk(root)) {
    if (path === 'DEBIAN' || path.startsWith('DEBIAN/')) continue
    const stats = lstatSync(join(root, path))
    total += stats.isFile() || stats.isSymbolicLink() ? Math.ceil(stats.size / 1024) : 1
  }
  return total
}

/** The control file an archive carries, from its template. */
export function renderControl(template: string, request: PackRequest, size: number): string {
  const fields = controlFields(template)
  for (const field of REQUIRED) if (!fields[field]) throw new ToolError(`${request.control} declares no ${field}`)
  for (const field of WRITTEN) if (field in fields) throw new ToolError(`${request.control} declares ${field}, which the packer computes, writes or refuses`)
  declaration(template, request.control)
  if (!fields.Architecture!.includes('@ARCH@')) throw new ToolError(`${request.control} has an Architecture without @ARCH@`)
  if (!/^[a-z0-9][a-z0-9-]*$/.test(request.repository)) throw new ToolError(`'${request.repository}' is not a repository name (MICA_DEB_SOURCE_REPO)`)
  let text = template.split('\n').filter(line => !line.startsWith('Source-Date-Epoch:')).join('\n').replaceAll('@ARCH@', request.arch)
  for (const [name, value] of Object.entries(request.substitutions ?? {})) {
    if (!value) throw new ToolError(`the substitution \${${name}} is empty; it would leave a dangling separator in ${request.control}`)
    text = text.replaceAll(`\${${name}}`, value)
  }
  // Only relationship fields are substituted; a description may quote ${...} as prose.
  for (const [name, value] of Object.entries(controlFields(text)))
    if (RELATIONS.test(name) && /\$\{[^}]+\}/.test(value)) throw new ToolError(`${request.control} still carries an unexpanded substitution in ${name}`)
  return `${text.replace(/\n+$/, '')}\nInstalled-Size: ${size}\nMica-Source-Repo: ${request.repository}\n`
}

export function pack(request: PackRequest): string {
  const stage = request.root
  if (!existsSync(stage) || !statSync(stage).isDirectory() || readdirSync(stage).length === 0) throw new ToolError(`${stage} is not a non-empty staged tree`)
  if (existsSync(join(stage, 'DEBIAN'))) throw new ToolError(`${stage} already carries DEBIAN, which the packer owns`)
  if (!['amd64', 'arm64', 'all'].includes(request.arch)) throw new ToolError(`'${request.arch}' is not amd64, arm64 or all`)
  const template = readFileSync(request.control, 'utf8')
  const declared = declaration(template, request.control)
  if (request.epoch !== String(declared.epoch))
    throw new ToolError(`SOURCE_DATE_EPOCH='${request.epoch}' is not the ${declared.epoch} ${request.control} declares`)
  mkdirSync(request.out, { recursive: true })
  const work = join(request.out, `.pack-${basename(request.control)}-${process.pid}`)
  rmSync(work, { recursive: true, force: true })
  try {
    const root = join(work, 'root')
    cpSync(stage, root, { recursive: true, verbatimSymlinks: true })
    const control = renderControl(template, request, installedSize(root))
    const name = controlFields(control).Package!
    if (!/^[a-z0-9][a-z0-9+.-]+$/.test(name)) throw new ToolError(`'${name}' is not a Debian package name`)
    mkdirSync(join(root, 'DEBIAN'), { mode: 0o755 })
    writeFileSync(join(root, 'DEBIAN/control'), control, { mode: 0o644 })
    const sums = walk(root).filter(p => !p.startsWith('DEBIAN') && lstatSync(join(root, p)).isFile()).sort()
      .map(p => `${createHash('md5').update(readFileSync(join(root, p))).digest('hex')}  ${p}`)
    writeFileSync(join(root, 'DEBIAN/md5sums'), sums.length > 0 ? `${sums.join('\n')}\n` : '', { mode: 0o644 })
    if (request.scripts !== undefined) {
      const names = readdirSync(request.scripts).sort()
      if (names.length === 0) throw new ToolError(`${request.scripts} holds no maintainer script`)
      for (const script of names) {
        if (!MAINTAINER_SCRIPTS.has(script)) throw new ToolError(`'${script}' is not a maintainer script dpkg runs (preinst, postinst, prerm, postrm)`)
        writeFileSync(join(root, 'DEBIAN', script), readFileSync(join(request.scripts, script)))
        chmodSync(join(root, 'DEBIAN', script), 0o755)
      }
    }
    for (const path of [...walk(root), '']) lutimesSync(join(root, path), declared.epoch, declared.epoch)
    const deb = join(request.out, `${name}_${declared.version}_${request.arch}.deb`)
    rmSync(deb, { force: true })
    const built = run(['dpkg-deb', '--build', '--root-owner-group', '-Zxz', root, deb], { quiet: true, env: { SOURCE_DATE_EPOCH: String(declared.epoch) } })
    if (!built.ok) throw new ToolError(`dpkg-deb --build ${name} failed: ${built.err.trim()}`)
    verify(deb, stage, { 'Package': name, 'Version': declared.version, 'Architecture': request.arch, 'Mica-Source-Repo': request.repository })
    return deb
  }
  finally {
    rmSync(work, { recursive: true, force: true })
  }
}

/** The archive as built: its fields, no written-out field, root:root, and exactly the staged tree. */
function verify(deb: string, stage: string, want: Record<string, string>): void {
  const file = basename(deb)
  const fields = controlFields(controlText(deb))
  for (const [field, value] of Object.entries(want))
    if (fields[field] !== value) throw new ToolError(`${file} declares ${field}: ${fields[field] ?? '(none)'}, not ${value}`)
  for (const field of ['Mica-Source-Commit', 'Source-Date-Epoch']) if (field in fields) throw new ToolError(`${file} carries ${field}`)
  const entries = payloadEntries(deb)
  const foreign = entries.filter(e => e.uid !== 0 || e.gid !== 0)
  if (foreign.length > 0) throw new ToolError(`${file} carries paths not owned by root:root: ${foreign.slice(0, 3).map(e => e.name).join(', ')}`)
  const packed = entries.map(e => installedPath(e.name)).filter(p => p !== '').sort()
  if (packed.join('\n') !== walk(stage).sort().join('\n')) throw new ToolError(`the payload of ${file} is not the staged tree`)
}
