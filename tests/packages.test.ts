// The package commands of design 3.3: the inputs declaration and hash (3.3.1), the packer (3.3.2) and the pool
// gates (3.3.3). The packer and the gate fixtures need dpkg-deb, as the packer does where it runs.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { ToolError } from '../src/errors.ts'
import { controlEntries, controlFields, controlText, installedPath, payloadEntries } from '../src/deb/archive.ts'
import { pack, type PackRequest } from '../src/deb/pack.ts'
import { gate } from '../src/pool/gate.ts'
import { inputsHash, manifest, producerOf, producers, readDeclaration } from '../src/pool/inputs.ts'
import { ROOT } from './vectors.ts'

let scratch = ''
const sha256 = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex')

function write(path: string, body: string, mode = 0o644): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, body)
  chmodSync(path, mode)
}

function git(root: string, args: string[]): string {
  return Bun.spawnSync(['git', '-c', 'user.name=t', '-c', 'user.email=t@t', '-C', root, ...args], { stdout: 'pipe' }).stdout.toString().trim()
}

beforeAll(() => {
  mkdirSync(join(ROOT, '.tmp'), { recursive: true })
  scratch = mkdtempSync(join(ROOT, '.tmp/packages-'))
})

afterAll(() => rmSync(scratch, { recursive: true, force: true }))

describe('inputs', () => {
  const SOURCES = `# mica-lock v1\nsource\tbuild.micad.gcc\tamd64\t14\t${'b'.repeat(64)}\thttps://example.org/gcc_amd64.deb\n`
    + `source\tbuild.micad.gcc\tarm64\t14\t${'c'.repeat(64)}\thttps://example.org/gcc_arm64.deb\n`
    + `source\tbusybox\tall\t1.38.0\t${'a'.repeat(64)}\thttps://example.org/busybox.tar.bz2\n`
    + `git\tlinux\thttps://example.org/linux.git\tv6.12\t${'d'.repeat(40)}\n`

  function repo(): string {
    const root = mkdtempSync(join(scratch, 'inputs-'))
    git(root, ['init', '--quiet'])
    write(join(root, 'pkgs/micad/mica-inputs'), '# mica-inputs v1\n# the daemon\npackage micad\npackage mica-apid\npath crates\npath :(exclude,glob)crates/*/tests/**\nsource busybox\nsource build.micad.*\ngit linux\n')
    write(join(root, 'pkgs/micad/control'), 'Package: micad\n')
    write(join(root, 'pkgs/micad/build.sh'), '#!/bin/sh\n', 0o755)
    symlinkSync('../copyright', join(root, 'pkgs/micad/copyright'))
    write(join(root, 'crates/micad/src/main.rs'), 'fn main() {}\n')
    write(join(root, 'crates/micad/tests/t.rs'), '#[test] fn t() {}\n')
    write(join(root, 'locks/upstream.lock'), SOURCES)
    write(join(root, 'untracked.txt'), 'not added\n')
    git(root, ['add', 'pkgs', 'crates', 'locks'])
    return root
  }

  test('the manifest: files by path, then rows, then the architecture', () => {
    const root = repo()
    const declaration = readDeclaration(root, 'pkgs/micad')
    expect(declaration.packages).toEqual(['micad', 'mica-apid'])
    const lines = manifest(root, declaration, 'amd64')
    expect(lines).toEqual([
      `${sha256('fn main() {}\n')} - crates/micad/src/main.rs`,
      `${sha256('#!/bin/sh\n')} x pkgs/micad/build.sh`,
      `${sha256('Package: micad\n')} - pkgs/micad/control`,
      `${sha256('link:../copyright')} l pkgs/micad/copyright`,
      `${sha256(readFileSync(join(root, 'pkgs/micad/mica-inputs')))} - pkgs/micad/mica-inputs`,
      `row git linux https://example.org/linux.git v6.12 ${'d'.repeat(40)}`,
      `row source build.micad.gcc amd64 14 ${'b'.repeat(64)} https://example.org/gcc_amd64.deb`,
      `row source busybox all 1.38.0 ${'a'.repeat(64)} https://example.org/busybox.tar.bz2`,
      'arch amd64',
    ])
    expect(inputsHash(root, declaration, 'amd64')).toBe(sha256(lines.map(l => l + '\n').join('')))
    expect(manifest(root, declaration, 'all').filter(l => l.startsWith('row source build'))).toHaveLength(2)
    expect(inputsHash(root, declaration, 'arm64')).not.toBe(inputsHash(root, declaration, 'amd64'))
    expect(producerOf(root, 'mica-apid').dir).toBe('pkgs/micad')
  })

  test('a changed input changes the hash; an excluded or untracked file does not', () => {
    const root = repo()
    const declaration = readDeclaration(root, 'pkgs/micad')
    const before = inputsHash(root, declaration, 'amd64')
    write(join(root, 'crates/micad/tests/t.rs'), 'changed\n')
    write(join(root, 'untracked.txt'), 'changed\n')
    expect(inputsHash(root, declaration, 'amd64')).toBe(before)
    chmodSync(join(root, 'crates/micad/src/main.rs'), 0o755)
    expect(inputsHash(root, declaration, 'amd64')).not.toBe(before)
  })

  test('a stale declaration is refused', () => {
    const root = repo()
    const refused = (body: string, message: string) => {
      write(join(root, 'pkgs/micad/mica-inputs'), body)
      expect(() => manifest(root, readDeclaration(root, 'pkgs/micad'), 'amd64')).toThrow(message)
    }
    refused('# mica-inputs v1\npackage micad\npath gone\n', 'path gone matches no tracked file')
    refused('# mica-inputs v1\npackage micad\nsource nothing\n', 'source nothing names no row')
    refused('# mica-inputs v1\npackage micad\ngit nothing\n', 'git nothing names no row')
    refused('# mica-inputs v1\nwhat micad\n', 'is not a declaration line')
    refused('# mica-inputs v2\npackage micad\n', 'is not \'# mica-inputs v1\'')
    write(join(root, 'pkgs/other/mica-inputs'), '# mica-inputs v1\npackage micad\n')
    write(join(root, 'pkgs/micad/mica-inputs'), '# mica-inputs v1\npackage micad\n')
    git(root, ['add', 'pkgs'])
    expect(() => producers(root)).toThrow('declared by pkgs/micad and pkgs/other')
  })
})

