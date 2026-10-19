// Stand-ins for ghcr.io and GitHub in one server: the parts of the Distribution API and the releases API the
// publishers use, with ghcr's token challenge (anonymous pull, basic-authenticated push), and the release asset
// downloads at /download/<repository>/<tag>/<name>.
import { createHash } from 'node:crypto'

type Asset = { id: number, name: string, url: string, bytes: Uint8Array }
export type StubRelease = { id: number, tag_name: string, draft: boolean, prerelease: boolean, body: string | null, assets: Asset[] }

export class Stub {
  readonly blobs = new Map<string, Uint8Array>()
  readonly manifests = new Map<string, Uint8Array>()
  readonly tags = new Map<string, string>()
  readonly releases = new Map<string, StubRelease[]>()
  /** `<repository>:<tag>` -> the object a tag names; a sha of `502` answers with that status. */
  readonly tagRefs = new Map<string, { type: string, sha: string }>()
  private uploads = new Map<string, string>()
  private next = 1
  readonly server = Bun.serve({ port: 0, fetch: request => this.handle(request) })

  get url(): string {
    return `http://localhost:${this.server.port}`
  }

  /** The environment that points every client at this stub. */
  env(repository: string): Record<string, string> {
    return {
      MICA_OCI_REGISTRY: this.url, MICA_GITHUB_API: this.url, MICA_GITHUB_UPLOADS: this.url,
      MICA_RELEASES_URL: `${this.url}/download/{repository}/{release}/`, MICA_SOURCE_REPO: repository, GITHUB_TOKEN: 'secret', MICA_REGISTRY_USER: 'mica',
    }
  }

  release(repository: string, tag: string): StubRelease {
    const release: StubRelease = { id: this.next++, tag_name: tag, draft: false, prerelease: false, body: 'Notes.', assets: [] }
    this.releases.set(repository, [...(this.releases.get(repository) ?? []), release])
    return release
  }

  stop(): void {
    this.server.stop(true)
  }

  private digest(bytes: Uint8Array): string {
    return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
  }

  private async handle(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const path = url.pathname
    const auth = request.headers.get('authorization') ?? ''
    if (path === '/token') {
      const push = (url.searchParams.get('scope') ?? '').endsWith(':pull,push')
      if (push && auth !== `Basic ${Buffer.from('mica:secret').toString('base64')}`) return new Response('', { status: 401 })
      return Response.json({ token: push ? 'push' : 'pull' })
    }
    if (path.startsWith('/v2/')) return this.registry(request, path, auth)
    const download = /^\/download\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(path)
    if (download) {
      const asset = this.releases.get(download[1]!)?.find(r => r.tag_name === download[2])?.assets.find(a => a.name === download[3])
      return asset ? new Response(asset.bytes) : new Response('', { status: 404 })
    }
    return this.github(request, url)
  }

  private async registry(request: Request, path: string, auth: string): Promise<Response> {
    if (path === '/v2/') return new Response('', { status: 401, headers: { 'www-authenticate': `Bearer realm="${this.url}/token",service="ghcr.io"` } })
    const write = request.method !== 'GET' && request.method !== 'HEAD'
    if (auth !== 'Bearer push' && (write || auth !== 'Bearer pull')) return new Response('', { status: 401 })
    const m = /^\/v2\/(.+?)\/(blobs|manifests)\/(.+)$/.exec(path)
    const upload = /^\/v2\/(.+?)\/blobs\/uploads\/(.*)$/.exec(path)
    if (upload && request.method === 'POST') {
      const id = String(this.next++)
      this.uploads.set(id, upload[1]!)
      return new Response('', { status: 202, headers: { location: `/v2/${upload[1]}/blobs/uploads/${id}` } })
    }
    if (upload && request.method === 'PUT') {
      const bytes = new Uint8Array(await request.arrayBuffer())
      const digest = new URL(request.url).searchParams.get('digest')
      if (this.digest(bytes) !== digest) return new Response('digest', { status: 400 })
      this.blobs.set(digest!, bytes)
      return new Response('', { status: 201 })
    }
    if (m === null) return new Response('', { status: 404 })
    const [, name, kind, ref] = m as unknown as [string, string, string, string]
    if (kind === 'blobs') {
      const blob = this.blobs.get(ref)
      if (blob === undefined) return new Response('', { status: 404 })
      return new Response(request.method === 'HEAD' ? null : blob)
    }
    if (request.method === 'PUT') {
      const bytes = new Uint8Array(await request.arrayBuffer())
      this.manifests.set(this.digest(bytes), bytes)
      this.tags.set(`${name}:${ref}`, this.digest(bytes))
      return new Response('', { status: 201 })
    }
    const digest = ref.startsWith('sha256:') ? ref : this.tags.get(`${name}:${ref}`)
    const bytes = digest === undefined ? undefined : this.manifests.get(digest)
    return bytes === undefined ? new Response('', { status: 404 }) : new Response(bytes)
  }

  private async github(request: Request, url: URL): Promise<Response> {
    const path = url.pathname
    const ref = /^\/repos\/micaoss\/([^/]+)\/git\/ref\/tags\/(.+)$/.exec(path)
    if (ref) {
      const object = this.tagRefs.get(`${ref[1]}:${ref[2]}`)
      if (object === undefined) return new Response('{"message":"Not Found"}', { status: 404 })
      if (object.sha === '502') return new Response('bad gateway', { status: 502 })
      return Response.json({ ref: `refs/tags/${ref[2]}`, object })
    }
    const list = /^\/repos\/micaoss\/([^/]+)\/releases$/.exec(path)
    if (list) return Response.json((this.releases.get(list[1]!) ?? []).map(r => this.shape(r)))
    const byTag = /^\/repos\/micaoss\/([^/]+)\/releases\/tags\/(.+)$/.exec(path)
    if (byTag) {
      const release = this.releases.get(byTag[1]!)?.find(r => r.tag_name === byTag[2])
      return release ? Response.json(this.shape(release)) : new Response('', { status: 404 })
    }
    const one = /^\/repos\/micaoss\/([^/]+)\/releases\/(\d+)$/.exec(path)
    if (one && request.method === 'PATCH') {
      const release = this.releases.get(one[1]!)?.find(r => r.id === Number(one[2]))
      if (!release) return new Response('', { status: 404 })
      release.body = (await request.json() as { body: string }).body
      return Response.json(this.shape(release))
    }
    const assets = /^\/repos\/micaoss\/([^/]+)\/releases\/(\d+)\/assets$/.exec(path)
    if (assets && request.method === 'POST') {
      const release = this.releases.get(assets[1]!)?.find(r => r.id === Number(assets[2]))
      const name = url.searchParams.get('name') ?? ''
      if (!release || release.assets.some(a => a.name === name)) return new Response('', { status: 422 })
      const id = this.next++
      release.assets.push({ id, name, url: `${this.url}/download/${assets[1]}/${release.tag_name}/${name}`, bytes: new Uint8Array(await request.arrayBuffer()) })
      return new Response('{}', { status: 201 })
    }
    return new Response('', { status: 404 })
  }

  private shape(release: StubRelease): unknown {
    return { ...release, assets: release.assets.map(a => ({ id: a.id, name: a.name, url: a.url })) }
  }
}
