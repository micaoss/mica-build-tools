// Reading OCI artifacts by digest (design 3.4; docs/spec/build-rules.md section 5): anonymously from a registry
// through the token its challenge names, or from an offline build's layout (`local/<repository>`, release-lock.md
// section 6), which resolves inside the CHECKOUT of that repository's offline pin and is refused under CI. The tag
// of a reference is informational; the bytes must hash to the digest, and nothing falls back.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Refused, ToolError } from '../errors.ts'
import { checkPins, modeOf, type Mode } from '../locks/pins.ts'
import { partition } from '../locks/rules.ts'
import { streamToFile } from '../repos/cache.ts'

export const OCI_MANIFEST = 'application/vnd.oci.image.manifest.v1+json'
export const OCI_INDEX = 'application/vnd.oci.image.index.v1+json'

const REMOTE = /^(?<host>[a-z0-9.-]+(?::[0-9]+)?)\/(?<name>[a-z0-9._/-]+?)(?::[A-Za-z0-9._-]+)?@sha256:(?<digest>[0-9a-f]{64})$/
const LOCAL = /^local\/(?<name>[a-z0-9][a-z0-9-]*)(?::[A-Za-z0-9._-]+)?@sha256:(?<digest>[0-9a-f]{64})$/

function sha256(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

/** Where a registry host is reached; MICA_OCI_REGISTRY replaces https://<host> (tests). */
export function base(host: string): string {
  return process.env.MICA_OCI_REGISTRY ?? `https://${host}`
}

/**
 * A bearer for `name` with `actions` (`pull` or `pull,push`) from the realm the registry's challenge names: with the
 * basic credentials given, or anonymously. '' when the registry does not challenge.
 */
export async function bearer(host: string, name: string, actions: string, basic?: { user: string, token: string }): Promise<string> {
  const probe = await fetch(`${base(host)}/v2/`, { signal: AbortSignal.timeout(60000) }).catch(() => undefined)
  if (probe === undefined) throw new ToolError(`${host} could not be reached`)
  await probe.arrayBuffer().catch(() => undefined)
  const challenge = probe.headers.get('www-authenticate') ?? ''
  if (!/^bearer/i.test(challenge)) return ''
  const realm = /realm="([^"]*)"/.exec(challenge)?.[1]
  if (!realm) throw new ToolError(`${host} challenged with no realm`)
  const url = new URL(realm)
  const service = /service="([^"]*)"/.exec(challenge)?.[1]
  if (service) url.searchParams.set('service', service)
  url.searchParams.set('scope', `repository:${name}:${actions}`)
  const headers: Record<string, string> = basic ? { Authorization: `Basic ${Buffer.from(`${basic.user}:${basic.token}`).toString('base64')}` } : {}
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(60000) }).catch(() => undefined)
  if (response === undefined) throw new ToolError(`the token endpoint of ${host} could not be reached`)
  if (response.status !== 200) {
    const why = basic === undefined && (response.status === 401 || response.status === 403)
      ? `; anonymously, a package that is private or does not exist answers this way -- every Mica package is public, set once in its package settings (https://github.com/orgs/micaoss/packages/container/${name.replace(/^micaoss\//, '')}/settings)`
      : ''
    throw new ToolError(`the token endpoint of ${host} answered ${response.status} for ${name} ${actions}${why}`)
  }
  const body = await response.json().catch(() => ({})) as { token?: string, access_token?: string }
  const token = body.token || body.access_token || ''
  if (token === '') throw new ToolError(`${host} issued no ${actions} token for ${name}`)
  return token
}

/** GET one path of a repository through the anonymous pull token, retried on transport failures and 5xx. */
async function remoteFetch(host: string, name: string, path: string, accept: string): Promise<Response> {
  const token = await bearer(host, name, 'pull')
  const headers: Record<string, string> = { Accept: accept }
  if (token) headers.Authorization = `Bearer ${token}`
  for (let attempt = 0; ; attempt++) {
    let response: Response
    try {
      response = await fetch(`${base(host)}/v2/${name}/${path}`, { headers, redirect: 'follow', signal: AbortSignal.timeout(3600000) })
    }
    catch (e) {
      if (attempt < 3) { await Bun.sleep(1000 * (attempt + 1)); continue }
      throw new ToolError(`${host}/${name} ${path}: ${e instanceof Error ? e.message : String(e)}`)
    }
    if (response.status >= 500 && attempt < 3) { await response.arrayBuffer().catch(() => undefined); await Bun.sleep(1000 * (attempt + 1)); continue }
    if (response.status !== 200) throw new ToolError(`reading ${host}/${name} ${path} answered ${response.status}`)
    return response
  }
}

