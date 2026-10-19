// The canonical vectors of the release lock, docs/spec/release-lock/vectors/ of this repository (spec section 9).
import { join, resolve } from 'node:path'

export const ROOT = resolve(import.meta.dir, '..')

export function vectorsDir(): string {
  return join(ROOT, 'docs/spec/release-lock/vectors')
}

/** The rows of a vectors table: comment lines dropped, tab-separated. */
export function table(text: string): string[][] {
  return text.split('\n').filter(l => l !== '' && !l.startsWith('#')).map(l => l.split('\t'))
}