const TEMPLATE = 'Package: mica-test\nVersion: 1.0.0-1\nSource-Date-Epoch: 1789430400\nArchitecture: @ARCH@\nMaintainer: Mica <mica@example.org>\n'
  + 'Section: misc\nPriority: optional\nDepends: ${shlibs:Depends}, mica-base\nDescription: a test package\n quoting ${prose} in a description\n'

function stage(dir: string, name = 'mica-test'): string {
  write(join(dir, `usr/share/doc/${name}/copyright`), 'Copyright: Mica\n')
  write(join(dir, `usr/bin/${name}`), '#!/bin/sh\necho hi\n', 0o755)
  mkdirSync(join(dir, 'etc/systemd/system/multi-user.target.wants'), { recursive: true })
  symlinkSync(`/usr/lib/systemd/system/${name}.service`, join(dir, `etc/systemd/system/multi-user.target.wants/${name}.service`))
  return dir
}

function request(dir: string, template = TEMPLATE, extra: Partial<PackRequest> = {}): PackRequest {
  write(join(dir, 'control'), template)
  return { root: stage(join(dir, 'stage')), control: join(dir, 'control'), arch: 'amd64', out: join(dir, 'out'), repository: 'mica-core', epoch: '1789430400', substitutions: { 'shlibs:Depends': 'libc6 (>= 2.36)' }, ...extra }
}

