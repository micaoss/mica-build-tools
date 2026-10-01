// The archive reader against archives dpkg-deb wrote (tests/fixtures/deb): xz, gzip and no compression; a long
// member name (GNU L entry); a symlink; the refusals by name.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ToolError } from '../src/errors.ts'
import { controlFields, controlText, installedPath, payloadEntries, payloadMember } from '../src/deb/archive.ts'

const DIR = join(import.meta.dir, 'fixtures/deb')
const long = `usr/share/mica-test/deep/${'d'.repeat(60)}/${'f'.repeat(80)}`

describe('deb', () => {
  test.each(['xz', 'gz', 'none'])('%s: control, fields, payload', (kind) => {
    const deb = join(DIR, `mica-test_${kind}.deb`)
    expect(controlText(deb)).toBe(readFileSync(join(DIR, 'control'), 'utf8'))
    expect(controlFields(controlText(deb))).toMatchObject({ 'Package': 'mica-test', 'Description': 'a fixture\n two lines', 'Mica-Source-Repo': 'mica-build-tools' })
    const listed = readFileSync(join(DIR, 'contents'), 'utf8').trim().split('\n').map(l => l.split(' ')[1]!)
    expect(payloadEntries(deb).map(e => e.name)).toEqual(listed)
    const file = payloadMember(deb, '/usr/share/mica-test/file')
    expect([new TextDecoder().decode(file.body), file.mode & 0o777, file.uid, file.gid]).toEqual(['payload\n', 0o755, 0, 0])
    expect(new TextDecoder().decode(payloadMember(deb, long).body)).toBe('long\n')
    expect(payloadEntries(deb).find(e => installedPath(e.name) === 'usr/bin/mica-test')?.linkname).toBe('../share/mica-test/file')
  })

  test('refuses a symlink or a missing path as a member, zstd, and what is not an archive', () => {
    const deb = join(DIR, 'mica-test_xz.deb')
    expect(() => payloadMember(deb, 'usr/bin/mica-test')).toThrow('is not a regular file')
    expect(() => payloadMember(deb, 'usr/nothing')).toThrow('carries no usr/nothing')
    expect(() => controlText(join(DIR, 'mica-test_zst.deb'))).toThrow('only .tar, .tar.gz and .tar.xz are read')
    expect(() => controlText(join(DIR, 'control'))).toThrow(ToolError)
  })
})
