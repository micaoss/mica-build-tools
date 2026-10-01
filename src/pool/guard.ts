// `pool guard` (design 3.3; the package-version decision R4, R5): one archive, or one pool item (lock 1.2.7), built
// here against the latest release of this repository that carries its lock, read anonymously. A higher version is
// new; a lower one is refused; the same version must carry the inputs hash the published layer records and be the
// published bytes, and is reused. A previous release whose pool layers record no mica.inputs compares nothing
// (package-versions D1).
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { Refused, ToolError } from '../errors.ts'
import { controlFields, controlText } from '../deb/archive.ts'
import { checkLock } from '../locks/lock.ts'
import { assetBase } from '../locks/releases.ts'
import { REFERENCE } from '../locks/rules.ts'
import { blob as readBlob, manifest as readManifest } from '../oci/client.ts'
import { latestRelease, scopeOf } from '../release/latest.ts'
import { fileKind, itemOf } from './items.ts'
import { inputsHash, producerOf } from './inputs.ts'

/** -1, 0 or 1: the Debian version order of deb-version(7). */
export function vercmp(a: string, b: string): number {
  const order = (c: string) => (/[0-9]/.test(c) ? 0 : /[A-Za-z]/.test(c) ? c.charCodeAt(0) : c === '~' ? -1 : c.charCodeAt(0) + 256)
  const part = (x: string, y: string): number => {
    while (x !== '' || y !== '') {
      let i = 0; while (i < x.length && !/[0-9]/.test(x[i]!)) i++
      let j = 0; while (j < y.length && !/[0-9]/.test(y[j]!)) j++
      const sa = x.slice(0, i), sb = y.slice(0, j)
      for (let k = 0; k < Math.max(sa.length, sb.length); k++) {
        const ca = k < sa.length ? order(sa[k]!) : 0, cb = k < sb.length ? order(sb[k]!) : 0
        if (ca !== cb) return ca > cb ? 1 : -1
      }
      x = x.slice(i); y = y.slice(j)
      i = 0; while (i < x.length && /[0-9]/.test(x[i]!)) i++
      j = 0; while (j < y.length && /[0-9]/.test(y[j]!)) j++
      const da = BigInt(x.slice(0, i) || '0'), db = BigInt(y.slice(0, j) || '0')
      if (da !== db) return da > db ? 1 : -1
      x = x.slice(i); y = y.slice(j)
    }
    return 0
  }
  const split = (v: string): [bigint, string, string] => {
    const colon = v.indexOf(':')
    const epoch = colon >= 0 ? v.slice(0, colon) : '0', rest = colon >= 0 ? v.slice(colon + 1) : v
    const dash = rest.lastIndexOf('-')
    return [BigInt(epoch || '0'), dash >= 0 ? rest.slice(0, dash) : rest, dash >= 0 ? rest.slice(dash + 1) : '0']
  }
  const [ea, ua, ra] = split(a), [eb, ub, rb] = split(b)
  if (ea !== eb) return ea > eb ? 1 : -1
  return part(ua, ub) || part(ra, rb)
}

type Layer = { digest: string, annotations?: Record<string, string> }

async function download(url: string): Promise<Uint8Array> {
  const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(120000) })
  if (!response.ok) throw new ToolError(`${url}: HTTP ${response.status}`)
  return new Uint8Array(await response.arrayBuffer())
}

export async function guard(root: string, repository: string, arch: string, archive: string, before?: string): Promise<string> {
  if (!['amd64', 'arm64'].includes(arch)) throw new ToolError(`'${arch}' is not amd64 or arm64`)
  // The guard knows no scope: it compares against the repository's unscoped releases, and a scoped tag is refused.
  if (before !== undefined && scopeOf(before) !== '') throw new Refused('release-scope', `'${before}' is not an unscoped release tag; pool guard compares unscoped releases only`)
  const bytes = readFileSync(archive)
  // An item (lock 1.2.7) is guarded by what its file name states; the row's key begins with its type.
  const kind = { archive: 'package', item: 'item' }[fileKind(basename(archive))]
  const identity = kind === 'item'
    ? { ...itemOf(basename(archive), arch), target: arch }
    : (() => {
        const fields = controlFields(controlText(archive))
        return { name: fields.Package ?? '', version: fields.Version ?? '', target: fields.Architecture ?? '' }
      })()
  const { name, version, target } = identity
  const key = [kind, ...('type' in identity ? [identity.type] : []), name, arch]
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const line = (state: string) => `${arch} ${name} ${version} ${state} ${sha256}`
  const previous = await latestRelease(repository, { asset: `${repository}.lock`, scope: '', ...(before ? { before } : {}) })
  if (previous === undefined) return line('new')
  const text = await download(`${assetBase(repository, previous)}${repository}.lock`)
  const scratch = join(root, '_out', `.guard-${process.pid}.lock`)
  await Bun.write(scratch, text)
  let rows: string[][]
  try {
    rows = checkLock(scratch).rows
  }
  finally {
    await Bun.file(scratch).delete().catch(() => undefined)
  }
  const pool = rows.find(r => r[0] === 'pool' && r[1] === arch)
  const row = rows.find(r => key.every((k, i) => r[i] === k))
  if (pool === undefined || row === undefined) return line('new')
  const reference = REFERENCE.exec(pool[2]!)?.groups
  if (reference === undefined) throw new ToolError(`the pool row of ${previous} is not a registry reference`)
  const manifest = JSON.parse(new TextDecoder().decode(await readManifest(pool[2]!, join(root, 'locks'), 'ci'))) as { layers?: Layer[] }
  const layers = manifest.layers ?? []
  if (!layers.some(l => /^[0-9a-f]{64}$/.test(l.annotations?.['mica.inputs'] ?? ''))) return line('new')
  const published = row.at(-2)!, digest = row.at(-1)!
  const order = vercmp(version, published)
  if (order > 0) return line('new')
  if (order < 0) throw new ToolError(`${name} is ${version} here, lower than ${published} in ${previous}; a version never goes back`)
  const layer = layers.find(l => l.digest === `sha256:${digest}`)
  if (layer === undefined) throw new ToolError(`${name} ${published} of ${previous} is no layer of its pool ${pool[2]}`)
  const title = layer.annotations?.['org.opencontainers.image.title'] ?? ''
  if (title !== basename(archive)) throw new ToolError(`the published layer of ${name} ${published} is titled ${title}, and this archive is ${basename(archive)}`)
  const here = inputsHash(root, producerOf(root, name), target === 'all' ? 'all' : arch)
  if (layer.annotations?.['mica.inputs'] !== here)
    throw new ToolError(`inputs of ${name} changed without a version bump: ${published} was published by ${previous} with inputs ${layer.annotations?.['mica.inputs']}, and they are ${here} here; bump its version`)
  const blob = await readBlob(`${reference.registry}/${reference.repository}`, digest, join(root, 'locks'), 'ci')
  if (Buffer.compare(Buffer.from(blob), bytes) !== 0)
    throw new ToolError(`${name} ${version} built here is not the published archive of ${previous} (sha256 ${sha256} here, ${digest} published) although its inputs are unchanged; its bytes moved, so bump its version`)
  return line('reused')
}