describe('deb pack', () => {
  test('the packing contract (design 3.3.2)', () => {
    const dir = mkdtempSync(join(scratch, 'pack-'))
    const scripts = join(dir, 'scripts')
    write(join(scripts, 'postinst'), '#!/bin/sh\nset -e\n', 0o644)
    const deb = pack(request(dir, TEMPLATE, { scripts }))
    expect(deb).toBe(join(dir, 'out/mica-test_1.0.0-1_amd64.deb'))
    const fields = controlFields(controlText(deb))
    expect(fields).toMatchObject({ 'Package': 'mica-test', 'Version': '1.0.0-1', 'Architecture': 'amd64', 'Depends': 'libc6 (>= 2.36), mica-base', 'Mica-Source-Repo': 'mica-core', 'Installed-Size': '12' })
    expect(fields.Description).toContain('${prose}')
    expect('Source-Date-Epoch' in fields).toBe(false)
    const control = controlEntries(deb)
    expect(new TextDecoder().decode(control.find(e => installedPath(e.name) === 'md5sums')!.body))
      .toBe(`${createHash('md5').update('#!/bin/sh\necho hi\n').digest('hex')}  usr/bin/mica-test\n${createHash('md5').update('Copyright: Mica\n').digest('hex')}  usr/share/doc/mica-test/copyright\n`)
    expect(control.find(e => installedPath(e.name) === 'postinst')!.mode & 0o777).toBe(0o755)
    const payload = payloadEntries(deb)
    expect(payload.every(e => e.uid === 0 && e.gid === 0 && e.mtime === 1789430400)).toBe(true)
    expect(payload.find(e => installedPath(e.name) === 'etc/systemd/system/multi-user.target.wants/mica-test.service')!.linkname).toBe('/usr/lib/systemd/system/mica-test.service')
  })

  test('two packs of one tree are the same bytes', () => {
    const a = pack(request(mkdtempSync(join(scratch, 'pack-'))))
    const b = pack(request(mkdtempSync(join(scratch, 'pack-'))))
    expect(sha256(readFileSync(a))).toBe(sha256(readFileSync(b)))
  })

  test.each([
    [TEMPLATE.replace('Section: misc\n', 'Section: misc\nMica-Source-Commit: abc\n'), {}, 'declares Mica-Source-Commit'],
    [TEMPLATE.replace('Section: misc\n', 'Section: misc\nInstalled-Size: 1\n'), {}, 'declares Installed-Size'],
    [TEMPLATE.replace('1.0.0-1', '1.0.0+git0123456789ab-1'), {}, 'not a Debian version of its own'],
    [TEMPLATE, { epoch: '1' }, 'is not the 1789430400'],
    [TEMPLATE, { substitutions: {} }, 'unexpanded substitution in Depends'],
    [TEMPLATE, { substitutions: { 'shlibs:Depends': '' } }, 'is empty'],
    [TEMPLATE.replace('@ARCH@', 'amd64'), {}, 'Architecture without @ARCH@'],
    [TEMPLATE, { repository: '' }, 'is not a repository name'],
  ] as [string, Partial<PackRequest>, string][])('refused: %#', (template, extra, message) => {
    expect(() => pack(request(mkdtempSync(join(scratch, 'pack-')), template, extra))).toThrow(message)
  })

  test('a maintainer script dpkg does not run, and a staged DEBIAN, are refused', () => {
    const dir = mkdtempSync(join(scratch, 'pack-'))
    write(join(dir, 'scripts/config'), '#!/bin/sh\n')
    expect(() => pack(request(dir, TEMPLATE, { scripts: join(dir, 'scripts') }))).toThrow('not a maintainer script dpkg runs')
    const other = mkdtempSync(join(scratch, 'pack-'))
    const r = request(other)
    mkdirSync(join(r.root, 'DEBIAN'))
    expect(() => pack(r)).toThrow('already carries DEBIAN')
  })
})

/** A pool archive built straight with dpkg-deb, so a fixture can break what the packer would refuse. */
function archive(pool: string, control: Record<string, string>, files: Record<string, string>, extra: Record<string, string> = {}): void {
  const dir = mkdtempSync(join(scratch, 'deb-'))
  for (const [path, body] of Object.entries(files)) write(join(dir, path), body)
  const fields: Record<string, string> = { Version: '1.0-1', Maintainer: 'Mica <mica@example.org>', Description: 'x', ...control }
  write(join(dir, 'DEBIAN/control'), Object.entries(fields).map(([k, v]) => `${k}: ${v}`).join('\n') + '\n')
  for (const [name, body] of Object.entries(extra)) write(join(dir, 'DEBIAN', name), body, 0o755)
  mkdirSync(pool, { recursive: true })
  const r = Bun.spawnSync(['dpkg-deb', '--root-owner-group', '-Zxz', '--build', dir, join(pool, `${fields.Package}_${fields.Version}_${fields.Architecture}.deb`)], { stderr: 'pipe' })
  if (r.exitCode !== 0) throw new Error(r.stderr.toString())
}

