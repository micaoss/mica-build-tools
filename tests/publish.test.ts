// The publishing path end to end against a stand-in for ghcr.io and GitHub (tests/stubs.ts): pack, guard, publish
// the pool, attach the lock, then every refusal the package-version decision and build-rules.md section 1 name.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { main } from '../src/cli.ts'
import { poolManifest } from '../src/release/pool.ts'
import { Stub } from './stubs.ts'
import { ROOT } from './vectors.ts'

let scratch = '', repo = '', stub: Stub
const sha256 = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex')

async function run(argv: string[], env: Record<string, string> = {}): Promise<{ code: number, out: string, err: string }> {
  const saved = { ...process.env }
  for (const k of ['CI', 'GITHUB_ACTIONS', 'MICA_OFFLINE', 'GITHUB_ACTOR']) delete process.env[k]
  Object.assign(process.env, { MICA_REPO_ROOT: repo, ...stub.env('mica-core'), ...env })
  const out: string[] = [], err: string[] = []
  try {
    const code = await main(argv, { out: l => out.push(l), err: l => err.push(l) })
    return { code, out: out.join('\n'), err: err.join('\n') }
  }
  finally {
    for (const k of Object.keys(process.env)) delete process.env[k]
    Object.assign(process.env, saved)
  }
}

function write(path: string, body: string, mode = 0o644): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, body)
  chmodSync(path, mode)
}

function git(args: string[]): string {
  return Bun.spawnSync(['git', '-c', 'user.name=t', '-c', 'user.email=t@t', '-C', repo, ...args], { stdout: 'pipe' }).stdout.toString().trim()
}

function template(version: string): string {
  return `Package: micad\nVersion: ${version}\nSource-Date-Epoch: 1789430400\nArchitecture: @ARCH@\nMaintainer: Mica <mica@example.org>\nSection: admin\nPriority: optional\nDescription: the daemon\n`
}

/** Packs pkgs/micad into _out/debs/amd64/pool and commits the tree, so HEAD is clean. */
async function build(version: string, source = 'fn main() {}\n'): Promise<string> {
  write(join(repo, 'pkgs/micad/control'), template(version))
  write(join(repo, 'src/main.rs'), source)
  git(['add', '-A'])
  git(['commit', '--quiet', '-m', `micad ${version}`])
  rmSync(join(repo, '_out/debs/amd64/pool'), { recursive: true, force: true })
  const stage = join(repo, '_out/stage')
  rmSync(stage, { recursive: true, force: true })
  write(join(stage, 'usr/share/doc/micad/copyright'), 'Copyright: Mica\n')
  write(join(stage, 'usr/bin/micad'), source, 0o755)
  const r = await run(['deb', 'pack', '--root', stage, '--control', join(repo, 'pkgs/micad/control'), '--arch', 'amd64', '--out', join(repo, '_out/debs/amd64/pool')],
    { SOURCE_DATE_EPOCH: '1789430400', MICA_DEB_SOURCE_REPO: 'mica-core' })
  expect(r).toMatchObject({ code: 0 })
  return r.out
}

/** Cuts a release on the stub: the tag names HEAD, and HEAD is on origin/main. */
function cut(tag: string, repository = 'mica-core'): void {
  const head = git(['rev-parse', 'HEAD'])
  git(['update-ref', 'refs/remotes/origin/main', head])
  stub.tagRefs.set(`${repository}:${tag}`, { type: 'commit', sha: head })
}

async function lockOf(tag: string, rows: string): Promise<string> {
  const path = join(repo, '_out', `mica-core.${tag}.lock`)
  write(path, `# mica-lock v1\nrelease\tmica-core\t${tag}\t${git(['rev-parse', 'HEAD'])}\n${rows === '' ? '' : `${rows}\n`}`)
  return path
}

