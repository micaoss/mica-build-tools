// The commands of design 3.1 and 3.2 over fixtures made of the canonical vectors, with a stub standing in for
// GitHub's release downloads.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { main } from '../src/cli.ts'
import { ROOT, vectorsDir } from './vectors.ts'

const V = vectorsDir()
let scratch = ''
let server: ReturnType<typeof Bun.serve> | undefined
const assets = new Map<string, Uint8Array>()

const sha256 = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex')

async function run(argv: string[], env: Record<string, string | undefined> = {}): Promise<{ code: number, out: string, err: string }> {
  const saved = { ...process.env }
  for (const [k, v] of Object.entries({ CI: undefined, GITHUB_ACTIONS: undefined, MICA_OFFLINE: undefined, ...env })) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  const out: string[] = [], err: string[] = []
  try {
    const code = await main(argv, { out: l => out.push(l), err: l => err.push(l), write: async b => out.push(new TextDecoder().decode(b)) })
    return { code, out: out.join('\n'), err: err.join('\n') }
  }
  finally {
    for (const k of Object.keys(process.env)) delete process.env[k]
    Object.assign(process.env, saved)
  }
}

/** A repository root whose locks/ is a copy of a pins vector. */
function repo(name: string, vector = 'pins/valid/release'): string {
  const root = join(scratch, name)
  cpSync(join(V, vector), join(root, 'locks'), { recursive: true })
  return root
}

beforeAll(() => {
  mkdirSync(join(ROOT, '.tmp'), { recursive: true })
  scratch = mkdtempSync(join(ROOT, '.tmp/commands-'))
  server = Bun.serve({
    port: 0,
    fetch(request) {
      const body = assets.get(new URL(request.url).pathname)
      return body === undefined ? new Response('not found', { status: 404 }) : new Response(body)
    },
  })
})

afterAll(() => {
  server?.stop(true)
  rmSync(scratch, { recursive: true, force: true })
})

function publish(repository: string, tag: string, lock: Uint8Array): string {
  const sums = `${sha256(lock)}  ${repository}.lock\n`
  assets.set(`/${repository}/${tag}/${repository}.lock`, lock)
  assets.set(`/${repository}/${tag}/SHA256SUMS`, new TextEncoder().encode(sums))
  return sha256(sums)
}

const releases = () => `http://localhost:${server!.port}/{repository}/{release}/`

describe('lock', () => {
  test('check prints valid, and the first rule a lock breaks', async () => {
    expect(await run(['lock', 'check', join(V, 'lock/valid/mica-system-base.lock')])).toMatchObject({ code: 0, out: 'valid' })
    expect(await run(['lock', 'check', join(V, 'lock/refused/apt-suite.lock')])).toMatchObject({ code: 1, out: 'refused apt-suite' })
  })
  test('check --collect prints every rule, sorted', async () => {
    expect(await run(['lock', 'check', '--collect', join(V, 'lock/refused/release-slash.lock')])).toMatchObject({ code: 1, out: 'refused field-value release-scope' })
    expect(await run(['lock', 'check', '--collect', join(V, 'lock/refused/image-registry.lock')])).toMatchObject({ code: 1, out: 'stopped reference-registry' })
    expect(await run(['lock', 'check', '--collect', join(V, 'lock/valid/mica-core.lock')])).toMatchObject({ code: 0, out: 'valid' })
  })
  test('rows prints the rows of one kind', async () => {
    const r = await run(['lock', 'rows', join(V, 'lock/valid/mica-system-base.lock'), 'apt'])
    expect(r.code).toBe(0)
    expect(r.out.split('\n').map(l => l.split('\t')[2])).toEqual(['trixie-security', 'trixie', 'trixie-updates'])
  })
  test('a usage error exits 2', async () => {
    expect((await run(['lock', 'check'])).code).toBe(2)
    expect((await run(['nothing'])).code).toBe(2)
  })
})

