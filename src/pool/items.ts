// Pool items (lock 1.2.7): a file `<name>_<version>_<arch>.<type>` of `_out/debs/<arch>/pool` whose type the format
// does not know, one layer of the pool and one `item` row of the lock. Nothing here reads an item's bytes or knows a
// type: a new type is a file its producer adds and a row its consumer reads.
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ToolError } from '../errors.ts'
import { NAME, VERSION } from '../locks/rules.ts'

/** The media type of an item's layer is this and its type. */
export const ITEM_LAYER = 'application/vnd.mica.item.'
/** The type that is no item's: an archive's file. */
const ARCHIVE = 'deb'

export type Item = { type: string, name: string, version: string, arch: string, file: string, bytes: Uint8Array, sha256: string }

/** The type a file of a pool carries: what follows the first dot after its second underscore. */
function typeOf(file: string): string | undefined {
  const parts = file.split('_')
  const dot = parts.length === 3 ? parts[2]!.indexOf('.') : -1
  return dot > 0 ? parts[2]!.slice(dot + 1) : undefined
}

/** What a file of a pool directory is, by its type; a file with no type in its name by its suffix. */
export function fileKind(file: string): 'archive' | 'item' {
  const type = typeOf(file) ?? file.slice(file.lastIndexOf('.') + 1)
  return type === ARCHIVE ? 'archive' : 'item'
}

/** The identity an item's file name states, or why it is no item of this pool. */
export function itemOf(file: string, arch: string): { type: string, name: string, version: string } {
  const [name = '', version = '', rest = ''] = file.split('_')
  const type = typeOf(file) ?? ''
  if (rest !== `${arch}.${type}` || !NAME.test(name) || !VERSION.test(version) || !NAME.test(type) || fileKind(file) !== 'item')
    throw new ToolError(`${arch}/pool/${file} is not named <name>_<version>_${arch}.<type>`)
  return { type, name, version }
}

/** The items of one pool directory, sorted by file name; every file that is no item of it is named in the refusal. */
export function poolItems(pool: string, arch: string): Item[] {
  const files = existsSync(pool) ? readdirSync(pool).filter(f => fileKind(f) === 'item').sort() : []
  const problems: string[] = []
  const items = files.flatMap((file) => {
    try {
      const bytes = new Uint8Array(readFileSync(join(pool, file)))
      return [{ ...itemOf(file, arch), arch, file, bytes, sha256: createHash('sha256').update(bytes).digest('hex') }]
    }
    catch (e) {
      if (!(e instanceof ToolError)) throw e
      problems.push(e.message)
      return []
    }
  })
  if (problems.length > 0) throw new ToolError(problems.join('; '))
  return items
}