beforeAll(() => {
  mkdirSync(join(ROOT, '.tmp'), { recursive: true })
  scratch = mkdtempSync(join(ROOT, '.tmp/publish-'))
  repo = join(scratch, 'mica-core')
  mkdirSync(repo, { recursive: true })
  git(['init', '--quiet'])
  write(join(repo, '.gitignore'), '_out/\n')
  write(join(repo, 'pkgs/micad/mica-inputs'), '# mica-inputs v1\npackage micad\npath src\n')
  stub = new Stub()
})

afterAll(() => {
  stub.stop()
  rmSync(scratch, { recursive: true, force: true })
})

describe('release check', () => {
  test('the preconditions of build-rules.md section 1, each refused by name; then the commit the tag names', async () => {
    await build('0.3.0-0')
    await build('0.3.0-1')
    const head = git(['rev-parse', 'HEAD'])
    const refused = async (tag: string, what: string, env: Record<string, string> = {}) => {
      const r = await run(['release', 'check', tag], env)
      expect(r.code).toBe(1)
      expect(r.err).toContain(what)
    }
    await refused('20260926', 'is not a release tag')
    await refused('202609261000', 'is not a release tag')
    await refused('uefi-x64.20260920-1000', 'no scoped releases')
    await refused('20261301-1200', 'is not a UTC time')
    await refused('20260230-1200', 'is not a UTC time')
    await refused('20260926-2460', 'is not a UTC time')
    await refused('29990101-0000', 'is a time in the future')
    await refused('20260925-1000', `does not exist in mica-core; cut the release with gh release create 20260925-1000 --target ${head}`)
    stub.tagRefs.set('mica-core:20260925-1000', { type: 'commit', sha: '502' })
    await refused('20260925-1000', 'could not read 20260925-1000 in mica-core (HTTP 502)')
    stub.tagRefs.set('mica-core:20260925-1000', { type: 'tag', sha: head })
    await refused('20260925-1000', 'names an annotated tag, not a commit')
    stub.tagRefs.set('mica-core:20260925-1000', { type: 'commit', sha: 'a'.repeat(40) })
    await refused('20260925-1000', `names ${'a'.repeat(40)}, not the checked-out commit ${head}`)
    stub.tagRefs.set('mica-core:20260925-1000', { type: 'commit', sha: head })
    git(['update-ref', '-d', 'refs/remotes/origin/main'])
    await refused('20260925-1000', 'has no origin/main')
    git(['update-ref', 'refs/remotes/origin/main', `${head}~1`])
    await refused('20260925-1000', `${head} is not on origin/main`)
    git(['update-ref', 'refs/remotes/origin/main', head])
    write(join(repo, 'src/main.rs'), 'dirty\n')
    await refused('20260925-1000', 'uncommitted changes')
    git(['checkout', '--', 'src/main.rs'])
    expect(await run(['release', 'check', '20260925-1000'])).toMatchObject({ code: 0, out: head })
    // A scoped repository accepts a scoped tag, and only a scoped one.
    stub.tagRefs.set('mica-build:uefi-x64.20260925-1000', { type: 'commit', sha: head })
    expect(await run(['release', 'check', 'uefi-x64.20260925-1000'], { MICA_SOURCE_REPO: 'mica-build' })).toMatchObject({ code: 0, out: head })
    await refused('20260925-1000', 'is not a scoped release tag', { MICA_SOURCE_REPO: 'mica-build' })
  })

  test('release pool and release attach run it before anything is written', async () => {
    await build('0.3.0-2')
    const r = await run(['release', 'pool', '20260925-1200'])
    expect([r.code, stub.tags.has('micaoss/mica-core:pool.amd64.20260925-1200')]).toEqual([1, false])
    expect(r.err).toContain('does not exist in mica-core')
    const a = await run(['release', 'attach', '20260925-1200', await lockOf('20260925-1200', '')])
    expect([a.code, stub.releases.get('mica-core')?.some(x => x.tag_name === '20260925-1200') ?? false]).toEqual([1, false])
    expect(a.err).toContain('does not exist in mica-core')
  })
})

