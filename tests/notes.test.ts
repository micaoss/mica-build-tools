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

  test('with no previous release', () => {
    expect(rowComparison(undefined, '', lock('20260926-1900', D1), 'mica-build-env.lock')).toBe('Images: the first release carrying mica-build-env.lock.')
  })
})
