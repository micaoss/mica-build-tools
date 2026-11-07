// The row comparison release attach writes into the notes (design 3.4): by kind, a reference compared by its digest
// alone, since its tag names the release (lock 1.3) and differs on every release.
import { describe, expect, test } from 'bun:test'
import { rowComparison } from '../src/release/attach.ts'

const D1 = 'a'.repeat(64), D2 = 'b'.repeat(64)
const lock = (release: string, base: string, extra = '') => `# mica-lock v1\nrelease\tmica-build-env\t${release}\t${'c'.repeat(40)}\n`
  + `image\tmica-build-env\tbase\tamd64\tghcr.io/micaoss/mica-build-env@sha256:${base}\n`
  + `image\tmica-build-env\tbase\tindex\tghcr.io/micaoss/mica-build-env:base.${release}@sha256:${base}\n`
  + `image\tupstream\tdebian:trixie-slim\tamd64\tdocker.io/library/debian:trixie-slim@sha256:${D1}\n${extra}`

describe('rowComparison', () => {
  test('a new tag on the same digest is unchanged', () => {
    expect(rowComparison('20260916-0735', lock('20260916-0735', D1), lock('20260926-1900', D1)))
      .toBe('Images: unchanged from 20260916-0735.')
  })

  test('another digest is changed, and the rows are listed', () => {
    const notes = rowComparison('20260916-0735', lock('20260916-0735', D1), lock('20260926-1900', D2))
    expect(notes.split('\n')[0]).toBe('Images: changed from 20260916-0735.')
    expect(notes).toContain(`- image mica-build-env base index ghcr.io/micaoss/mica-build-env:base.20260916-0735@sha256:${D1}`)
    expect(notes).toContain(`+ image mica-build-env base index ghcr.io/micaoss/mica-build-env:base.20260926-1900@sha256:${D2}`)
  })

  test('each kind of either lock has its line; a kind that appears is changed', () => {
    const withData = lock('20260926-1900', D1, `data\tunowned\tunowned.tsv\t${D2}\n`)
    expect(rowComparison('20260916-0735', lock('20260916-0735', D1), withData).split('\n').slice(0, 2))
      .toEqual(['Images: unchanged from 20260916-0735.', 'Data: changed from 20260916-0735.'])
  })

  test('a comparison too long for the notes keeps the kind lines with counts, and drops the rows', () => {
    const packages = (version: string) => Array.from({ length: 2000 }, (_, i) => `package\tmica-p${i}\tamd64\t${version}\t${'d'.repeat(64)}\n`).join('')
    const notes = rowComparison('20261031-0315', lock('20261031-0315', D1, packages('1.0-1')), lock('20261101-1022', D1, packages('1.0-2')), 'mica-system-base.lock')
    expect(notes.length).toBeLessThanOrEqual(120000)
    expect(notes).not.toContain('```diff')
    expect(notes.split('\n')).toEqual([
      'Images: unchanged from 20261031-0315.',
      'Packages: changed from 20261031-0315 (2000 removed, 2000 added).',
      'The rows that differ are too many for the notes; compare the rows of mica-system-base.lock in 20261031-0315 and in this release.',
    ])
  })

  test('the limit is what the rest of the notes leaves', () => {
    const before = lock('20260916-0735', D1), after = lock('20260926-1900', D2)
    const full = rowComparison('20260916-0735', before, after)
    expect(rowComparison('20260916-0735', before, after, 'the lock', full.length)).toBe(full)
    expect(rowComparison('20260916-0735', before, after, 'the lock', full.length - 1)).not.toContain('```diff')
  })

  test('with no previous release', () => {
    expect(rowComparison(undefined, '', lock('20260926-1900', D1), 'mica-build-env.lock')).toBe('Images: the first release carrying mica-build-env.lock.')
  })
})
