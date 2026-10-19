// The bootstrap (design 2.2) against a local repository standing in for GitHub: online, offline once cached,
// offline with nothing cached, a broken pin, and self-check over a changed copy.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { chmodSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT } from './vectors.ts'

let scratch = '', remote = '', consumer = '', commit = ''

function sh(argv: string[], cwd: string, env: Record<string, string> = {}): { code: number, out: string, err: string } {
  const r = Bun.spawnSync(argv, { cwd, env: { ...process.env, MICA_BUN: process.execPath, ...env }, stdout: 'pipe', stderr: 'pipe' })
  return { code: r.exitCode ?? -1, out: r.stdout.toString(), err: r.stderr.toString() }
}

function pin(body: string): void {
  mkdirSync(join(consumer, 'locks'), { recursive: true })
  writeFileSync(join(consumer, 'locks/mica-build-tools.pin'), body)
}

beforeAll(() => {
  mkdirSync(join(ROOT, '.tmp'), { recursive: true })
  scratch = mkdtempSync(join(ROOT, '.tmp/bootstrap-'))
  // The remote: this tree's sources, committed.
  remote = join(scratch, 'mica-build-tools')
  for (const path of ['src', 'bootstrap', 'package.json']) cpSync(join(ROOT, path), join(remote, path), { recursive: true })
  const git = (args: string[]) => sh(['git', '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], remote)
  git(['init', '--quiet'])
  git(['add', '.'])
  git(['commit', '--quiet', '-m', 'tools'])
  commit = git(['rev-parse', 'HEAD']).out.trim()
  consumer = join(scratch, 'consumer')
  mkdirSync(join(consumer, 'bin'), { recursive: true })
  cpSync(join(ROOT, 'bootstrap/mica-tools'), join(consumer, 'bin/mica-tools'))
  chmodSync(join(consumer, 'bin/mica-tools'), 0o755)
  sh(['git', 'init', '--quiet'], consumer)
})

afterAll(() => rmSync(scratch, { recursive: true, force: true }))

describe('bin/mica-tools', () => {
  test('offline with nothing cached is offline-miss', () => {
    pin(`# mica-tools-pin v1\nREPOSITORY=mica-build-tools\nCOMMIT=${commit}\n`)
    const r = sh(['bin/mica-tools', 'sync'], consumer, { MICA_OFFLINE: '1', MICA_TOOLS_URL: remote })
    expect([r.code, r.out]).toEqual([1, 'refused offline-miss\n'])
  })

  test('online, it fetches the commit and runs it in the caller\'s directory', () => {
    const r = sh(['bin/mica-tools', 'pin', 'check', 'locks/mica-build-tools.pin'], consumer, { MICA_TOOLS_URL: remote })
    expect([r.code, r.out, r.err]).toEqual([0, 'valid\n', ''])
    expect(sh(['git', '-C', join(consumer, 'repos/mica-build-tools'), 'rev-parse', 'HEAD'], consumer).out.trim()).toBe(commit)
  })

  test('the mirror keeps the commit through a gc: it holds a ref to it', () => {
    const mirror = join(consumer, 'repos/git/mica-build-tools.git')
    expect(sh(['git', '--git-dir', mirror, 'rev-parse', `refs/pins/${commit}`], consumer).out.trim()).toBe(commit)
    expect(sh(['git', '--git-dir', mirror, 'gc', '--quiet', '--prune=now'], consumer).code).toBe(0)
    rmSync(join(consumer, 'repos/mica-build-tools'), { recursive: true })
    const r = sh(['bin/mica-tools', 'pin', 'check', 'locks/mica-build-tools.pin'], consumer, { MICA_OFFLINE: '1' })
    expect([r.code, r.out, r.err]).toEqual([0, 'valid\n', ''])
  })

  test('offline once cached, it runs and fetches nothing', () => {
    const r = sh(['bin/mica-tools', 'pin', 'check', 'locks/mica-build-tools.pin'], consumer, { MICA_OFFLINE: '1', MICA_TOOLS_URL: '/nonexistent' })
    expect([r.code, r.out]).toEqual([0, 'valid\n'])
  })

  test('a changed checkout is replaced', () => {
    writeFileSync(join(consumer, 'repos/mica-build-tools/package.json'), '{}\n')
    const r = sh(['bin/mica-tools', 'sync'], consumer, { MICA_OFFLINE: '1' })
    expect(r.code).toBe(0)
    expect(sh(['git', '-C', join(consumer, 'repos/mica-build-tools'), 'status', '--porcelain'], consumer).out).toBe('')
  })

  test('self-check passes on the copy and refuses a changed one', () => {
    expect(sh(['bin/mica-tools', 'self-check'], consumer, { MICA_OFFLINE: '1' }).code).toBe(0)
    writeFileSync(join(consumer, 'bin/mica-tools'), '\n', { flag: 'a' })
    const r = sh(['bin/mica-tools', 'self-check'], consumer, { MICA_OFFLINE: '1' })
    expect([r.code, r.out]).toEqual([1, 'refused bootstrap-drift\n'])
    cpSync(join(ROOT, 'bootstrap/mica-tools'), join(consumer, 'bin/mica-tools'))
  })

  test.each([
    ['# mica-tools-pin v2\nREPOSITORY=mica-build-tools\nCOMMIT=@\n', 'header'],
    ['# mica-tools-pin v1\nCOMMIT=@\nREPOSITORY=mica-build-tools\n', 'pin-format'],
    ['# mica-tools-pin v1\nREPOSITORY=mica-build-tools\nCOMMIT=abc\n', 'field-value'],
    ['# mica-tools-pin v1\nREPOSITORY=mica-build-tools\nCOMMIT=@', 'encoding'],
    ['# mica-tools-pin v1\r\nREPOSITORY=mica-build-tools\nCOMMIT=@\n', 'encoding'],
  ])('a pin %j is refused as %s', (body, rule) => {
    pin(body.replace('@', commit))
    const r = sh(['bin/mica-tools', 'sync'], consumer, { MICA_OFFLINE: '1' })
    expect([r.code, r.out]).toEqual([1, `refused ${rule}\n`])
  })

  test('a comment after the header is allowed', () => {
    pin(`# mica-tools-pin v1\n# a note\nREPOSITORY=mica-build-tools\nCOMMIT=${commit}\n`)
    expect(sh(['bin/mica-tools', 'sync'], consumer, { MICA_OFFLINE: '1' }).code).toBe(0)
  })
})
