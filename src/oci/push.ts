// Writing OCI artifacts (design 3.4; lock section 2): blobs uploaded unless present, a manifest put under a tag that
// is empty or already holds exactly it -- a tag is never re-pointed. The credential is a token with write:packages
// (MICA_REGISTRY_TOKEN, else GITHUB_TOKEN or GH_TOKEN), never printed; publishing is CI's.
import { createHash } from 'node:crypto'
import { ToolError } from '../errors.ts'
import { base, bearer, OCI_MANIFEST } from './client.ts'

export const EMPTY_CONFIG = new TextEncoder().encode('{}')
export const EMPTY_CONFIG_DIGEST = `sha256:${createHash('sha256').update(EMPTY_CONFIG).digest('hex')}`

export function digestOf(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

export class Pusher {
  private token = ''

  constructor(readonly host: string, readonly name: string) {}

  private async authorization(): Promise<Record<string, string>> {
    if (this.token === '') {
      const secret = process.env.MICA_REGISTRY_TOKEN || process.env.GITHUB_TOKEN || process.env.GH_TOKEN || ''
      if (secret === '') throw new ToolError('publishing needs a token with write:packages in MICA_REGISTRY_TOKEN, GITHUB_TOKEN or GH_TOKEN')
      const user = process.env.MICA_REGISTRY_USER || process.env.GITHUB_ACTOR || 'mica'
      this.token = await bearer(this.host, this.name, 'pull,push', { user, token: secret })
      if (this.token === '') this.token = '-'
    }
    return this.token === '-' ? {} : { Authorization: `Bearer ${this.token}` }
  }

  private async request(method: string, url: string, headers: Record<string, string> = {}, body?: Uint8Array): Promise<Response> {
    const target = url.startsWith('http') ? url : `${base(this.host)}/v2/${this.name}/${url}`
    const response = await fetch(target, { method, headers: { ...(await this.authorization()), ...headers }, body, redirect: 'follow', signal: AbortSignal.timeout(1800000) })
      .catch((e: unknown) => { throw new ToolError(`${method} ${target}: ${e instanceof Error ? e.message : String(e)}`) })
    return response
  }

  async blob(bytes: Uint8Array): Promise<string> {
    const digest = digestOf(bytes)
    const head = await this.request('HEAD', `blobs/${digest}`)
    if (head.status === 200) return digest
    const start = await this.request('POST', 'blobs/uploads/', { 'Content-Length': '0' })
    if (start.status !== 202) throw new ToolError(`starting an upload to ${this.host}/${this.name} answered ${start.status}`)
    let location = start.headers.get('location') ?? ''
    if (location === '') throw new ToolError(`the upload to ${this.host}/${this.name} came with no Location`)
    if (location.startsWith('/')) location = `${base(this.host)}${location}`
    location += `${location.includes('?') ? '&' : '?'}digest=${digest}`
    const put = await this.request('PUT', location, { 'Content-Type': 'application/octet-stream' }, bytes)
    if (put.status !== 201) throw new ToolError(`uploading ${digest} to ${this.host}/${this.name} answered ${put.status}`)
    return digest
  }

  /** Puts a manifest under a tag: `pushed` or `present`; a tag holding another digest is refused. */
  async manifest(tag: string, bytes: Uint8Array, mediaType = OCI_MANIFEST): Promise<{ digest: string, state: 'pushed' | 'present' }> {
    const digest = digestOf(bytes)
    const existing = await this.request('GET', `manifests/${tag}`, { Accept: mediaType })
    if (existing.status === 200) {
      const have = digestOf(new Uint8Array(await existing.arrayBuffer()))
      if (have !== digest) throw new ToolError(`${this.host}/${this.name}:${tag} already holds ${have}, not ${digest}; a published tag is never re-pointed`)
      return { digest, state: 'present' }
    }
    if (existing.status !== 404) throw new ToolError(`reading ${this.host}/${this.name}:${tag} answered ${existing.status}`)
    const put = await this.request('PUT', `manifests/${tag}`, { 'Content-Type': mediaType }, bytes)
    if (put.status !== 201) throw new ToolError(`putting ${this.host}/${this.name}:${tag} answered ${put.status}`)
    return { digest, state: 'pushed' }
  }
}
