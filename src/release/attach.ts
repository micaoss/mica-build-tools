// `release attach` (design 3.4; docs/spec/build-rules.md section 1; lock section 1): the files a lock's `data` rows
// name (lock 1.2.4), then the lock, then a SHA256SUMS listing only the lock, attached to this repository's published
// GitHub release of that tag, each read back anonymously. The order is load-bearing: the lock goes after its
// referents, so whoever can see the lock, an interrupted upload included, can already fetch what it names. An
// asset is never replaced (one already there must be the same bytes), no time-tagged release may be later, and the
// notes gain the comparison of the lock's rows with those of the previous release carrying the lock.
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { Refused, ToolError } from '../errors.ts'
import { checkLock, KIND_COLUMNS } from '../locks/lock.ts'
import { assetBase } from '../locks/releases.ts'
import { OWNER } from './pool.ts'
import { latestRelease, scopeOf } from './latest.ts'
import { releaseCheck } from './check.ts'

type Asset = { id: number, name: string, url: string }
type Release = { id: number, tag_name: string, draft: boolean, body: string | null, assets: Asset[] }

const STAMP = /(?:^|[./])([0-9]{8}-[0-9]{4})$/
/** The line that marks the notes as written, so a second run does not append them again. */
const MARKER = '<!-- mica-tools release attach -->'
const LABELS: Record<string, string> = {
  image: 'Images', pool: 'Pools', package: 'Packages', item: 'Pool items', board: 'Boards', upstream: 'Upstream packages', apt: 'Debian sources',
  input: 'Inputs', product: 'Products', bundle: 'Bundles', asset: 'Assets', data: 'Data',
}
const KINDS: [string, string][] = Object.keys(KIND_COLUMNS).filter(k => k !== 'release').map(k => [k, LABELS[k]!])

/** A row as compared: a reference by its digest alone, since its tag names the release (lock 1.3). */
function comparable(row: string): string {
  return row.split('\t').map(v => v.replace(/:[A-Za-z0-9._-]+@sha256:/, '@sha256:')).join('\t')
}

/**
 * The notes paragraph comparing a lock's rows with the previous release's: one line per kind either lock carries,
 * `unchanged` or `changed`, then the rows that differ.
 */
export function rowComparison(previous: string | undefined, before: string, after: string, lockName = 'the lock'): string {
  const rows = (text: string) => text.split('\n').filter(l => l !== '' && !l.startsWith('#') && !l.startsWith('release\t'))
  const old = rows(before), now = rows(after)
  const present = KINDS.filter(([kind]) => [...old, ...now].some(r => r.startsWith(`${kind}\t`)))
  if (previous === undefined) return present.map(([, label]) => `${label}: the first release carrying ${lockName}.`).join('\n')
  const oldKeys = new Set(old.map(comparable)), nowKeys = new Set(now.map(comparable))
  const removed = old.filter(r => !nowKeys.has(comparable(r))), added = now.filter(r => !oldKeys.has(comparable(r)))
  const lines = present.map(([kind, label]) => {
    const changed = [...removed, ...added].some(r => r.startsWith(`${kind}\t`))
    return `${label}: ${changed ? 'changed' : 'unchanged'} from ${previous}.`
  })
  if (removed.length === 0 && added.length === 0) return lines.join('\n')
  const diff = [...removed.map(r => `- ${r.replaceAll('\t', ' ')}`), ...added.map(r => `+ ${r.replaceAll('\t', ' ')}`)]
  return `${lines.join('\n')}\n\n\`\`\`diff\n${diff.join('\n')}\n\`\`\``
}

function api(): string {
  return process.env.MICA_GITHUB_API ?? 'https://api.github.com'
}

function token(): string {
  const value = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || ''
  if (value === '') throw new ToolError('attaching assets needs a token in GITHUB_TOKEN or GH_TOKEN')
  return value
}

async function call(method: string, url: string, body?: Uint8Array | string, type = 'application/json'): Promise<Response> {
  const response = await fetch(url, {
    method,
    body,
    headers: { Authorization: `Bearer ${token()}`, Accept: 'application/vnd.github+json', ...(body === undefined ? {} : { 'Content-Type': type }) },
    signal: AbortSignal.timeout(600000),
  }).catch((e: unknown) => { throw new ToolError(`${method} ${url}: ${e instanceof Error ? e.message : String(e)}`) })
  return response
}

