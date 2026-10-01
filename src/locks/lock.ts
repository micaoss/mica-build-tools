// The release lock, `mica-lock v1` (docs/spec/release-lock.md section 1): the one checker of every file
// rule, every row kind and every refusal of 1.5, scoped locks included.
//
// The order of the checks is fixed: the first rule broken is what expected.tsv names, and the set the collect mode
// finds is what refusal-sets.tsv records.
import {
  ARCH, BOARD, Checker, COMMIT, NAME, need, Stop, PLATFORM, REFERENCE, RELEASE, REPOSITORY, SCOPE, SCOPED, SHA256, VERSION,
  checkUpstreamImage, isSorted, linesOf, partition, rpartition, type Row, type SortKey,
} from './rules.ts'

export const LOCK_HEADER = '# mica-lock v1'

/** The kinds of 1.2, in the order of 1.4, and their column counts. */
export const KIND_COLUMNS: Record<string, number> = {
  release: 4, image: 5, pool: 3, package: 5, item: 6, board: 5, upstream: 7, apt: 5,
  input: 4, product: 8, bundle: 4, asset: 6, data: 4,
}
const KIND_ORDER = Object.keys(KIND_COLUMNS)
const BASE_ONLY = new Set(['upstream', 'apt'])
const BUILD_ONLY = new Set(['input', 'product', 'bundle', 'asset'])
/** 1.2.7: an archive's file suffix is no item's type. */
const ARCHIVE_TYPE = 'deb'
const PROFILE = new Set(['dev', 'prod'])
const GENERATION = /^[1-9][0-9]*$/
const BUNDLE = new Set(['image', 'update'])
const UPDATE_SUFFIX: Record<string, string> = { full: 'micaupd', root: 'root.micaupd', kernel: 'kernel.micaupd' }
const COMPONENT = new Set(['kernel', 'uboot', 'firmware'])
const APT_SNAPSHOT = /\/([0-9]{8}T[0-9]{6}Z)\/?$/

/** A lock that passed section 1. */
export type Lock = {
  rows: Row[]
  repository: string
  /** The scope of a scoped release, '' for an unscoped one. */
  scope: string
  /** `<YYYYMMDD-HHMM>` or `offline`, without the scope. */
  release: string
  commit: string
}