describe('upstream', () => {
  test('check and get', async () => {
    const root = repo('upstream')
    cpSync(join(V, 'upstream/valid/upstream.lock'), join(root, 'locks/upstream.lock'))
    expect(await run(['upstream', 'check'], { MICA_REPO_ROOT: root })).toMatchObject({ code: 0, out: 'valid' })
    expect(await run(['upstream', 'check', join(V, 'upstream/refused/unsorted.lock')])).toMatchObject({ code: 1, out: 'refused sort-order' })
    const rows = readFileSync(join(root, 'locks/upstream.lock'), 'utf8').split('\n').map(l => l.split('\t'))
    const git = rows.find(r => r[0] === 'git')!, source = rows.find(r => r[0] === 'source')!
    expect(await run(['upstream', 'get', 'git', git[1]!, 'commit'], { MICA_REPO_ROOT: root })).toMatchObject({ code: 0, out: git[4] })
    expect(await run(['upstream', 'get', 'source', source[1]!, source[2]!, 'sha256'], { MICA_REPO_ROOT: root })).toMatchObject({ code: 0, out: source[4] })
    const sources = await run(['upstream', 'rows', 'source'], { MICA_REPO_ROOT: root })
    expect(sources).toMatchObject({ code: 0, out: rows.filter(r => r[0] === 'source').map(r => r.join('\t')).join('\n') })
    expect(await run(['upstream', 'rows', 'git', join(root, 'locks/upstream.lock')])).toMatchObject({ code: 0, out: rows.filter(r => r[0] === 'git').map(r => r.join('\t')).join('\n') })
    expect(await run(['upstream', 'rows', 'source', join(V, 'upstream/refused/unsorted.lock')])).toMatchObject({ code: 1, out: 'refused sort-order' })
    expect((await run(['upstream', 'rows', 'release'], { MICA_REPO_ROOT: root })).code).toBe(2)
    const missing = await run(['upstream', 'get', 'git', 'nothing', 'url'], { MICA_REPO_ROOT: root })
    expect(missing.code).toBe(1)
    expect(missing.err).toContain('pins no git tree nothing')
  })
})

describe('locks', () => {
  test('a repository without locks/ is an error, not a stack trace', async () => {
    const root = join(scratch, 'no-locks')
    mkdirSync(root, { recursive: true })
    const r = await run(['locks', 'check'], { MICA_REPO_ROOT: root })
    expect([r.code, r.err]).toEqual([1, `error: ${join(root, 'locks')} does not exist`])
    const raw = await run(['lock', 'check', join(root, 'nothing.lock')])
    expect(raw.code).toBe(1)
    expect(raw.err).toStartWith('error: ')
  })

  test('check reads locks/mica-build-tools.pin, which pairs with no lock', async () => {
    const root = repo('tools-pin')
    writeFileSync(join(root, 'locks/mica-build-tools.pin'), `# mica-tools-pin v1\nREPOSITORY=mica-build-tools\nCOMMIT=${'a'.repeat(40)}\n`)
    expect(await run(['locks', 'check'], { MICA_REPO_ROOT: root })).toMatchObject({ code: 0 })
    writeFileSync(join(root, 'locks/mica-build-tools.pin'), `# mica-tools-pin v1\nCOMMIT=${'a'.repeat(40)}\nREPOSITORY=mica-build-tools\n`)
    expect(await run(['locks', 'check'], { MICA_REPO_ROOT: root })).toMatchObject({ code: 1, out: 'refused pin-format' })
    writeFileSync(join(root, 'locks/mica-build-tools.pin'), `# mica-pin v1\nREPOSITORY=mica-build-tools\n`)
    expect(await run(['locks', 'check'], { MICA_REPO_ROOT: root })).toMatchObject({ code: 1, out: 'refused header' })
  })

  test('check, and --ci refuses an offline pin', async () => {
    const root = repo('offline', 'pins/valid/offline-checkout')
    expect(await run(['locks', 'check'], { MICA_REPO_ROOT: root })).toMatchObject({ code: 0 })
    expect(await run(['locks', 'check', '--ci'], { MICA_REPO_ROOT: root })).toMatchObject({ code: 1, out: 'refused checkout-in-ci' })
    expect(await run(['locks', 'check'], { MICA_REPO_ROOT: root, GITHUB_ACTIONS: 'true' })).toMatchObject({ code: 1, out: 'refused checkout-in-ci' })
  })

  test('verify: the pinned SHA256SUMS lists the committed lock', async () => {
    const root = repo('verify')
    for (const name of ['mica-build-env', 'mica-core']) {
      const lock = readFileSync(join(root, 'locks', `${name}.lock`))
      const release = readFileSync(join(root, 'locks/pins', `${name}.pin`), 'utf8').match(/^RELEASE=(.*)$/m)![1]!
      const trust = publish(name, release, lock)
      writeFileSync(join(root, 'locks/pins', `${name}.pin`), readFileSync(join(root, 'locks/pins', `${name}.pin`), 'utf8').replace(/^SHA256SUMS=.*$/m, `SHA256SUMS=${trust}`))
    }
    const ok = await run(['locks', 'verify'], { MICA_REPO_ROOT: root, MICA_RELEASES_URL: releases() })
    expect(ok.code).toBe(0)
    expect(ok.out.split('\n')).toHaveLength(2)
    writeFileSync(join(root, 'locks/pins/mica-core.pin'), readFileSync(join(root, 'locks/pins/mica-core.pin'), 'utf8').replace(/^SHA256SUMS=.*$/m, `SHA256SUMS=${'0'.repeat(64)}`))
    const bad = await run(['locks', 'verify'], { MICA_REPO_ROOT: root, MICA_RELEASES_URL: releases() })
    expect(bad.code).toBe(1)
    expect(bad.err).toContain('the pin records')
  })

  test('move: writes exactly the lock and its pin', async () => {
    const root = repo('move')
    const lock = readFileSync(join(V, 'lock/valid/mica-core.lock'))
    const release = lock.toString().split('\n').find(l => l.startsWith('release\t'))!.split('\t')[2]!
    const trust = publish('mica-core', release, lock)
    const before = readFileSync(join(root, 'locks/mica-build-env.lock'))
    const r = await run(['locks', 'move', 'mica-core', release], { MICA_REPO_ROOT: root, MICA_RELEASES_URL: releases() })
    expect(r.code).toBe(0)
    expect(readFileSync(join(root, 'locks/mica-core.lock'))).toEqual(lock)
    expect(readFileSync(join(root, 'locks/pins/mica-core.pin'), 'utf8')).toBe(`# mica-pin v1\nREPOSITORY=mica-core\nRELEASE=${release}\nSHA256SUMS=${trust}\n`)
    expect(readFileSync(join(root, 'locks/mica-build-env.lock'))).toEqual(before)
    expect(await run(['locks', 'check'], { MICA_REPO_ROOT: root })).toMatchObject({ code: 0 })
    // A release whose lock names another release is refused, and nothing is written.
    publish('mica-core', '20990101-0000', lock)
    expect(await run(['locks', 'move', 'mica-core', '20990101-0000'], { MICA_REPO_ROOT: root, MICA_RELEASES_URL: releases() })).toMatchObject({ code: 1, out: 'refused release-mismatch' })
    expect(readFileSync(join(root, 'locks/pins/mica-core.pin'), 'utf8')).toContain(`RELEASE=${release}\n`)
  })
})