async function download(url: string): Promise<Uint8Array> {
  const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(120000) })
  if (!response.ok) throw new ToolError(`${url}: HTTP ${response.status}`)
  return new Uint8Array(await response.arrayBuffer())
}

/** The file of every `data` row, matched by name and by sha256 against the files given; refused before any write. */
function dataAssets(lockRows: string[][], lockPath: string, files: string[]): [string, Uint8Array][] {
  const given = new Map<string, Uint8Array>()
  for (const path of files) {
    const file = basename(path)
    if (given.has(file)) throw new ToolError(`--data ${file} is given twice`)
    if (!existsSync(path)) throw new ToolError(`--data ${path}: ${file} does not exist`)
    given.set(file, new Uint8Array(readFileSync(path)))
  }
  const rows = lockRows.filter(r => r[0] === 'data')
  for (const file of given.keys()) if (!rows.some(r => r[2] === file)) throw new ToolError(`--data ${file} is no data row of the lock ${lockPath}`)
  return rows.map((row) => {
    const bytes = given.get(row[2]!)
    if (bytes === undefined) throw new ToolError(`${row[2]} is named by a data row and no --data file`)
    const got = createHash('sha256').update(bytes).digest('hex')
    if (got !== row[3]) throw new ToolError(`--data ${row[2]} hashes to ${got}, and its data row says ${row[3]}`)
    return [row[2]!, bytes]
  })
}

/** A release asset as a consumer reads it, anonymously; a 404 right after an upload is GitHub still propagating. */
async function readBack(url: string): Promise<Uint8Array> {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(120000) })
    if (response.ok) return new Uint8Array(await response.arrayBuffer())
    await response.arrayBuffer().catch(() => undefined)
    if (response.status !== 404 || attempt >= 6) throw new ToolError(`${url}: HTTP ${response.status}`)
    await Bun.sleep(10000)
  }
}

/**
 * Attaches the data files a lock names, the lock and SHA256SUMS; `notes`, when given, is written into the notes
 * before the row comparison.
 */