describe('publishing', () => {
  test('pack, guard, pool, attach; reuse; every refusal', async () => {
    // No release yet: everything is new.
    const first = await build('0.1.0-1')
    expect(await run(['pool', 'guard', 'amd64', first])).toMatchObject({ code: 0, out: `amd64 micad 0.1.0-1 new ${sha256(readFileSync(first))}` })

    // The pool, in the indented form, read back anonymously; the rows of the lock are printed.
    cut('20260920-1000')
    const published = await run(['release', 'pool', '20260920-1000'])
    expect(published.code).toBe(0)
    const [poolRow, packageRow] = published.out.split('\n')
    expect(packageRow).toBe(`package\tmicad\tamd64\t0.1.0-1\t${sha256(readFileSync(first))}`)
    const digest = stub.tags.get('micaoss/mica-core:pool.amd64.20260920-1000')!
    expect(poolRow).toBe(`pool\tamd64\tghcr.io/micaoss/mica-core:pool.amd64.20260920-1000@${digest}`)
    const inputs = (await run(['inputs', 'pkgs/micad', 'amd64'])).out
    const expected = poolManifest('mica-core', 'amd64', [{ title: 'micad_0.1.0-1_amd64.deb', digest: `sha256:${sha256(readFileSync(first))}`, size: readFileSync(first).length, inputs }])
    expect(new TextDecoder().decode(stub.manifests.get(digest)!)).toBe(new TextDecoder().decode(expected))
    expect(new TextDecoder().decode(expected)).toStartWith('{\n  "schemaVersion": 2,\n  "mediaType": "application/vnd.oci.image.manifest.v1+json",\n  "artifactType": "application/vnd.mica.pool",')
    // Publishing the same pool again adds nothing and changes nothing.
    expect(await run(['release', 'pool', '20260920-1000'])).toMatchObject({ code: 0, out: published.out })

    // The lock and SHA256SUMS on the release; the notes say there is nothing to compare with.
    stub.release('mica-core', '20260920-1000')
    const lock = await lockOf('20260920-1000', published.out)
    const attached = await run(['release', 'attach', '20260920-1000', lock])
    expect(attached.code).toBe(0)
    expect(attached.out).toContain('mica-core.lock: attached')
    const release = stub.releases.get('mica-core')![0]!
    expect(release.body).toBe('Notes.\n\n<!-- mica-tools release attach -->\nPools: the first release carrying mica-core.lock.\nPackages: the first release carrying mica-core.lock.\n')
    expect(new TextDecoder().decode(release.assets.find(a => a.name === 'SHA256SUMS')!.bytes)).toBe(`${sha256(readFileSync(lock))}  mica-core.lock\n`)
    // Again: present, and the notes are not appended twice.
    expect((await run(['release', 'attach', '20260920-1000', lock])).out).toContain('mica-core.lock: present')
    expect(release.body!.split('<!-- mica-tools release attach -->').length).toBe(2)

    // The same version, the same inputs and bytes: reused.
    expect(await run(['pool', 'guard', 'amd64', first])).toMatchObject({ code: 0, out: `amd64 micad 0.1.0-1 reused ${sha256(readFileSync(first))}` })

    // Inputs changed without a bump: refused.
    const changed = await build('0.1.0-1', 'fn main() { changed() }\n')
    const refused = await run(['pool', 'guard', 'amd64', changed])
    expect(refused.code).toBe(1)
    expect(refused.err).toContain('inputs of micad changed without a version bump')

    // Bumped: new; published under a later release, whose notes compare the rows.
    const bumped = await build('0.1.0-2', 'fn main() { changed() }\n')
    expect((await run(['pool', 'guard', 'amd64', bumped])).out).toContain(' new ')
    cut('20260921-1000')
    const second = await run(['release', 'pool', '20260921-1000'])
    stub.release('mica-core', '20260921-1000')
    expect((await run(['release', 'attach', '20260921-1000', await lockOf('20260921-1000', second.out)])).code).toBe(0)
    const notes = stub.releases.get('mica-core')![1]!.body!
    // The pool's tag names the release and always differs; its digest changed because a package did.
    expect(notes).toContain('Pools: changed from 20260920-1000.\nPackages: changed from 20260920-1000.\n')
    expect(notes).toContain('- package micad amd64 0.1.0-1')
    expect(notes).toContain('+ package micad amd64 0.1.0-2')

    // A version that goes back: refused.
    const lower = await build('0.1.0-1')
    expect((await run(['pool', 'guard', 'amd64', lower])).err).toContain('lower than 0.1.0-2')
    // Against the earlier release, --before names it.
    expect((await run(['pool', 'guard', '--before', '20260921-1000', 'amd64', lower])).out).toContain(' reused ')

    // A published tag is never re-pointed: the release is re-cut on the lower build, and its pool differs.
    cut('20260921-1000')
    const moved = await run(['release', 'pool', '20260921-1000'])
    expect(moved.code).toBe(1)
    expect(moved.err).toContain('a published tag is never re-pointed')

    // No asset goes to a release older than the latest.
    stub.release('mica-core', '20260919-0900')
    cut('20260919-0900')
    const old = await run(['release', 'attach', '20260919-0900', await lockOf('20260919-0900', published.out)])
    expect(old.code).toBe(1)
    expect(old.err).toContain('has releases later than 20260919-0900')
  })

  test('a scoped tag is refused by attach and guard, which know no scope', async () => {
    const lock = await lockOf('20260923-0900', '')
    expect(await run(['release', 'attach', 'uefi-x64.20260923-0900', lock])).toMatchObject({ code: 1, out: 'refused release-scope' })
    expect(await run(['pool', 'guard', '--before', 'uefi-x64.20260923-0900', 'amd64', lock])).toMatchObject({ code: 1, out: 'refused release-scope' })
  })

  test('an asset that cannot be re-read is not called a conflict', async () => {
    stub.release('mica-core', '20260922-0900')
    cut('20260922-0900')
    const lock = await lockOf('20260922-0900', '')
    expect((await run(['release', 'attach', '20260922-0900', lock])).code).toBe(0)
    const release = stub.releases.get('mica-core')!.find(r => r.tag_name === '20260922-0900')!
    release.assets[0]!.url = `${stub.url}/download/mica-core/nothing/mica-core.lock`
    const r = await run(['release', 'attach', '20260922-0900', lock])
    expect(r.code).toBe(1)
    expect(r.err).toContain('HTTP 404')
    expect(r.err).not.toContain('other bytes')
  })

  test('a dirty tree, a foreign archive and a missing token are refused', async () => {
    await build('0.2.0-1')
    cut('20260924-1000')
    cut('20260924-1000', 'mica-podman')
    write(join(repo, 'src/main.rs'), 'dirty\n')
    expect((await run(['release', 'pool', '20260924-1000'])).err).toContain('uncommitted changes')
    git(['checkout', '--', 'src/main.rs'])
    expect((await run(['release', 'pool', '20260924-1000'], { MICA_SOURCE_REPO: 'mica-podman' })).err).toContain('is of mica-core')
    expect((await run(['release', 'pool', '20260924-1000'], { GITHUB_TOKEN: '' })).err).toContain('needs a token')
  })
})