describe('local-lock', () => {
  function checkout(): string {
    const dir = join(scratch, 'producer')
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(join(dir, '_out/offline/oci/blobs/sha256'), { recursive: true })
    const git = (args: string[]) => Bun.spawnSync(['git', '-c', 'user.name=t', '-c', 'user.email=t@t', '-C', dir, ...args], { stdout: 'pipe' }).stdout.toString().trim()
    git(['init', '--quiet'])
    git(['commit', '--quiet', '--allow-empty', '-m', 'producer'])
    const commit = git(['rev-parse', 'HEAD'])
    const deb = new TextEncoder().encode('an archive')
    const manifest = new TextEncoder().encode('{}')
    for (const blob of [deb, manifest]) writeFileSync(join(dir, '_out/offline/oci/blobs/sha256', sha256(blob)), blob)
    const lock = `# mica-lock v1\nrelease\tmica-core\toffline\t${commit}\npool\tamd64\tlocal/mica-core:pool.amd64.offline@sha256:${sha256(manifest)}\n`
      + `package\tmicad\tamd64\t0.1.0-1\t${sha256(deb)}\n`
    writeFileSync(join(dir, '_out/offline/mica-core.lock'), lock)
    writeFileSync(join(dir, '_out/offline/SHA256SUMS'), `${sha256(lock)}  mica-core.lock\n`)
    return dir
  }

  test('writes the lock unchanged and the offline pin', async () => {
    const root = repo('local'), dir = checkout()
    const r = await run(['local-lock', 'mica-core', dir], { MICA_REPO_ROOT: root })
    expect(r.code).toBe(0)
    expect(readFileSync(join(root, 'locks/mica-core.lock'))).toEqual(readFileSync(join(dir, '_out/offline/mica-core.lock')))
    const sums = sha256(readFileSync(join(dir, '_out/offline/SHA256SUMS')))
    expect(readFileSync(join(root, 'locks/pins/mica-core.pin'), 'utf8')).toBe(`# mica-pin v1\nREPOSITORY=mica-core\nRELEASE=offline\nSHA256SUMS=${sums}\nCHECKOUT=${dir}\n`)
  })

  test('is refused under CI, and over a blob that does not hash to its name', async () => {
    const root = repo('local-ci'), dir = checkout()
    expect(await run(['local-lock', 'mica-core', dir], { MICA_REPO_ROOT: root, CI: 'true' })).toMatchObject({ code: 1, out: 'refused checkout-in-ci' })
    const blob = readFileSync(join(dir, '_out/offline/mica-core.lock'), 'utf8').match(/sha256:([0-9a-f]{64})/)![1]!
    writeFileSync(join(dir, '_out/offline/oci/blobs/sha256', blob), 'other bytes')
    expect(await run(['local-lock', 'mica-core', dir], { MICA_REPO_ROOT: root })).toMatchObject({ code: 1, out: 'refused cache-corrupt' })
  })
})