async function remoteGet(host: string, name: string, path: string, accept: string): Promise<Uint8Array> {
  return new Uint8Array(await (await remoteFetch(host, name, path, accept)).arrayBuffer())
}

function splitRepository(repository: string): [string, string] {
  const [host, name] = partition(repository, '/')
  if (!/^[a-z0-9.-]+(:[0-9]+)?$/.test(host) || !/^[a-z0-9._/-]+$/.test(name)) throw new ToolError(`'${repository}' is not <registry>/<name> or local/<repository>`)
  return [host, name]
}

/** The blob of an offline layout: the CHECKOUT of the repository's offline pin in locks/. */
function localGet(locks: string, repository: string, digest: string, mode: Mode): Uint8Array {
  if (mode === 'ci') throw new Refused('checkout-in-ci', `local/${repository} is an offline build; CI reads published releases only`)
  const checkouts = [...new Set(checkPins(locks, mode).filter(i => partition(i.name, '.')[0] === repository).map(i => i.pin.CHECKOUT ?? ''))]
  if (checkouts.length !== 1 || checkouts[0] === '') throw new ToolError(`locks/ names no one offline checkout of ${repository}, so local/${repository} names nothing`)
  const blob = join(checkouts[0]!, '_out/offline/oci/blobs/sha256', digest)
  if (!existsSync(blob)) throw new ToolError(`${checkouts[0]}/_out/offline/oci holds no blob ${digest}`)
  return new Uint8Array(readFileSync(blob))
}

function verified(bytes: Uint8Array, digest: string, what: string): Uint8Array {
  if (sha256(bytes) !== digest) throw new ToolError(`${what} was served with other bytes than sha256:${digest}`)
  return bytes
}

/** The manifest (or index) a digest reference names. */
export async function manifest(reference: string, locks: string, mode: Mode = modeOf()): Promise<Uint8Array> {
  const local = LOCAL.exec(reference)?.groups
  if (local) return verified(localGet(locks, local.name!, local.digest!, mode), local.digest!, reference)
  const remote = REMOTE.exec(reference)?.groups
  if (!remote) throw new ToolError(`'${reference}' is not <registry>/<name>[:<tag>]@sha256:<hex> or local/<repository>[:<tag>]@sha256:<hex>`)
  const bytes = await remoteGet(remote.host!, remote.name!, `manifests/sha256:${remote.digest}`, `${OCI_MANIFEST}, ${OCI_INDEX}`)
  return verified(bytes, remote.digest!, reference)
}

/** One blob of a repository (`<registry>/<name>` or `local/<repository>`). */
export async function blob(repository: string, digest: string, locks: string, mode: Mode = modeOf()): Promise<Uint8Array> {
  if (!/^[0-9a-f]{64}$/.test(digest)) throw new ToolError(`'${digest}' is not a sha256`)
  if (repository.startsWith('local/')) return verified(localGet(locks, repository.slice('local/'.length), digest, mode), digest, repository)
  const [host, name] = splitRepository(repository)
  return verified(await remoteGet(host, name, `blobs/sha256:${digest}`, 'application/octet-stream'), digest, `${repository} blob`)
}

/** One blob into a file, streamed as it arrives and hashed on the way; a wrong hash leaves no file. */
export async function blobToFile(repository: string, digest: string, out: string, locks: string, mode: Mode = modeOf()): Promise<void> {
  if (!/^[0-9a-f]{64}$/.test(digest)) throw new ToolError(`'${digest}' is not a sha256`)
  if (repository.startsWith('local/')) {
    mkdirSync(dirname(out), { recursive: true })
    writeFileSync(out, verified(localGet(locks, repository.slice('local/'.length), digest, mode), digest, repository))
    return
  }
  const [host, name] = splitRepository(repository)
  const response = await remoteFetch(host, name, `blobs/sha256:${digest}`, 'application/octet-stream')
  const partial = `${out}.partial`
  const got = await streamToFile(response, partial)
  if (got !== digest) { rmSync(partial, { force: true }); throw new ToolError(`${repository} blob was served with other bytes than sha256:${digest}`) }
  renameSync(partial, out)
}