export async function attach(root: string, repository: string, tag: string, lockPath: string, notes = '', dataFiles: string[] = []): Promise<string[]> {
  // A scoped repository's releases live side by side, and this command orders and compares one line of releases.
  if (scopeOf(tag) !== '') throw new Refused('release-scope', `'${tag}' is a scoped release; release attach serves unscoped releases only, and a scoped one publishes through the library`)
  const commit = await releaseCheck(root, repository, tag)
  const lock = checkLock(lockPath)
  if (lock.commit !== commit) throw new ToolError(`${lockPath} names the commit ${lock.commit}, and ${tag} is ${commit}`)
  const lockTag = lock.scope ? `${lock.scope}.${lock.release}` : lock.release
  if (lock.repository !== repository) throw new ToolError(`${lockPath} is a lock of ${lock.repository}, not ${repository}`)
  if (lockTag !== tag) throw new ToolError(`${lockPath} names the release ${lockTag}, not ${tag}`)
  const stamp = STAMP.exec(tag)?.[1]
  if (stamp === undefined) throw new ToolError(`'${tag}' is not a release tag`)
  const data = dataAssets(lock.rows, lockPath, dataFiles)
  const lockBytes = new Uint8Array(readFileSync(lockPath))
  const name = `${repository}.lock`
  const sums = new TextEncoder().encode(`${createHash('sha256').update(lockBytes).digest('hex')}  ${name}\n`)
  const repo = `${api()}/repos/${OWNER}/${repository}`

  const got = await call('GET', `${repo}/releases/tags/${tag}`)
  if (got.status !== 200) throw new ToolError(`${repository} has no published release ${tag} (HTTP ${got.status})`)
  const release = await got.json() as Release
  if (release.draft) throw new ToolError(`the release ${tag} of ${repository} is a draft`)
  const listed = await call('GET', `${repo}/releases?per_page=100`)
  if (listed.status !== 200) throw new ToolError(`listing the releases of ${repository} answered ${listed.status}`)
  const later = (await listed.json() as Release[]).filter(r => !r.draft && scopeOf(r.tag_name) === '' && (STAMP.exec(r.tag_name)?.[1] ?? '') > stamp).map(r => r.tag_name)
  if (later.length > 0) throw new ToolError(`${repository} has releases later than ${tag} (${later.join(', ')}); no asset is attached to an earlier one`)

  const expected: [string, Uint8Array][] = [...data, [name, lockBytes], ['SHA256SUMS', sums]]
  const stray = release.assets.map(a => a.name).filter(a => !expected.some(([e]) => e === a))
  if (stray.length > 0) throw new ToolError(`the release ${tag} carries ${stray.join(', ')}; a release carries ${expected.map(([e]) => e).join(', ')} and nothing else`)

  const lines: string[] = []
  const uploads = process.env.MICA_GITHUB_UPLOADS ?? 'https://uploads.github.com'
  for (const [asset, bytes] of expected) {
    const present = release.assets.find(a => a.name === asset)
    if (present !== undefined) {
      const held = await fetch(present.url, { headers: { Authorization: `Bearer ${token()}`, Accept: 'application/octet-stream' }, redirect: 'follow', signal: AbortSignal.timeout(120000) })
        .catch((e: unknown) => { throw new ToolError(`re-reading ${asset} of ${tag}: ${e instanceof Error ? e.message : String(e)}`) })
      if (held.status !== 200) throw new ToolError(`re-reading ${asset} of ${tag} answered HTTP ${held.status}, so whether it is the same file is unknown; nothing was replaced`)
      if (Buffer.compare(Buffer.from(await held.arrayBuffer()), Buffer.from(bytes)) !== 0)
        throw new ToolError(`the release ${tag} already carries ${asset} with other bytes; an asset is never replaced`)
      lines.push(`${asset}: present`)
      continue
    }
    const put = await call('POST', `${uploads}/repos/${OWNER}/${repository}/releases/${release.id}/assets?name=${encodeURIComponent(asset)}`, bytes, 'application/octet-stream')
    if (put.status !== 201) throw new ToolError(`uploading ${asset} to ${tag} answered ${put.status}`)
    // Read back as a consumer does, anonymously, before the next asset goes up.
    const served = await readBack(`${assetBase(repository, tag)}${asset}`)
    if (Buffer.compare(Buffer.from(served), Buffer.from(bytes)) !== 0) throw new ToolError(`${asset} of ${tag} does not download with the uploaded bytes`)
    lines.push(`${asset}: attached`)
  }

  if (!(release.body ?? '').includes(MARKER)) {
    const previous = await latestRelease(repository, { before: tag, asset: name, scope: '' })
    const before = previous === undefined ? '' : new TextDecoder().decode(await download(`${assetBase(repository, previous)}${name}`))
    const paragraph = [MARKER, ...(notes ? [notes] : []), rowComparison(previous, before, new TextDecoder().decode(lockBytes), name)].join('\n')
    const body = release.body ? `${release.body.replace(/\s+$/, '')}\n\n${paragraph}\n` : `${paragraph}\n`
    const patched = await call('PATCH', `${repo}/releases/${release.id}`, JSON.stringify({ body }))
    if (patched.status !== 200) throw new ToolError(`updating the notes of ${tag} answered ${patched.status}`)
    lines.push(...paragraph.split('\n').slice(1).filter(l => /^[A-Z][A-Za-z ]+: /.test(l)))
  }

  // The whole set as a consumer reads it: SHA256SUMS, the lock, every data file, anonymously.
  for (const [asset, bytes] of [...expected].reverse()) {
    const served = await readBack(`${assetBase(repository, tag)}${asset}`)
    if (Buffer.compare(Buffer.from(served), Buffer.from(bytes)) !== 0) throw new ToolError(`${asset} of ${tag} downloads with other bytes`)
  }
  lines.push(`read back anonymously: SHA256SUMS ${createHash('sha256').update(sums).digest('hex')}`)
  return lines
}