describe('from', () => {
  test('--ref resolves a build-env image, a platform and an upstream image', async () => {
    const root = repo('from')
    const lock = readFileSync(join(root, 'locks/mica-build-env.lock'), 'utf8').split('\n').map(l => l.split('\t'))
    const base = lock.find(r => r[0] === 'image' && r[1] === 'mica-build-env' && r[2] === 'base' && r[3] === 'index')!
    const upstream = lock.find(r => r[0] === 'image' && r[1] === 'upstream')!
    expect(await run(['from', '--ref', 'mica-build-env:base'], { MICA_REPO_ROOT: root })).toMatchObject({ code: 0, out: base[4] })
    expect(await run(['from', '--ref', `upstream:${upstream[2]}`], { MICA_REPO_ROOT: root })).toMatchObject({ code: 0, out: upstream[4] })
    expect(await run(['from', `BASE=mica-build-env:base`], { MICA_REPO_ROOT: root })).toMatchObject({ code: 0, out: `--build-arg\nBASE=${base[4]}` })
    const missing = await run(['from', '--ref', 'upstream:nothing:1'], { MICA_REPO_ROOT: root })
    expect(missing.code).toBe(1)
    expect(missing.err).toContain('0 image row(s)')
  })

  test('--check refuses a Dockerfile that names an image', async () => {
    const good = join(scratch, 'Dockerfile.good'), bad = join(scratch, 'Dockerfile.bad')
    writeFileSync(good, `# syntax=docker/dockerfile:1@sha256:${'a'.repeat(64)}\nARG BASE\nFROM \${BASE} AS build\nFROM build AS final\nFROM scratch\n`)
    writeFileSync(bad, 'ARG BASE=debian:trixie\nFROM ${BASE}\nFROM debian:trixie\n')
    expect(await run(['from', '--check', good])).toMatchObject({ code: 0 })
    const r = await run(['from', '--check', bad])
    expect(r.code).toBe(1)
    expect(r.err.split('\n')).toHaveLength(2)
  })
})

