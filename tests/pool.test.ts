// `pool index` against what dpkg-scanpackages and mica-core's scripts/deb/repo.sh wrote over the same archives
// (tests/fixtures/pool): known fields in dpkg's order, other fields by name, a description with an empty line,
// two versions of one package, an `all` archive.
import { describe, expect, test } from 'bun:test'
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { indexPool, writeIndex } from '../src/pool/index.ts'
import { ROOT } from './vectors.ts'

const DIR = join(import.meta.dir, 'fixtures/pool')

describe('pool index', () => {
  test('Packages, SHA256SUMS and manifest.txt, byte for byte', () => {
    const got = indexPool(DIR, 'amd64')
    expect(got.packages).toBe(readFileSync(join(DIR, 'Packages'), 'utf8'))
    expect(got.sums).toBe(readFileSync(join(DIR, 'SHA256SUMS'), 'utf8'))
    expect(got.manifest).toBe(readFileSync(join(DIR, 'manifest.txt'), 'utf8'))
  })

  test('writes the three files, and refuses another architecture', () => {
    const dist = mkdtempSync(join(ROOT, '.tmp/pool-'))
    try {
      cpSync(join(DIR, 'pool'), join(dist, 'pool'), { recursive: true })
      expect(writeIndex(dist, 'amd64')).toBe('amd64: 3 package(s)')
      expect(readFileSync(join(dist, 'Packages'), 'utf8')).toBe(readFileSync(join(DIR, 'Packages'), 'utf8'))
      expect(() => indexPool(dist, 'arm64')).toThrow('is Architecture amd64, not arm64')
    }
    finally {
      rmSync(dist, { recursive: true, force: true })
    }
  })
})