describe('release attach with data assets', () => {
  const D = (name: string, body: string) => ({ name, body: new TextEncoder().encode(body) })
  const amd = D('mica-core-unowned.amd64.tsv', '#path\twriter\n/etc/x\tsystemd.postrm\n')
  const arm = D('mica-core-unowned.arm64.tsv', '#path\twriter\n/etc/y\tsystemd.postrm\n')
  const rows = () => [`data\tunowned.amd64\t${amd.name}\t${sha256(amd.body)}`, `data\tunowned.arm64\t${arm.name}\t${sha256(arm.body)}`].join('\n')
  const file = (d: { name: string, body: Uint8Array }, dir = 'data') => { const p = join(repo, '_out', dir, d.name); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, d.body); return p }
  const assetsOf = (tag: string) => stub.releases.get('mica-core')!.find(r => r.tag_name === tag)!.assets.map(a => a.name)

  test('the data files, then the lock, then SHA256SUMS; each read back; a rerun is a no-op', async () => {
    await build('0.4.0-1')
    cut('20260924-1300')
    stub.release('mica-core', '20260924-1300')
    const lock = await lockOf('20260924-1300', rows())
    const r = await run(['release', 'attach', '20260924-1300', lock, '--data', file(amd), '--data', file(arm)])
    expect(r.code).toBe(0)
    expect(assetsOf('20260924-1300')).toEqual([amd.name, arm.name, 'mica-core.lock', 'SHA256SUMS'])
    expect(r.out.split('\n').slice(0, 4)).toEqual([`${amd.name}: attached`, `${arm.name}: attached`, 'mica-core.lock: attached', 'SHA256SUMS: attached'])
    const release = stub.releases.get('mica-core')!.find(x => x.tag_name === '20260924-1300')!
    expect(new TextDecoder().decode(release.assets.find(a => a.name === 'SHA256SUMS')!.bytes)).toBe(`${sha256(readFileSync(lock))}  mica-core.lock\n`)
    expect(release.body).toContain('Data: changed from 20260922-0900.')
    expect(release.body).toContain(`+ data unowned.amd64 ${amd.name} ${sha256(amd.body)}`)
    const again = await run(['release', 'attach', '20260924-1300', lock, '--data', file(amd), '--data', file(arm)])
    expect(again.code).toBe(0)
    expect(again.out.split('\n').slice(0, 4)).toEqual([`${amd.name}: present`, `${arm.name}: present`, 'mica-core.lock: present', 'SHA256SUMS: present'])
    expect(assetsOf('20260924-1300')).toHaveLength(4)
  })

  test('every refusal, before anything is written', async () => {
    await build('0.4.0-2')
    cut('20260924-1400')
    stub.release('mica-core', '20260924-1400')
    const lock = await lockOf('20260924-1400', rows())
    const refused = async (argv: string[], what: string) => {
      const r = await run(['release', 'attach', '20260924-1400', lock, ...argv])
      expect(r.code).toBe(1)
      expect(r.err).toContain(what)
      expect(assetsOf('20260924-1400')).toEqual([])
    }
    await refused(['--data', file(amd)], `${arm.name} is named by a data row and no --data file`)
    await refused(['--data', file(amd), '--data', file(arm), '--data', file(D('extra.tsv', 'x'))], 'extra.tsv is no data row of the lock')
    await refused(['--data', file(amd), '--data', file(D(arm.name, 'other\n'))], `${arm.name} hashes to ${sha256('other\n')}, and its data row says ${sha256(arm.body)}`)
    await refused(['--data', file(amd), '--data', file(amd, 'again'), '--data', file(arm)], `${amd.name} is given twice`)
    await refused(['--data', join(repo, '_out/data/missing.tsv')], 'missing.tsv does not exist')
    // A release carrying anything else is refused.
    const release = stub.releases.get('mica-core')!.find(x => x.tag_name === '20260924-1400')!
    release.assets.push({ id: 999, name: 'stray.bin', url: `${stub.url}/download/mica-core/20260924-1400/stray.bin`, bytes: new Uint8Array(1) })
    const r = await run(['release', 'attach', '20260924-1400', lock, '--data', file(amd), '--data', file(arm)])
    expect(r.code).toBe(1)
    expect(r.err).toContain('carries stray.bin; a release carries')
    expect(assetsOf('20260924-1400')).toEqual(['stray.bin'])
  })

  test('a lock with no data row takes no --data', async () => {
    await build('0.4.0-3')
    cut('20260924-1500')
    stub.release('mica-core', '20260924-1500')
    const r = await run(['release', 'attach', '20260924-1500', await lockOf('20260924-1500', ''), '--data', file(amd)])
    expect(r.code).toBe(1)
    expect(r.err).toContain(`${amd.name} is no data row of the lock`)
  })
})

