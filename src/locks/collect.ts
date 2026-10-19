// The collect mode (docs/spec/release-lock.md 9.4): every rule a file breaks, by running the checker again
// with each rule found suppressed. A structural refusal is reported alone, because the rest of the file is not
// readable after it; a run that walks into what a suppressed check was protecting stops, and reports what it had.
// It under-reports by construction and never invents a rule.
import { Refused } from '../errors.ts'
import { Checker } from './rules.ts'

const STRUCTURAL = new Set(['header', 'encoding', 'kind-unknown', 'column-count', 'release-row'])

export type Collected = { outcome: 'valid' | 'set' | 'stopped', rules: string[] }

export function collect(check: (path: string, checker: Checker) => unknown, path: string): Collected {
  const found: string[] = []
  for (;;) {
    try {
      check(path, new Checker(new Set(found)))
    }
    catch (e) {
      if (!(e instanceof Refused)) return { outcome: 'stopped', rules: found.sort() }
      found.push(e.rule)
      if (STRUCTURAL.has(e.rule)) break
      continue
    }
    break
  }
  return { outcome: found.length === 0 ? 'valid' : 'set', rules: found.sort() }
}
