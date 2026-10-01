// The xz decoder against streams another implementation wrote (Python's lzma, tests/fixtures/xz/expected.tsv):
// every preset shape, literal and position bits, uncompressed chunks, check types and concatenated streams.
import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ToolError } from '../src/errors.ts'
import { unxz } from '../src/deb/xz.ts'
import { table } from './vectors.ts'

const DIR = join(import.meta.dir, 'fixtures/xz')

describe('unxz', () => {
  test.each(table(readFileSync(join(DIR, 'expected.tsv'), 'utf8')))('%s', (file, sha256, size) => {
    const out = unxz(new Uint8Array(readFileSync(join(DIR, file!))))
    expect([out.length, createHash('sha256').update(out).digest('hex')]).toEqual([Number(size), sha256!])
  })

  test('refuses what is not xz, and a truncated stream', () => {
    expect(() => unxz(new TextEncoder().encode('not xz at all'))).toThrow(ToolError)
    const data = new Uint8Array(readFileSync(join(DIR, 'mixed.xz')))
    expect(() => unxz(data.subarray(0, data.length - 100))).toThrow(ToolError)
  })
})