describe('repos', () => {
  test('a download streams to its file and is hashed on the way', async () => {
    const { streamToFile } = await import('../src/repos/cache.ts')
    const body = new Uint8Array(3 * 1024 * 1024).map((_, i) => i % 251)
    const out = join(scratch, 'stream/out')
    const got = await streamToFile(new Response(body), out)
    expect(got).toBe(sha256(body))
    expect(readFileSync(out)).toEqual(Buffer.from(body))
  })

  test('a mirror maps a URL by its form, or leaves it alone', async () => {
    const { mirrorUrl } = await import('../src/repos/cache.ts')
    const pool = 'https://snapshot.debian.org/archive/debian/20260901T000000Z/pool/main/a/adduser/adduser_3.137_all.deb'
    expect(mirrorUrl('pool:https://dl.example/upstream/debian', pool)).toBe('https://dl.example/upstream/debian/pool/main/a/adduser/adduser_3.137_all.deb')
    expect(mirrorUrl('https://dl.example/upstream/debian/', pool)).toBe('https://dl.example/upstream/debian/pool/main/a/adduser/adduser_3.137_all.deb')
    expect(mirrorUrl('snapshot:https://dl.example/snapshot', pool)).toBe('https://dl.example/snapshot/archive/debian/20260901T000000Z/pool/main/a/adduser/adduser_3.137_all.deb')
    expect(mirrorUrl('pool:https://dl.example/x', 'https://github.com/oven-sh/bun/releases/download/bun-v1.4.2/bun-linux-x64.zip')).toBeUndefined()
    expect(mirrorUrl('snapshot:https://dl.example/x', 'https://deb.debian.org/debian/pool/main/a/a.deb')).toBeUndefined()
    expect(() => mirrorUrl('http://dl.example/x', pool)).toThrow('MICA_MIRROR')
    expect(() => mirrorUrl('ftp:https://dl.example/x', pool)).toThrow('MICA_MIRROR')
  })

  test('a download takes the mirror first, and any mirror failure falls back to the row\'s URL', async () => {
    const { downloadFrom } = await import('../src/repos/cache.ts')
    const body = new TextEncoder().encode('the pinned archive')
    const mirror = Bun.serve({
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname
        if (path === '/serves') return new Response(body)
        if (path === '/wrong') return new Response('other bytes')
        if (path === '/stalls') return new Promise<Response>(() => {})
        return new Response('', { status: 404 })
      },
    })
    const origin = Bun.serve({ port: 0, fetch: () => new Response(body) })
    try {
      const m = (p: string) => `http://localhost:${mirror.port}${p}`, o = `http://localhost:${origin.port}/pool/a.deb`
      const dir = mkdtempSync(join(scratch, 'mirror-'))
      const target = (n: string) => join(dir, n)
      expect(await downloadFrom([m('/serves'), o], sha256(body), target('a'), 5000)).toBe(m('/serves'))
      expect(readFileSync(target('a'))).toEqual(Buffer.from(body))
      expect(await downloadFrom([m('/missing'), o], sha256(body), target('b'), 5000)).toBe(o)
      expect(await downloadFrom([m('/wrong'), o], sha256(body), target('c'), 5000)).toBe(o)
      expect(await downloadFrom([m('/stalls'), o], sha256(body), target('d'), 1000)).toBe(o)
      // The row's own URL is the last word: its failure is the error, and a wrong hash there is refused.
      await expect(downloadFrom([m('/missing'), m('/missing')], sha256(body), target('e'), 5000)).rejects.toThrow('HTTP 404')
      await expect(downloadFrom([m('/wrong')], sha256(body), target('f'), 5000)).rejects.toThrow('downloads with sha256')
      await expect(downloadFrom([m('/stalls')], sha256(body), target('g'), 1000)).rejects.toThrow('1 s')
      expect(existsSync(target('g'))).toBe(false)
    }
    finally {
      mirror.stop(true)
      origin.stop(true)
    }
  })

  test('get: stored, verified, copied; offline miss; corrupt cache', async () => {
    const root = join(scratch, 'repos-get')
    mkdirSync(root, { recursive: true })
    const body = new TextEncoder().encode('an upstream archive')
    assets.set('/archive.tar', body)
    const url = `http://localhost:${server!.port}/archive.tar`
    const out = join(root, 'out/archive.tar')
    expect(await run(['repos', 'get', sha256(body), url, out], { MICA_REPO_ROOT: root, MICA_OFFLINE: '1' })).toMatchObject({ code: 1, out: 'refused offline-miss' })
    // Downloads are https only; the cached copy is what a later offline run reads.
    expect((await run(['repos', 'get', sha256(body), url, out], { MICA_REPO_ROOT: root })).err).toContain('is not https')
    expect((await run(['repos', 'get', sha256(body), 'https://example.org/a', out], { MICA_REPO_ROOT: root, MICA_MIRROR: 'http://m' })).err).toContain('MICA_MIRROR')
    expect((await run(['repos', 'get', sha256(body), 'https://example.org/a', out], { MICA_REPO_ROOT: root, MICA_FETCH_DEADLINE: 'soon' })).err).toContain('MICA_FETCH_DEADLINE')
    mkdirSync(join(root, 'repos/sha256'), { recursive: true })
    writeFileSync(join(root, 'repos/sha256', sha256(body)), body)
    expect(await run(['repos', 'get', sha256(body), url, out], { MICA_REPO_ROOT: root, MICA_OFFLINE: '1' })).toMatchObject({ code: 0, out: `cached ${sha256(body)}` })
    expect(readFileSync(out)).toEqual(Buffer.from(body))
    writeFileSync(join(root, 'repos/sha256', sha256(body)), 'other bytes')
    expect(await run(['repos', 'get', sha256(body), url, out], { MICA_REPO_ROOT: root })).toMatchObject({ code: 1, out: 'refused cache-corrupt' })
  })

  test('git: a commit and a tree out of the mirror, offline once cached', async () => {
    const root = join(scratch, 'repos-git'), upstream = join(scratch, 'upstream-tree')
    mkdirSync(upstream, { recursive: true })
    const git = (args: string[], cwd = upstream) => Bun.spawnSync(['git', '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, stdout: 'pipe' }).stdout.toString().trim()
    git(['init', '--quiet'])
    writeFileSync(join(upstream, 'file'), 'content\n')
    git(['add', 'file'])
    git(['commit', '--quiet', '-m', 'one'])
    const commit = git(['rev-parse', 'HEAD']), tree = git(['rev-parse', 'HEAD^{tree}'])
    const dir = join(root, 'src')
    expect(await run(['repos', 'git', upstream, commit, dir], { MICA_REPO_ROOT: root, MICA_OFFLINE: '1' })).toMatchObject({ code: 1, out: 'refused offline-miss' })
    expect(await run(['repos', 'git', upstream, commit, dir], { MICA_REPO_ROOT: root })).toMatchObject({ code: 0 })
    expect(git(['rev-parse', 'HEAD'], dir)).toBe(commit)
    expect(existsSync(join(root, 'repos/git/upstream-tree.git'))).toBe(true)
    rmSync(dir, { recursive: true })
    // The pinned objects survive a gc of the mirror: it holds a ref to each.
    git(['--git-dir', join(root, 'repos/git/upstream-tree.git'), 'gc', '--quiet', '--prune=now'], root)
    expect(await run(['repos', 'git', upstream, commit, dir], { MICA_REPO_ROOT: root, MICA_OFFLINE: '1' })).toMatchObject({ code: 0, err: '' })
    expect(git(['rev-parse', 'HEAD'], dir)).toBe(commit)
    const treeDir = join(root, 'tree')
    expect(await run(['repos', 'git', upstream, tree, treeDir], { MICA_REPO_ROOT: root, MICA_OFFLINE: '1' })).toMatchObject({ code: 0 })
    expect(readFileSync(join(treeDir, 'file'), 'utf8')).toBe('content\n')
    // Verifying a directory writes nothing into the mirror: a foreign file leaves no object behind.
    writeFileSync(join(treeDir, 'foreign'), 'not in the tree\n')
    const objects = () => git(['--git-dir', join(root, 'repos/git/upstream-tree.git'), 'count-objects'], root)
    const before = objects()
    expect(await run(['repos', 'git', upstream, tree, treeDir], { MICA_REPO_ROOT: root, MICA_OFFLINE: '1' })).toMatchObject({ code: 0 })
    expect(objects()).toBe(before)
    expect(existsSync(join(treeDir, 'foreign'))).toBe(false)
  })

  test('check: every source and git row of upstream.lock is cached', async () => {
    const root = join(scratch, 'repos-check')
    mkdirSync(join(root, 'locks'), { recursive: true })
    const body = new TextEncoder().encode('toolchain')
    writeFileSync(join(root, 'locks/upstream.lock'), `# mica-lock v1\nsource\ttool\tall\t1.0\t${sha256(body)}\thttps://example.org/tool.tar\n`)
    expect(await run(['repos', 'check'], { MICA_REPO_ROOT: root, MICA_OFFLINE: '1' })).toMatchObject({ code: 1, out: 'refused offline-miss' })
    mkdirSync(join(root, 'repos/sha256'), { recursive: true })
    writeFileSync(join(root, 'repos/sha256', sha256(body)), body)
    expect(await run(['repos', 'check'], { MICA_REPO_ROOT: root })).toMatchObject({ code: 0, out: `source tool all ${sha256(body)}` })
  })
})

describe('pin check', () => {
  test('a tools pin and a vectors pin', async () => {
    expect(await run(['pin', 'check', join(ROOT, 'docs/spec/release-lock/vectors/tools-pin/valid/mica-build-tools.pin')])).toMatchObject({ code: 0, out: 'valid' })
    const file = join(scratch, 'mica-build-tools.pin')
    writeFileSync(file, `# mica-tools-pin v1\nREPOSITORY=mica-build-tools\nCOMMIT=${'a'.repeat(40)}\n`)
    expect(await run(['pin', 'check', file])).toMatchObject({ code: 0, out: 'valid' })
    writeFileSync(file, `# mica-tools-pin v1\nREPOSITORY=mica-build-tools\nCOMMIT=${'a'.repeat(40)}\nEXTRA=1\n`)
    expect(await run(['pin', 'check', file])).toMatchObject({ code: 1, out: 'refused pin-format' })
  })
})

describe('version', () => {
  test('<VERSION>+git<commit12>[.dirty]-1', async () => {
    const root = join(scratch, 'versioned')
    mkdirSync(root, { recursive: true })
    const git = (args: string[]) => Bun.spawnSync(['git', '-c', 'user.name=t', '-c', 'user.email=t@t', '-C', root, ...args], { stdout: 'pipe' }).stdout.toString().trim()
    git(['init', '--quiet'])
    writeFileSync(join(root, 'VERSION'), '1.2.0\n')
    git(['add', 'VERSION'])
    git(['commit', '--quiet', '-m', 'v'])
    const commit = git(['rev-parse', '--short=12', 'HEAD'])
    expect(await run(['version'], { MICA_REPO_ROOT: root })).toMatchObject({ code: 0, out: `1.2.0+git${commit}-1` })
    writeFileSync(join(root, 'VERSION'), '1.3.0\n')
    expect(await run(['version'], { MICA_REPO_ROOT: root })).toMatchObject({ code: 0, out: `1.3.0+git${commit}.dirty-1` })
    writeFileSync(join(root, 'VERSION'), 'v1\n')
    expect((await run(['version'], { MICA_REPO_ROOT: root })).err).toContain('is not a Debian upstream version')
  })
})

describe('deb', () => {
  const deb = join(ROOT, 'tests/fixtures/deb/mica-test_xz.deb')
  test('control and member', async () => {
    expect(await run(['deb', 'control', deb, 'Package', 'Nothing', 'Version'])).toMatchObject({ code: 0, out: 'mica-test\n\n1.0.0-1' })
    const out = join(scratch, 'member/file')
    expect(await run(['deb', 'member', deb, 'usr/share/mica-test/file', out])).toMatchObject({ code: 0 })
    expect(readFileSync(out, 'utf8')).toBe('payload\n')
    expect((await run(['deb', 'member', deb, 'usr/none', out])).code).toBe(1)
  })
})

describe('shell-lint', () => {
  test('finds a reader that exits early, and passes a clean tree', async () => {
    const root = join(scratch, 'lint')
    mkdirSync(root, { recursive: true })
    const git = (args: string[]) => Bun.spawnSync(['git', '-C', root, ...args], { stdout: 'pipe' })
    git(['init', '--quiet'])
    writeFileSync(join(root, 'good.sh'), '#!/usr/bin/env bash\nset -euo pipefail\n# a comment: x | head\nls | grep -c x >/dev/null\n')
    writeFileSync(join(root, 'other.sh'), '#!/bin/sh\nls | head -1\n')
    git(['add', '.'])
    expect(await run(['shell-lint'], { MICA_REPO_ROOT: root })).toMatchObject({ code: 0, out: expect.stringContaining('clean: 1 file(s)') })
    writeFileSync(join(root, 'bad.sh'), '#!/usr/bin/env bash\nset -o pipefail\nls | grep -q x\nls | head -n 1\nfind . | sed 3q\nls | awk \'{ exit }\'\nls | read -r x\n')
    git(['add', 'bad.sh'])
    const r = await run(['shell-lint', '*.sh'], { MICA_REPO_ROOT: root })
    expect(r.code).toBe(1)
    expect(r.err.split('\n').map(l => l.split(': ')[1])).toEqual(['bad.sh:3', 'bad.sh:4', 'bad.sh:5', 'bad.sh:6', 'bad.sh:7'])
  })
})

describe('oci', () => {
  test('manifest and blob, anonymously through the token challenge, hashed to the digest', async () => {
    const layer = new TextEncoder().encode('a layer')
    const manifest = new TextEncoder().encode(JSON.stringify({ schemaVersion: 2, layers: [{ digest: `sha256:${sha256(layer)}` }] }))
    let port = 0
    const registry = Bun.serve({
      port: 0,
      fetch(request): Response {
        const url = new URL(request.url)
        if (url.pathname === '/token') return Response.json({ token: url.searchParams.get('scope') === 'repository:micaoss/mica-core:pull' ? 'anon' : '' })
        if (request.headers.get('authorization') !== 'Bearer anon')
          return new Response('', { status: 401, headers: { 'www-authenticate': `Bearer realm="http://localhost:${port}/token",service="ghcr.io"` } })
        if (url.pathname === `/v2/micaoss/mica-core/manifests/sha256:${sha256(manifest)}`) return new Response(manifest)
        if (url.pathname === `/v2/micaoss/mica-core/blobs/sha256:${sha256(layer)}`) return new Response(layer)
        if (url.pathname === `/v2/micaoss/mica-core/blobs/sha256:${'0'.repeat(64)}`) return new Response('other bytes')
        return new Response('', { status: 404 })
      },
    })
    port = registry.port!
    try {
      const env = { MICA_OCI_REGISTRY: `http://localhost:${port}` }
      const ref = `ghcr.io/micaoss/mica-core:pool.amd64.20260926-0000@sha256:${sha256(manifest)}`
      expect(await run(['oci', 'manifest', ref], env)).toMatchObject({ code: 0 })
      const out = join(scratch, 'oci/layer')
      expect(await run(['oci', 'blob', 'ghcr.io/micaoss/mica-core', sha256(layer), out], env)).toMatchObject({ code: 0 })
      expect(readFileSync(out, 'utf8')).toBe('a layer')
      expect((await run(['oci', 'blob', 'ghcr.io/micaoss/mica-core', '0'.repeat(64), out], env)).err).toContain('other bytes')
      expect((await run(['oci', 'blob', 'ghcr.io/micaoss/mica-podman', sha256(layer), out], env)).err).toContain('issued no pull token')
    }
    finally {
      registry.stop(true)
    }
  })

  test('local/ reads the offline checkout, and is refused under CI', async () => {
    const root = repo('oci-local', 'pins/valid/offline-checkout')
    const checkout = readFileSync(join(root, 'locks/pins/mica-core.pin'), 'utf8').match(/^CHECKOUT=(.*)$/m)![1]!
    const pin = readFileSync(join(root, 'locks/pins/mica-core.pin'), 'utf8').replace(checkout, join(scratch, 'offline-core'))
    writeFileSync(join(root, 'locks/pins/mica-core.pin'), pin)
    const body = new TextEncoder().encode('{}')
    mkdirSync(join(scratch, 'offline-core/_out/offline/oci/blobs/sha256'), { recursive: true })
    writeFileSync(join(scratch, 'offline-core/_out/offline/oci/blobs/sha256', sha256(body)), body)
    const ref = `local/mica-core:pool.amd64.offline@sha256:${sha256(body)}`
    expect(await run(['oci', 'manifest', ref], { MICA_REPO_ROOT: root })).toMatchObject({ code: 0 })
    expect(await run(['oci', 'manifest', ref], { MICA_REPO_ROOT: root, CI: 'true' })).toMatchObject({ code: 1, out: 'refused checkout-in-ci' })
  })
})

describe('release latest', () => {
  test('by the time its tag carries, before a tag, with an asset, unscoped only', async () => {
    const releases = [
      { tag_name: '20260920-0100', draft: false, prerelease: false, assets: [{ name: 'mica-core.lock' }] },
      { tag_name: '20260926-0900', draft: false, prerelease: false, assets: [] },
      { tag_name: '20260927-0000', draft: true, prerelease: false, assets: [{ name: 'mica-core.lock' }] },
      { tag_name: 'uefi-x64/20260925-0000', draft: false, prerelease: false, assets: [{ name: 'mica-core.lock' }] },
      { tag_name: 'v1', draft: false, prerelease: false, assets: [] },
    ]
    const api = Bun.serve({ port: 0, fetch: request => new URL(request.url).pathname === '/repos/micaoss/mica-core/releases' ? Response.json(releases) : new Response('', { status: 404 }) })
    try {
      const env = { MICA_GITHUB_API: `http://localhost:${api.port}`, MICA_SOURCE_REPO: 'mica-core' }
      expect(await run(['release', 'latest'], env)).toMatchObject({ code: 0, out: '20260926-0900' })
      expect(await run(['release', 'latest', '--asset', 'mica-core.lock'], env)).toMatchObject({ code: 0, out: 'uefi-x64/20260925-0000' })
      expect(await run(['release', 'latest', '--before', 'uefi-x64.20260925-0000'], env)).toMatchObject({ code: 0, out: '20260920-0100' })
      expect((await run(['release', 'latest', '--before', '20260920-0100'], env)).code).toBe(1)
      const { latestRelease } = await import('../src/release/latest.ts')
      process.env.MICA_GITHUB_API = env.MICA_GITHUB_API
      expect(await latestRelease('mica-core', { asset: 'mica-core.lock', scope: '' })).toBe('20260920-0100')
      delete process.env.MICA_GITHUB_API
    }
    finally {
      api.stop(true)
    }
  })
})