describe('pool items (lock 1.2.7)', () => {
  const pool = () => join(repo, '_out/debs/amd64/pool')
  /** Writes the item <name>_<version>_amd64.<type> into an otherwise empty pool. */
  const item = (type: string, name: string, version: string, body: string) => {
    rmSync(pool(), { recursive: true, force: true })
    mkdirSync(pool(), { recursive: true })
    const path = join(pool(), `${name}_${version}_amd64.${type}`)
    writeFileSync(path, body)
    return path
  }
  const commit = (source: string) => {
    write(join(repo, 'pkgs/report/mica-inputs'), '# mica-inputs v1\npackage mica-report\npath report\n')
    write(join(repo, 'report/source.txt'), source)
    git(['add', '-A'])
    git(['commit', '--quiet', '-m', `report ${source.length}`])
  }

  test('guard, pool, attach, reuse: a file of any type is a layer and a row, with no code for the type', async () => {
    commit('one\n')
    const file = item('sbom.json.zst', 'mica-report', '1.0.0', 'sbom one')
    const sum = sha256('sbom one')
    expect(await run(['pool', 'guard', 'amd64', file])).toMatchObject({ code: 0, out: `amd64 mica-report 1.0.0 new ${sum}` })
    writeFileSync(join(pool(), 'mica-report_1.0.0_amd64.notes'), 'notes one')

    cut('20260927-1000')
    const published = await run(['release', 'pool', '20260927-1000'])
    expect(published).toMatchObject({ code: 0 })
    const [poolRow, ...rows] = published.out.split('\n')
    expect(rows).toEqual([
      `item\tnotes\tmica-report\tamd64\t1.0.0\t${sha256('notes one')}`,
      `item\tsbom.json.zst\tmica-report\tamd64\t1.0.0\t${sum}`,
    ])
    const manifest = JSON.parse(new TextDecoder().decode(stub.manifests.get(stub.tags.get('micaoss/mica-core:pool.amd64.20260927-1000')!)!)) as { layers: { mediaType: string, annotations: Record<string, string> }[] }
    expect(manifest.layers.map(l => [l.annotations['org.opencontainers.image.title'], l.mediaType])).toEqual([
      ['mica-report_1.0.0_amd64.notes', 'application/vnd.mica.item.notes'],
      ['mica-report_1.0.0_amd64.sbom.json.zst', 'application/vnd.mica.item.sbom.json.zst'],
    ])
    expect(manifest.layers.every(l => /^[0-9a-f]{64}$/.test(l.annotations['mica.inputs']!))).toBe(true)
    stub.release('mica-core', '20260927-1000')
    const lock = await lockOf('20260927-1000', [poolRow, ...rows].join('\n'))
    expect(await run(['lock', 'rows', lock, 'item'])).toMatchObject({ code: 0, out: rows.join('\n') })
    const attached = await run(['release', 'attach', '20260927-1000', lock])
    expect(attached).toMatchObject({ code: 0 })
    expect(stub.releases.get('mica-core')!.find(r => r.tag_name === '20260927-1000')!.body).toContain('Pool items: ')

    // The same version with the same inputs and bytes is reused; other bytes are refused.
    expect((await run(['pool', 'guard', 'amd64', item('sbom.json.zst', 'mica-report', '1.0.0', 'sbom one')])).out).toBe(`amd64 mica-report 1.0.0 reused ${sum}`)
    expect((await run(['pool', 'guard', 'amd64', item('sbom.json.zst', 'mica-report', '1.0.0', 'sbom two')])).err).toContain('its bytes moved, so bump its version')
    // Another type of the same name and version is another row: new.
    expect((await run(['pool', 'guard', 'amd64', item('spdx', 'mica-report', '1.0.0', 'spdx')])).out).toContain(' new ')
    // Changed inputs without a bump are refused; a bump is new; a version never goes back.
    commit('two\n')
    expect((await run(['pool', 'guard', 'amd64', item('sbom.json.zst', 'mica-report', '1.0.0', 'sbom one')])).err).toContain('inputs of mica-report changed without a version bump')
    expect((await run(['pool', 'guard', 'amd64', item('sbom.json.zst', 'mica-report', '1.0.1', 'sbom two')])).out).toContain(' new ')
    expect((await run(['pool', 'guard', 'amd64', item('sbom.json.zst', 'mica-report', '0.9.0', 'sbom')])).err).toContain('a version never goes back')
  })

  test('the gate and the file name: <name>_<version>_<arch>.<type>, of this pool, without a stamp', async () => {
    const problems = async () => (await run(['pool', 'gate', '--arch', 'amd64'])).err
    item('sbom', 'mica-report', '1.0.2', 'x')
    expect(await run(['pool', 'gate', '--arch', 'amd64'])).toMatchObject({ code: 0, out: 'pass: 1 archive(s) in amd64' })
    item('sbom', 'mica-report', '1.0.2+git0123456789ab', 'x')
    expect(await problems()).toContain('version 1.0.2+git0123456789ab carries a commit or dirty stamp')
    item('sbom', 'Mica_Report', '1.0.2', 'x')
    expect(await problems()).toContain('is not named <name>_<version>_amd64.<type>')
    rmSync(pool(), { recursive: true, force: true })
    mkdirSync(pool(), { recursive: true })
    writeFileSync(join(pool(), 'mica-report_1.0.2_arm64.sbom'), 'x')
    expect(await problems()).toContain('is not named <name>_<version>_amd64.<type>')
    writeFileSync(join(pool(), 'README'), 'x')
    expect(await problems()).toContain('amd64/pool/README is not named <name>_<version>_amd64.<type>')
    expect((await run(['pool', 'guard', 'amd64', join(pool(), 'README')])).err).toContain('is not named <name>_<version>_amd64.<type>')
  })

  test('a core component is two items like any other: no type is the tools\' own but deb', async () => {
    commit('three\n')
    // The types mica-core publishes, and two other types.
    for (const type of ['core.img', 'core.json', 'img', 'json']) {
      const file = item(type, 'mica-report', '2.0.0', `a ${type}`)
      expect((await run(['pool', 'guard', 'amd64', file])).out).toBe(`amd64 mica-report 2.0.0 new ${sha256(`a ${type}`)}`)
      expect(await run(['pool', 'gate', '--arch', 'amd64'])).toMatchObject({ code: 0, out: 'pass: 1 archive(s) in amd64' })
    }
    const lock = (rows: string) => lockOf('20260928-1000', `pool\tamd64\tghcr.io/micaoss/mica-core:pool.amd64.20260928-1000@sha256:${'a'.repeat(64)}\n${rows}`)
    const row = (type: string) => `item\t${type}\tmica-report\tamd64\t2.0.0\t${'b'.repeat(64)}`
    expect(await run(['lock', 'check', await lock(['core.img', 'core.json', 'img', 'json'].map(row).join('\n'))])).toMatchObject({ code: 0, out: 'valid' })
    expect(await run(['lock', 'check', await lock(row('deb'))])).toMatchObject({ code: 1, out: 'refused field-value' })
    expect(await run(['lock', 'check', await lock(`core\tmica-report\tamd64\t2.0.0\t${'b'.repeat(64)}`)])).toMatchObject({ code: 1, out: 'refused kind-unknown' })
  })
})
