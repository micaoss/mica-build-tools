// `release pool` (design 3.4; lock section 2): each architecture's pool of a clean HEAD published as
// `pool.<arch>.<tag>` in ghcr.io/micaoss/<repository>, one application/vnd.mica.deb layer per archive and one
// application/vnd.mica.item.<type> layer per item (lock 1.2.7), each titled with its file name and annotated with its
// producer's inputs hash, the manifest carrying only mica.source-repo and mica.arch so an unchanged pool keeps its
// digest. Everything is read back anonymously; the lock rows are printed.
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ToolError } from '../errors.ts'
import { controlFields, controlText } from '../deb/archive.ts'
import { RELEASE } from '../locks/rules.ts'
import { blob as readBlob, manifest as readManifest, OCI_MANIFEST } from '../oci/client.ts'
import { EMPTY_CONFIG, EMPTY_CONFIG_DIGEST, Pusher } from '../oci/push.ts'
import { fileKind, ITEM_LAYER, poolItems } from '../pool/items.ts'
import { inputsHash, producerOf } from '../pool/inputs.ts'
import { releaseCheck } from './check.ts'

export const POOL_ARTIFACT = 'application/vnd.mica.pool'
export const DEB_LAYER = 'application/vnd.mica.deb'
export const REGISTRY = 'ghcr.io'
export const OWNER = 'micaoss'

export type PoolLayer = { title: string, digest: string, size: number, inputs: string, mediaType?: string }

/** A pool manifest's bytes: JSON indented by two spaces with a final LF, layers sorted by title (design 3.4). */
export function poolManifest(repository: string, arch: string, layers: PoolLayer[]): Uint8Array {
  const sorted = [...layers].sort((a, b) => Buffer.compare(Buffer.from(a.title), Buffer.from(b.title)))
  const manifest = {
    schemaVersion: 2,
    mediaType: OCI_MANIFEST,
    artifactType: POOL_ARTIFACT,
    config: { mediaType: 'application/vnd.oci.empty.v1+json', digest: EMPTY_CONFIG_DIGEST, size: 2 },
    layers: sorted.map(l => ({ mediaType: l.mediaType ?? DEB_LAYER, digest: l.digest, size: l.size, annotations: { 'org.opencontainers.image.title': l.title, 'mica.inputs': l.inputs } })),
    annotations: { 'mica.source-repo': repository, 'mica.arch': arch },
  }
  return new TextEncoder().encode(JSON.stringify(manifest, null, 2) + '\n')
}

type Archive = { file: string, bytes: Uint8Array, name: string, version: string, arch: string, sha256: string, inputs: string }

/** The archives of one pool, each of this repository and with its producer's inputs hash. */
export function poolArchives(root: string, repository: string, arch: string): Archive[] {
  const pool = join(root, '_out/debs', arch, 'pool')
  const files = existsSync(pool) ? readdirSync(pool).filter(f => fileKind(f) === 'archive').sort() : []
  return files.map((file) => {
    const path = join(pool, file)
    const fields = controlFields(controlText(path))
    if (fields['Mica-Source-Repo'] !== repository) throw new ToolError(`${arch}/pool/${file} is of ${fields['Mica-Source-Repo'] ?? 'no repository'}; a pool publishes this repository's archives only`)
    const name = fields.Package ?? '', version = fields.Version ?? '', target = fields.Architecture ?? ''
    if (file !== `${name}_${version}_${target}.deb`) throw new ToolError(`${arch}/pool/${file} is not named ${name}_${version}_${target}.deb`)
    const bytes = new Uint8Array(readFileSync(path))
    const inputs = inputsHash(root, producerOf(root, name), target === 'all' ? 'all' : arch)
    return { file, bytes, name, version, arch: target, sha256: createHash('sha256').update(bytes).digest('hex'), inputs }
  })
}

export async function publishPools(root: string, repository: string, tag: string, arches: string[]): Promise<string[]> {
  if (!RELEASE.test(tag)) throw new ToolError(`'${tag}' is not a release tag <YYYYMMDD-HHMM>; a scoped repository publishes its pools through the library`)
  await releaseCheck(root, repository, tag)
  const name = `${OWNER}/${repository}`
  const pusher = new Pusher(REGISTRY, name)
  const pools: string[] = [], packages: string[][] = [], items: string[][] = []
  for (const arch of arches) {
    const archives = poolArchives(root, repository, arch)
    await pusher.blob(EMPTY_CONFIG)
    const held = poolItems(join(root, '_out/debs', arch, 'pool'), arch)
    if (archives.length === 0 && held.length === 0) throw new ToolError(`${arch}/pool holds no archive and no item`)
    const layers: PoolLayer[] = []
    for (const a of archives) {
      await pusher.blob(a.bytes)
      layers.push({ title: a.file, digest: `sha256:${a.sha256}`, size: a.bytes.length, inputs: a.inputs })
      packages.push(['package', a.name, arch, a.version, a.sha256])
    }
    for (const i of held) {
      await pusher.blob(i.bytes)
      layers.push({ title: i.file, digest: `sha256:${i.sha256}`, size: i.bytes.length, inputs: inputsHash(root, producerOf(root, i.name), arch), mediaType: ITEM_LAYER + i.type })
      items.push(['item', i.type, i.name, arch, i.version, i.sha256])
    }
    const bytes = poolManifest(repository, arch, layers)
    const { digest } = await pusher.manifest(`pool.${arch}.${tag}`, bytes)
    const reference = `${REGISTRY}/${name}:pool.${arch}.${tag}@${digest}`
    // Read back with no credential: the manifest at its digest, and every layer.
    await readManifest(reference, join(root, 'locks'), 'ci')
    for (const layer of layers) await readBlob(`${REGISTRY}/${name}`, layer.digest.slice('sha256:'.length), join(root, 'locks'), 'ci')
    pools.push(['pool', arch, reference].join('\t'))
  }
  // A row's key is every column before its version.
  const key = (r: string[]) => Buffer.from(r.slice(1, -2).join('\t'))
  const byKey = (a: string[], b: string[]) => Buffer.compare(key(a), key(b))
  return [...pools.sort(), ...[packages, items].flatMap(rows => rows.sort(byKey).map(r => r.join('\t')))]
}
