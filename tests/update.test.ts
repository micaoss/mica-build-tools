// `release latest --repository`, `locks move` without a release, and `locks update`: every pinned input to its
// latest release unless one is named, against the stand-in for GitHub and a local repository for this tool.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { main } from '../src/cli.ts'
import { Stub } from './stubs.ts'
import { ROOT, vectorsDir } from './vectors.ts'

const V = vectorsDir()
const sha256 = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex')
let scratch = '', root = '', tools = '', stub: Stub
const commits: string[] = []

async function run(argv: string[], env: Record<string, string> = {}): Promise<{ code: number, out: string, err: string }> {
  const saved = { ...process.env }
  for (const k of ['CI', 'GITHUB_ACTIONS', 'MICA_OFFLINE']) delete process.env[k]
  Object.assign(process.env, { ...stub.env('mica-podman'), MICA_REPO_ROOT: root, MICA_TOOLS_URL: tools, ...env })
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

const git = (dir: string, args: string[]) =>
  Bun.spawnSync(['git', '-c', 'user.name=t', '-c', 'user.email=t@t', '-C', dir, ...args], { stdout: 'pipe' }).stdout.toString().trim()

/** A producer's lock at a release, from its vector. */
function lockAt(repository: string, release: string): Uint8Array {
  const text = readFileSync(join(V, `pins/valid/release/${repository}.lock`), 'utf8')
  return new TextEncoder().encode(text.replace(`release\t${repository}\t20260914-2042\t`, `release\t${repository}\t${release}\t`))
}

/** Publishes a release of a producer on the stub; with no lock, a release that carries none. */
function publish(repository: string, release: string, lock?: Uint8Array): string {
  const r = stub.release(repository, release)
  if (lock === undefined) return ''
  const sums = new TextEncoder().encode(`${sha256(lock)}  ${repository}.lock\n`)
  const url = (name: string) => `${stub.url}/download/${repository}/${release}/${name}`
  r.assets.push({ id: 0, name: `${repository}.lock`, url: url(`${repository}.lock`), bytes: lock }, { id: 0, name: 'SHA256SUMS', url: url('SHA256SUMS'), bytes: sums })
  return sha256(sums)
}

const pin = (name: string) => readFileSync(join(root, 'locks/pins', `${name}.pin`), 'utf8')
const toolsPin = () => readFileSync(join(root, 'locks/mica-build-tools.pin'), 'utf8')

beforeAll(() => {
  mkdirSync(join(ROOT, '.tmp'), { recursive: true })
  scratch = mkdtempSync(join(ROOT, '.tmp/update-'))
  stub = new Stub()
  // This tool's own repository: two commits, each with its bootstrap.
  tools = join(scratch, 'mica-build-tools')
  mkdirSync(join(tools, 'bootstrap'), { recursive: true })
  git(tools, ['init', '--quiet'])
  for (const body of ['#!/usr/bin/env bash\n# bootstrap one\n', '#!/usr/bin/env bash\n# bootstrap two\n', '#!/usr/bin/env bash\n# bootstrap three\n']) {
    writeFileSync(join(tools, 'bootstrap/mica-tools'), body)
    git(tools, ['add', '.'])
    git(tools, ['commit', '--quiet', '-m', 'tools'])
    commits.push(git(tools, ['rev-parse', 'HEAD']))
  }
  stub.release('mica-build-tools', '20260920-0900')
  stub.tagRefs.set('mica-build-tools:20260920-0900', { type: 'commit', sha: commits[0]! })
  stub.release('mica-build-tools', '20260925-0900')
  stub.tagRefs.set('mica-build-tools:20260925-0900', { type: 'commit', sha: commits[1]! })
  publish('mica-core', '20260920-1000', lockAt('mica-core', '20260920-1000'))
  publish('mica-core', '20260921-1000', lockAt('mica-core', '20260921-1000'))
  publish('mica-core', '20260922-1000')
  publish('mica-build-env', '20260914-2042', lockAt('mica-build-env', '20260914-2042'))
})

afterAll(() => {
  stub.stop()
  rmSync(scratch, { recursive: true, force: true })
})

/** A consumer pinning both producers at 20260914-2042 and this tool at its first commit. */
beforeEach(() => {
  root = mkdtempSync(join(scratch, 'consumer-'))
  cpSync(join(V, 'pins/valid/release'), join(root, 'locks'), { recursive: true })
  const sums = sha256(`${sha256(lockAt('mica-build-env', '20260914-2042'))}  mica-build-env.lock\n`)
  writeFileSync(join(root, 'locks/pins/mica-build-env.pin'), `# mica-pin v1\nREPOSITORY=mica-build-env\nRELEASE=20260914-2042\nSHA256SUMS=${sums}\n`)
  writeFileSync(join(root, 'locks/mica-build-tools.pin'), `# mica-tools-pin v1\n# a note about this commit\nREPOSITORY=mica-build-tools\nCOMMIT=${commits[0]}\n`)
  mkdirSync(join(root, 'bin'))
  writeFileSync(join(root, 'bin/mica-tools'), '#!/usr/bin/env bash\n# bootstrap one\n')
  chmodSync(join(root, 'bin/mica-tools'), 0o755)
})

describe('release latest --repository', () => {
  test('the latest release of any repository', async () => {
    expect(await run(['release', 'latest', '--repository', 'mica-core'])).toMatchObject({ code: 0, out: '20260922-1000' })
    expect(await run(['release', 'latest', '--repository', 'mica-core', '--asset', 'mica-core.lock'])).toMatchObject({ code: 0, out: '20260921-1000' })
    expect((await run(['release', 'latest', '--repository', 'Mica_Core'])).code).toBe(1)
    expect((await run(['release', 'latest', '--repository', 'mica-nothing'])).err).toContain('no published release')
  })
})

describe('locks move', () => {
  test('without a release, the latest that carries the lock', async () => {
    const r = await run(['locks', 'move', 'mica-core'])
    expect(r.code).toBe(0)
    expect(pin('mica-core')).toContain('RELEASE=20260921-1000\n')
    expect(readFileSync(join(root, 'locks/mica-core.lock'))).toEqual(Buffer.from(lockAt('mica-core', '20260921-1000')))
    expect((await run(['locks', 'move', 'mica-podman'])).err).toContain('mica-podman has no published release carrying mica-podman.lock')
  })
})

describe('locks update', () => {
  test('every input to its latest release, this tool with its bootstrap', async () => {
    const r = await run(['locks', 'update'])
    expect(r.code).toBe(0)
    expect(r.out.split('\n')).toEqual([
      'mica-build-env 20260914-2042 unchanged',
      'mica-core 20260914-2042 -> 20260921-1000',
      `mica-build-tools ${commits[0]} -> ${commits[1]} (20260925-0900)`,
    ])
    expect(pin('mica-core')).toBe(`# mica-pin v1\nREPOSITORY=mica-core\nRELEASE=20260921-1000\nSHA256SUMS=${sha256(`${sha256(lockAt('mica-core', '20260921-1000'))}  mica-core.lock\n`)}\n`)
    expect(toolsPin()).toBe(`# mica-tools-pin v1\nREPOSITORY=mica-build-tools\nCOMMIT=${commits[1]}\n`)
    expect(readFileSync(join(root, 'bin/mica-tools'), 'utf8')).toBe('#!/usr/bin/env bash\n# bootstrap two\n')
    expect(statSync(join(root, 'bin/mica-tools')).mode & 0o777).toBe(0o755)
    expect(await run(['locks', 'check'])).toMatchObject({ code: 0 })
    // Again: nothing moves.
    const again = await run(['locks', 'update'])
    expect(again.out.split('\n')).toEqual(['mica-build-env 20260914-2042 unchanged', 'mica-core 20260921-1000 unchanged', `mica-build-tools ${commits[1]} unchanged`])
  })

  test('--check says what would move, writes nothing, and exits 1 unless everything is the latest', async () => {
    const tree = () => Bun.spawnSync(['sh', '-c', 'find locks bin -type f | sort | xargs sha256sum'], { cwd: root, stdout: 'pipe' }).stdout.toString()
    const before = tree()
    const behind = await run(['locks', 'update', '--check'])
    expect(behind.code).toBe(1)
    expect(behind.out.split('\n')).toEqual([
      'mica-build-env 20260914-2042 unchanged',
      'mica-core 20260914-2042 -> 20260921-1000',
      `mica-build-tools ${commits[0]} -> ${commits[1]} (20260925-0900)`,
    ])
    expect(behind.err).toBe('error: 2 of 3 inputs would move; mica-tools locks update moves them')
    expect(tree()).toBe(before)
    expect(existsSync(join(root, 'locks/.mica-core.lock.check'))).toBe(false)
    // A release named for an input is what the check holds it to.
    const held = ['mica-core=20260920-1000', `mica-build-tools=${commits[0]}`]
    const named = await run(['locks', 'update', '--check', ...held])
    expect(named.out.split('\n')).toEqual(['mica-build-env 20260914-2042 unchanged', 'mica-core 20260914-2042 -> 20260920-1000', `mica-build-tools ${commits[0]} unchanged`])
    expect([named.code, named.err]).toEqual([1, `error: 1 of 3 inputs would move; mica-tools locks update ${held.join(' ')} moves them`])
    expect(tree()).toBe(before)
    expect((await run(['locks', 'update', ...held])).code).toBe(0)
    expect(await run(['locks', 'update', '--check', ...held])).toMatchObject({ code: 0, err: '' })
    expect((await run(['locks', 'update', '--check'])).code).toBe(1)
    // Once everything is the latest, the check passes.
    expect((await run(['locks', 'update'])).code).toBe(0)
    const current = await run(['locks', 'update', '--check'])
    expect([current.code, current.err]).toEqual([0, ''])
    expect(current.out.split('\n').every(l => l.endsWith(' unchanged'))).toBe(true)
    // The flag comes first, as every flag of this tool does; what fails to verify fails the check.
    expect((await run(['locks', 'update', 'mica-core=20260920-1000', '--check'])).code).toBe(2)
    expect((await run(['locks', 'update', '--check', 'mica-core=20260914-2042'])).err).toContain('HTTP 404')
  })

  test('an input given a release takes that one; this tool takes a release or a commit', async () => {
    const r = await run(['locks', 'update', 'mica-core=20260920-1000', 'mica-build-tools=20260920-0900'])
    expect(r.out.split('\n')).toEqual(['mica-build-env 20260914-2042 unchanged', 'mica-core 20260914-2042 -> 20260920-1000', `mica-build-tools ${commits[0]} unchanged`])
    expect(pin('mica-core')).toContain('RELEASE=20260920-1000\n')
    const byCommit = await run(['locks', 'update', `mica-build-tools=${commits[2]}`])
    expect(byCommit.out.split('\n').at(-1)).toBe(`mica-build-tools ${commits[0]} -> ${commits[2]}`)
    expect(readFileSync(join(root, 'bin/mica-tools'), 'utf8')).toBe('#!/usr/bin/env bash\n# bootstrap three\n')
  })

  test('what is named must be an input, and a release', async () => {
    expect((await run(['locks', 'update', 'mica-podman=20260920-1000'])).err).toContain('mica-podman is no input of locks/')
    expect((await run(['locks', 'update', 'mica-core=latest'])).err).toContain('\'latest\' is not <YYYYMMDD-HHMM>')
    expect((await run(['locks', 'update', 'mica-core'])).code).toBe(2)
    expect((await run(['locks', 'update', 'mica-core=20260920-1000', 'mica-core=20260921-1000'])).err).toContain('mica-core is named twice')
  })

  test('nothing is written unless everything verifies', async () => {
    const release = stub.release('mica-build-env', '20260926-0900')
    const lock = lockAt('mica-build-env', '20260926-0900')
    release.assets.push({ id: 0, name: 'mica-build-env.lock', url: '', bytes: lock },
      { id: 0, name: 'SHA256SUMS', url: '', bytes: new TextEncoder().encode(`${'0'.repeat(64)}  mica-build-env.lock\n`) })
    try {
      const before = [pin('mica-core'), pin('mica-build-env'), toolsPin(), readFileSync(join(root, 'bin/mica-tools'), 'utf8')]
      const r = await run(['locks', 'update'])
      expect(r.code).toBe(1)
      expect(r.err).toContain('does not hash to its SHA256SUMS line')
      expect([pin('mica-core'), pin('mica-build-env'), toolsPin(), readFileSync(join(root, 'bin/mica-tools'), 'utf8')]).toEqual(before)
      expect(existsSync(join(root, 'locks/.mica-core.lock.new'))).toBe(false)
    }
    finally {
      stub.releases.set('mica-build-env', stub.releases.get('mica-build-env')!.filter(x => x !== release))
    }
  })

  test('an offline pin is left as it is, and a repository without the tools pin has none written', async () => {
    const offline = mkdtempSync(join(scratch, 'offline-'))
    cpSync(join(V, 'pins/valid/offline-checkout'), join(offline, 'locks'), { recursive: true })
    const names = ['mica-build-env', 'mica-core'].filter(n => readFileSync(join(offline, 'locks/pins', `${n}.pin`), 'utf8').includes('RELEASE=offline'))
    expect(names.length).toBeGreaterThan(0)
    const r = await run(['locks', 'update'], { MICA_REPO_ROOT: offline })
    expect(r.code).toBe(0)
    for (const n of names) expect(r.out).toContain(`${n} offline, left as it is`)
    expect(existsSync(join(offline, 'locks/mica-build-tools.pin'))).toBe(false)
    expect(r.out).not.toContain('mica-build-tools')
  })
})
