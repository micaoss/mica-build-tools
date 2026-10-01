// Conformance: every row of expected.tsv and refusal-sets.tsv, every family (design section 6), and what holds
// the vectors themselves: every file is listed, and every refused lock declares the valid one it is written
// against (spec 9.3). There is no subset: this code reads every form every repository reads.
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { Refused } from '../src/errors.ts'
import { collect } from '../src/locks/collect.ts'
import { checkLock } from '../src/locks/lock.ts'
import { checkLocks, readToolsPin, type Mode } from '../src/locks/pins.ts'
import { checkUpstream } from '../src/locks/upstream.ts'
import { lookup } from '../src/repos/cache.ts'
import { table, vectorsDir } from './vectors.ts'

const V = vectorsDir()
const expected = table(readFileSync(join(V, 'expected.tsv'), 'utf8'))
const sets = table(readFileSync(join(V, 'refusal-sets.tsv'), 'utf8'))

function outcome(family: string, path: string, mode: string): string {
  try {
    if (family === 'lock') { checkLock(path) }
    else if (family === 'upstream') { checkUpstream(path) }
    else if (family === 'tools-pin') { readToolsPin(path) }
    else if (family === 'pins') { checkLocks(path, mode as Mode) }
    else if (family === 'repos') {
      const [[sha256]] = table(readFileSync(join(path, 'request'), 'utf8')) as [[string, string]]
      lookup(join(path, 'repos'), sha256, mode === 'offline')
    }
    else { throw new Error(`no reader for the family ${family}`) }
  }
  catch (e) {
    if (e instanceof Refused) return `refused ${e.rule}`
    throw e
  }
  return 'valid'
}

describe('expected.tsv', () => {
  test('lists every family', () => {
    expect(new Set(expected.map(([path]) => path!.split('/')[0]))).toEqual(new Set(['lock', 'upstream', 'tools-pin', 'pins', 'repos']))
  })
  test.each(expected)('%s is %s %s (%s)', (path, result, rule, mode) => {
    const want = result === 'refused' ? `refused ${rule}` : 'valid'
    expect(outcome(path!.split('/')[0]!, join(V, path!), mode!)).toBe(want)
  })
})

describe('refusal-sets.tsv', () => {
  test('covers every refused lock and upstream vector', () => {
    const refused = expected.filter(([path, result]) => result === 'refused' && /^(lock|upstream)\//.test(path!)).map(([path]) => path).sort()
    expect(sets.map(([path]) => path).sort()).toEqual(refused)
  })
  test.each(sets)('%s: %s %s', (path, form, rules) => {
    const checker = path!.startsWith('lock/') ? checkLock : checkUpstream
    const got = collect(checker, join(V, path!))
    expect({ outcome: got.outcome, rules: got.rules.join(' ') }).toEqual({ outcome: form === 'set' ? 'set' : 'stopped', rules: rules! })
  })
})

/** Every file under a directory of the vectors, as paths relative to the vectors. */
function files(dir: string): string[] {
  return readdirSync(join(V, dir)).sort().flatMap((name) => {
    const path = `${dir}/${name}`
    return statSync(join(V, path)).isDirectory() ? files(path) : [path]
  })
}
const directories = (dir: string) => readdirSync(join(V, dir)).sort().map(name => `${dir}/${name}`).filter(path => statSync(join(V, path)).isDirectory())
const rowsOf = (path: string) => readFileSync(join(V, path), 'utf8').split('\n')
/** The lines a line diff of two vectors removes and adds. */
function changed(a: string, b: string): number {
  const diff = Bun.spawnSync(['diff', join(V, a), join(V, b)], { stdout: 'pipe' })
  return diff.stdout.toString().split('\n').filter(l => /^[<>]/.test(l)).length
}

describe('the vectors themselves', () => {
  const listed = new Set(expected.map(([path]) => path!))
  const derived = table(readFileSync(join(V, 'derived-from.tsv'), 'utf8')) as [string, string, string][]

  test('every vector on disk is listed in expected.tsv', () => {
    const onDisk = [
      ...files('lock').filter(f => f.endsWith('.lock')), ...files('upstream').filter(f => f.endsWith('.lock')),
      ...files('tools-pin').filter(f => f.endsWith('.pin')),
      ...directories('pins').flatMap(directories), ...directories('repos'),
    ]
    expect(onDisk.length).toBeGreaterThan(50)
    expect(onDisk.filter(v => !listed.has(v))).toEqual([])
    expect([...listed].filter(v => !onDisk.includes(v))).toEqual([])
  })

  test('every refused lock declares its derivation, and only a refused lock does', () => {
    const refused = [...files('lock/refused'), ...files('upstream/refused')].filter(f => f.endsWith('.lock')).sort()
    expect(derived.map(([vector]) => vector).sort()).toEqual(refused)
  })

  test.each(derived)('%s is %s %s', (vector, relation, sibling) => {
    expect(listed.has(sibling)).toBe(true)
    const lines = changed(sibling, vector)
    const sameRows = JSON.stringify(rowsOf(sibling).sort()) === JSON.stringify(rowsOf(vector).sort())
    expect(lines).toBeGreaterThan(0)
    expect(['edit-of', 'reorder-of', 'minimal-of']).toContain(relation)
    // An edit is at most two changed lines; a reorder holds exactly its sibling's rows, so order is all it can break.
    if (relation === 'edit-of') expect(lines).toBeLessThanOrEqual(2)
    if (relation === 'reorder-of' || vector.endsWith('/unsorted.lock')) expect(sameRows).toBe(true)
  })

  test.each(sets)('%s: the rule expected.tsv names is in its set, and the repair column is a word of its vocabulary', (path, _form, rules, repaired) => {
    const named = expected.find(([vector]) => vector === path)![2]!
    expect(rules!.split(' ')).toContain(named)
    expect(['valid', 'unmeasured']).toContain(repaired)
  })
})
