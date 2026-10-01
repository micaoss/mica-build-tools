// A scope and a product name are `<name>` or `<name>.<name>`: a product is named under its board
// (`cx3576.dev`), and a product-scoped release carries that name. A board stays one name.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Refused, ToolError } from '../src/errors.ts'
import { checkLock } from '../src/locks/lock.ts'
import { checkPins } from '../src/locks/pins.ts'
import { releaseTag } from '../src/release/check.ts'
import { scopeOf } from '../src/release/latest.ts'
import { ROOT, vectorsDir } from './vectors.ts'

const V = vectorsDir()
let scratch = ''

beforeAll(() => {
  mkdirSync(join(ROOT, '.tmp'), { recursive: true })
  scratch = mkdtempSync(join(ROOT, '.tmp/scope-'))
})
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

/** The scoped vector with its scope and its product names rewritten. */
function lock(name: string, edit: (text: string) => string): string {
  const path = join(scratch, name)
  writeFileSync(path, edit(readFileSync(join(V, 'lock/valid/mica-build.uefi-x64.lock'), 'utf8')))
  return path
}
const rule = (path: string): string => {
  try { checkLock(path); return 'valid' }
  catch (e) { if (e instanceof Refused) return e.rule; throw e }
}
// uefi-x64-dev sorts before uefi-x64-minimal, and uefi-x64.dev before uefi-x64.minimal: the order holds.
const dotted = (text: string) => text.replaceAll('uefi-x64-dev', 'uefi-x64.dev').replaceAll('uefi-x64-minimal', 'uefi-x64.minimal')

describe('a scope or a product of two names', () => {
  test('a lock: dotted products, and a release scoped to one', () => {
    expect(rule(lock('products.lock', dotted))).toBe('valid')
    const scoped = lock('scoped.lock', t => dotted(t).replace('\tuefi-x64.20260914-2042\t', '\tuefi-x64.dev.20260914-2042\t'))
    expect(rule(scoped)).toBe('valid')
    expect(checkLock(scoped)).toMatchObject({ scope: 'uefi-x64.dev', release: '20260914-2042' })
    expect(rule(lock('input.lock', t => t.replace('input\tmica-core\t', 'input\tmica-build.uefi-x64.dev\t').replace(/^(input\tmica-build\.uefi-x64\.dev.*)\n(input\tmica-build-env.*)\n/m, '$2\n$1\n')))).toBe('valid')
  })

  test('a lock: three names, an empty name and a dotted board are refused', () => {
    expect(rule(lock('three.lock', t => t.replace('\tuefi-x64.20260914-2042\t', '\ta.b.c.20260914-2042\t')))).toBe('field-value')
    expect(rule(lock('empty.lock', t => t.replace('\tuefi-x64.20260914-2042\t', '\tuefi-x64..20260914-2042\t')))).toBe('field-value')
    expect(rule(lock('product3.lock', t => t.replaceAll('uefi-x64-dev', 'uefi-x64.dev.a')))).toBe('field-value')
    expect(rule(lock('board.lock', t => t.replace('product\tuefi-x64-dev\tuefi-x64\t', 'product\tuefi-x64-dev\tuefi.x64\t')))).toBe('field-value')
  })

  test('a pin: SCOPE and the file name carry both names', () => {
    const locks = join(scratch, 'locks')
    mkdirSync(join(locks, 'pins'), { recursive: true })
    const text = dotted(readFileSync(join(V, 'lock/valid/mica-build.uefi-x64.lock'), 'utf8')).replace('\tuefi-x64.20260914-2042\t', '\tuefi-x64.dev.20260914-2042\t')
    writeFileSync(join(locks, 'mica-build.uefi-x64.dev.lock'), text)
    writeFileSync(join(locks, 'pins/mica-build.uefi-x64.dev.pin'), `# mica-pin v1\nREPOSITORY=mica-build\nSCOPE=uefi-x64.dev\nRELEASE=20260914-2042\nSHA256SUMS=${'a'.repeat(64)}\n`)
    expect(checkPins(locks, 'local').map(i => [i.name, i.lock.scope])).toEqual([['mica-build.uefi-x64.dev', 'uefi-x64.dev']])
    writeFileSync(join(locks, 'pins/mica-build.uefi-x64.dev.pin'), `# mica-pin v1\nREPOSITORY=mica-build\nSCOPE=uefi-x64.dev.a\nRELEASE=20260914-2042\nSHA256SUMS=${'a'.repeat(64)}\n`)
    expect(() => checkPins(locks, 'local')).toThrow('field-value')
  })

  test('a release tag', () => {
    const now = new Date('2026-09-27T00:00:00Z')
    expect(releaseTag('mica-build', 'uefi-x64.20260925-1000', now)).toEqual({ scope: 'uefi-x64', stamp: '20260925-1000' })
    expect(releaseTag('mica-build', 'uefi-x64.dev.20260925-1000', now)).toEqual({ scope: 'uefi-x64.dev', stamp: '20260925-1000' })
    expect(() => releaseTag('mica-build', 'a.b.c.20260925-1000', now)).toThrow(ToolError)
    expect(() => releaseTag('mica-build', 'uefi-x64..20260925-1000', now)).toThrow(ToolError)
    expect(() => releaseTag('mica-core', 'uefi-x64.dev.20260925-1000', now)).toThrow('no scoped releases')
    expect([scopeOf('20260925-1000'), scopeOf('uefi-x64.20260925-1000'), scopeOf('uefi-x64.dev.20260925-1000'), scopeOf('uefi-x64/20260925-1000'), scopeOf('a.b.c.20260925-1000'), scopeOf('v1')])
      .toEqual(['', 'uefi-x64', 'uefi-x64.dev', 'uefi-x64', undefined, undefined])
  })
})

describe('kinds outside the format', () => {
  test('mica is a scope like any other, and an index row is a kind nobody reads', () => {
    expect(rule(lock('mica.lock', t => t.replace('\tuefi-x64.20260914-2042\t', '\tmica.20260914-2042\t')))).toBe('valid')
    for (const row of [`origin\tmica-build.uefi-x64\t${'0'.repeat(40)}`, 'index\tuefi-x64-dev\tmica-build.uefi-x64',
      `built\tmica-build.uefi-x64\tmica-core\t20260914-2042\t${'6'.repeat(64)}`])
      expect(rule(lock('index-row.lock', t => `${t}${row}\n`))).toBe('kind-unknown')
  })
})