describe('pool gate', () => {
  const good = (name: string, arch = 'amd64', more: Record<string, string> = {}) =>
    [{ 'Package': name, 'Architecture': arch, 'Mica-Source-Repo': 'mica-core', ...more }, { [`usr/share/doc/${name}/copyright`]: 'c\n', [`usr/lib/${name}/file`]: name }] as const

  test('a clean pool passes; every generic gate refuses its defect', () => {
    const debs = mkdtempSync(join(scratch, 'gate-'))
    archive(join(debs, 'amd64/pool'), ...good('mica-a'))
    archive(join(debs, 'amd64/pool'), ...good('mica-all', 'all'))
    archive(join(debs, 'arm64/pool'), ...good('mica-all', 'all'))
    archive(join(debs, 'amd64/pool'), { 'Package': 'mica-x', 'Architecture': 'amd64', 'Mica-Source-Repo': 'mica-core', 'Conflicts': 'mica-y' }, { 'usr/share/doc/mica-x/copyright': 'c\n', 'usr/bin/shared': 'x' })
    archive(join(debs, 'amd64/pool'), { 'Package': 'mica-y', 'Architecture': 'amd64', 'Mica-Source-Repo': 'mica-core', 'Conflicts': 'mica-x' }, { 'usr/share/doc/mica-y/copyright': 'c\n', 'usr/bin/shared': 'y' })
    expect(gate(debs, ['amd64', 'arm64'])).toEqual({ archives: 5, problems: [] })

    const bad = mkdtempSync(join(scratch, 'gate-'))
    const pool = join(bad, 'amd64/pool')
    archive(pool, ...good('mica-replaces', 'amd64', { Replaces: 'mica-a' }))
    archive(pool, ...good('mica-commit', 'amd64', { 'Mica-Source-Commit': 'a'.repeat(40) }))
    archive(pool, { Package: 'mica-norepo', Architecture: 'amd64' }, { 'usr/share/doc/mica-norepo/copyright': 'c\n' })
    archive(pool, ...good('mica-stamp', 'amd64', { Version: '1.0+git0123456789ab-1' }))
    archive(pool, ...good('mica-arm', 'arm64'))
    archive(pool, { 'Package': 'mica-nocopy', 'Architecture': 'amd64', 'Mica-Source-Repo': 'mica-core' }, { 'usr/share/doc/mica-nocopy/copyright': '' })
    archive(pool, { 'Package': 'mica-conf', 'Architecture': 'amd64', 'Mica-Source-Repo': 'mica-core' }, { 'usr/share/doc/mica-conf/copyright': 'c\n', 'etc/x': 'x' }, { conffiles: '/etc/x\n' })
    archive(pool, ...good('mica-script'), { postinst: '#!/bin/sh\nif then\n' })
    archive(pool, { 'Package': 'mica-p', 'Architecture': 'amd64', 'Mica-Source-Repo': 'mica-core' }, { 'usr/share/doc/mica-p/copyright': 'c\n', 'usr/bin/both': 'p' })
    archive(pool, { 'Package': 'mica-q', 'Architecture': 'amd64', 'Mica-Source-Repo': 'mica-core', 'Conflicts': 'mica-p' }, { 'usr/share/doc/mica-q/copyright': 'c\n', 'usr/bin/both': 'q' })
    archive(pool, ...good('mica-all', 'all'))
    archive(join(bad, 'arm64/pool'), { 'Package': 'mica-all', 'Architecture': 'all', 'Mica-Source-Repo': 'mica-core' }, { 'usr/share/doc/mica-all/copyright': 'other\n' })
    const { problems } = gate(bad, ['amd64', 'arm64'])
    const said = (file: string, what: string) => expect(problems.some(p => p.includes(file) && p.includes(what))).toBe(true)
    said('mica-replaces_', 'declares Replaces')
    said('mica-commit_', 'carries Mica-Source-Commit')
    said('mica-norepo_', 'carries no Mica-Source-Repo')
    said('mica-stamp_', 'carries a commit or dirty stamp')
    said('amd64/pool/mica-arm_', 'is Architecture arm64')
    said('mica-nocopy_', 'no non-empty /usr/share/doc/mica-nocopy/copyright')
    said('mica-conf_', 'carries DEBIAN/conffiles')
    said('mica-script_', 'postinst is not valid POSIX sh')
    said('mica-q_', 'ships /usr/bin/both, which mica-p_1.0-1_amd64.deb ships too')
    said('arm64/pool/mica-all_', 'an all archive is the same bytes in every pool')
    expect(problems).toHaveLength(10)
  })

  test('a valid maintainer script passes', () => {
    const debs = mkdtempSync(join(scratch, 'gate-'))
    archive(join(debs, 'amd64/pool'), ...good('mica-ok'), { postinst: '#!/bin/sh\nset -e\nif [ -x /bin/true ]; then /bin/true; fi\n', prerm: '#!/bin/sh\nexit 0\n' })
    expect(gate(debs, ['amd64'])).toEqual({ archives: 1, problems: [] })
  })

  test('an empty pool is an error, not a pass', () => {
    expect(() => gate(mkdtempSync(join(scratch, 'gate-')), ['amd64'])).toThrow(ToolError)
  })
})