/** Checks one release lock and returns its rows; refuses at the first rule broken (1.5). */
export function checkLock(path: string, check: Checker = new Checker()): Lock {
  const rows = linesOf(path, LOCK_HEADER, check)
  for (const row of rows) {
    if (!Object.hasOwn(KIND_COLUMNS, row[0]!)) check.refuse('kind-unknown', row[0])
    if (row.length !== KIND_COLUMNS[row[0]!]) check.refuse('column-count', row.join('\t'))
  }
  if (rows.length === 0 || rows[0]![0] !== 'release' || rows.filter(r => r[0] === 'release').length !== 1)
    check.refuse('release-row', path)
  const [, repository, releaseField, commit] = rows[0]! as [string, string, string, string]
  const [scope, release] = rpartition(releaseField, '.')
  check.field(REPOSITORY.test(repository) && (RELEASE.test(release) || release === 'offline') && COMMIT.test(commit)
    && (scope === '' || SCOPE.test(scope)), rows[0]!.join('\t'))
  if ((scope !== '') !== SCOPED.has(repository)) check.refuse('release-scope', rows[0]!.join('\t'))
  const registry = release === 'offline' ? 'local' : 'ghcr.io/micaoss'

  const reference = (value: string, expected = repository): string => {
    if (!value.includes('@sha256:')) check.refuse('reference-digest', value)
    const m = REFERENCE.exec(value)
    if (!m) check.refuse(value.startsWith('ghcr.io/micaoss/') || value.startsWith('local/') ? 'field-value' : 'reference-registry', value)
    const groups = need(m?.groups, `the reference ${value}`)
    if (groups.registry !== registry) check.refuse('reference-registry', value)
    if (groups.repository !== expected) check.refuse('reference-repository', value)
    return groups.tag ?? ''
  }

  const assetFile = (row: Row, assetRelease: string): boolean => {
    const prefix = `mica-${row[1]}-${assetRelease}.`
    if (row[2] === 'image') return row[4]!.startsWith(prefix)
    return row[4] === prefix + need(Object.hasOwn(UPDATE_SUFFIX, row[3]!) ? UPDATE_SUFFIX[row[3]!] : undefined, `the update kind ${row[3]}`)
  }

  const keys = new Set<string>(), pools = new Set<string>(), sortKeys: SortKey[] = []
  for (const row of rows.slice(1)) {
    const kind = row[0]!
    const text = row.join('\t')
    let key: string[]
    if (kind === 'image') {
      if (row[1] === 'upstream') {
        checkUpstreamImage(row, check)
      }
      else if (REPOSITORY.test(row[1]!)) {
        check.field(NAME.test(row[2]!) && PLATFORM.has(row[3]!), text)
        reference(row[4]!, row[1]!)
        if (row[1] !== repository) check.refuse('image-source', text)
      }
      else {
        check.refuse('image-source', text)
      }
      key = [row[1]!, row[2]!, row[3]!]
    }
    else if (kind === 'pool') {
      check.field(ARCH.has(row[1]!), text)
      reference(row[2]!)
      key = [row[1]!]
      pools.add(row[1]!)
    }
    else if (kind === 'package') {
      check.field(NAME.test(row[1]!) && ARCH.has(row[2]!) && VERSION.test(row[3]!) && SHA256.test(row[4]!), text)
      key = [row[1]!, row[2]!]
    }
    else if (kind === 'item') {
      // lock 1.2.7: a pool layer of a type the format does not know, keyed by type, name and architecture.
      check.field(NAME.test(row[1]!) && row[1] !== ARCHIVE_TYPE && NAME.test(row[2]!) && ARCH.has(row[3]!)
        && VERSION.test(row[4]!) && SHA256.test(row[5]!), text)
      key = [row[1]!, row[2]!, row[3]!]
    }
    else if (kind === 'board') {
      check.field(NAME.test(row[1]!) && COMPONENT.has(row[2]!) && ARCH.has(row[3]!), text)
      reference(row[4]!)
      key = [row[1]!, row[2]!]
    }
    else if (kind === 'upstream') {
      const roots = row[6]!.split(',')
      const canonical = [...new Set(roots)].sort()
      check.field(NAME.test(row[1]!) && ARCH.has(row[2]!) && VERSION.test(row[3]!) && SHA256.test(row[4]!)
        && row[5]!.startsWith('https://') && roots.every(r => NAME.test(r))
        && roots.length === canonical.length && roots.every((r, i) => r === canonical[i]), text)
      key = [row[1]!, row[2]!]
    }
    else if (kind === 'apt') {
      // 1.2.5: one row per Debian source, keyed by the source.
      check.field(row[1]!.startsWith('https://') && row[2] && row[3] && row[4]!.startsWith('/'), text)
      key = [row[1]!, row[2]!]
    }
    else if (kind === 'input') {
      const [name, inputScope] = partition(row[1]!, '.')
      check.field(REPOSITORY.test(name) && (inputScope === '' || SCOPE.test(inputScope))
        && (RELEASE.test(row[2]!) || row[2] === 'offline') && SHA256.test(row[3]!), text)
      if ((inputScope !== '') !== SCOPED.has(name)) check.refuse('release-scope', text)
      key = [row[1]!]
    }
    else if (kind === 'product') {
      check.field(SCOPE.test(row[1]!) && BOARD.test(row[2]!) && PROFILE.has(row[3]!) && GENERATION.test(row[4]!)
        && row.slice(5, 8).every(v => SHA256.test(v)), text)
      key = [row[1]!]
    }
    else if (kind === 'bundle') {
      check.field(SCOPE.test(row[1]!) && BUNDLE.has(row[2]!), text)
      reference(row[3]!)
      key = [row[1]!, row[2]!]
    }
    else if (kind === 'asset') {
      check.field(SCOPE.test(row[1]!) && BUNDLE.has(row[2]!) && SHA256.test(row[5]!)
        && (row[2] === 'image' ? NAME.test(row[3]!) : Object.hasOwn(UPDATE_SUFFIX, row[3]!)), text)
      check.field(assetFile(row, release), text)
      key = [row[1]!, row[2]!, row[3]!]
    }
    else if (kind === 'data') {
      // 1.2.4: the file is a second key beside the name.
      check.field(NAME.test(row[1]!) && NAME.test(row[2]!) && SHA256.test(row[3]!), text)
      if (rows.some(r => r[0] === 'data' && r[2] === row[2] && r !== row)) check.refuse('data-file', text)
      key = [row[1]!]
    }
    else {
      check.refuse('release-row', text)
      throw new Stop(text)
    }
    const full = JSON.stringify([kind, ...key])
    if (keys.has(full)) check.refuse('duplicate-key', text)
    keys.add(full)
    sortKeys.push([KIND_ORDER.indexOf(kind), ...key])
  }
  if (repository !== 'mica-system-base' && rows.some(r => BASE_ONLY.has(r[0]!))) check.refuse('base-only-kind', path)
  // 1.2.5: the sources are one snapshot of one release and its pockets.
  const apt = rows.filter(r => r[0] === 'apt')
  if (apt.length > 0) {
    const stamps = new Set(apt.map(r => APT_SNAPSHOT.exec(r[1]!)?.[1] ?? null))
    if (stamps.size !== 1 || stamps.has(null)) check.refuse('apt-snapshot', path)
    const suites = new Set(apt.map(r => r[2]!))
    if (new Set([...suites].map(s => partition(s, '-')[0])).size !== 1 || ![...suites].some(s => !s.includes('-')))
      check.refuse('apt-suite', path)
  }
  if (repository !== 'mica-build' && rows.some(r => BUILD_ONLY.has(r[0]!))) check.refuse('build-only-kind', path)
  const products = new Set(rows.filter(r => r[0] === 'product').map(r => r[1]!))
  const bundles = new Set(rows.filter(r => r[0] === 'bundle').map(r => `${r[1]}\t${r[2]}`))
  if (rows.some(r => (r[0] === 'bundle' || r[0] === 'asset') && !products.has(r[1]!))) check.refuse('bundle-without-product', path)
  if (rows.some(r => r[0] === 'asset' && !bundles.has(`${r[1]}\t${r[2]}`))) check.refuse('asset-without-bundle', path)
  if (rows.some(r => r[0] === 'bundle' && r[2] === 'update'
    && !rows.some(a => a[0] === 'asset' && a[1] === r[1] && a[2] === 'update' && a[3] === 'full')))
    check.refuse('update-full', path)
  if (rows.some(r => r[0] === 'package' && !pools.has(r[2]!))) check.refuse('package-without-pool', path)
  if (rows.some(r => r[0] === 'item' && !pools.has(r[3]!))) check.refuse('item-without-pool', path)
  // A board's components: the kernel is required, uboot and firmware are the board's to have.
  for (const board of new Set(rows.filter(r => r[0] === 'board').map(r => r[1]!)))
    if (!rows.some(r => r[0] === 'board' && r[1] === board && r[2] === 'kernel')) check.refuse('board-components', board)
  if (!isSorted(sortKeys)) check.refuse('sort-order', path)
  return { rows, repository, scope, release, commit }
}
