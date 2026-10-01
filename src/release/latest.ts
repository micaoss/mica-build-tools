// `release latest` (design 3.4): the latest published release of this repository, by the time its tag carries,
// optionally before a tag and optionally only among releases carrying an asset. A release tag is `<YYYYMMDD-HHMM>`
// or `<scope>.<YYYYMMDD-HHMM>`; the separator is matched as `[./]`, so a `<scope>/<YYYYMMDD-HHMM>` tag is found too
// (release-lock.md 1.3).
import { ToolError } from '../errors.ts'
import { git } from '../process.ts'

const TAG = /^(?:([a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)?)[./])?([0-9]{8}-[0-9]{4})$/

/** The scope of a release tag ('' for an unscoped one), or undefined for what is no release tag. */
export function scopeOf(tag: string): string | undefined {
  const m = TAG.exec(tag)
  return m === null ? undefined : (m[1] ?? '')
}

type Release = { tag_name: string, draft: boolean, prerelease: boolean, assets: { name: string }[] }

/** This repository's name: MICA_SOURCE_REPO, else the last element of origin's URL. */
export function repositoryName(root: string): string {
  let name = process.env.MICA_SOURCE_REPO ?? ''
  if (name === '') {
    const url = git(['-C', root, 'remote', 'get-url', 'origin']).out.trim()
    name = url.replace(/\/+$/, '').replace(/^.*[/:]/, '').replace(/\.git$/, '')
    if (name === '') throw new ToolError(`${root} has no origin remote to name the repository by; set MICA_SOURCE_REPO`)
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new ToolError(`'${name}' is not a repository name`)
  return name
}

/** Every published release, through the GitHub API (MICA_GITHUB_API replaces its base, for tests). */
async function listReleases(repository: string): Promise<Release[]> {
  const api = process.env.MICA_GITHUB_API ?? 'https://api.github.com'
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || ''
  // A token only raises the listing's rate limit; nothing read here needs one.
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json' }
  if (token !== '' && api === 'https://api.github.com') headers.Authorization = `Bearer ${token}`
  const releases: Release[] = []
  for (let page = 1; ; page++) {
    const url = `${api}/repos/micaoss/${repository}/releases?per_page=100&page=${page}`
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(120000) }).catch(() => undefined)
    if (response === undefined) throw new ToolError(`${url} could not be reached`)
    if (response.status !== 200) throw new ToolError(`${url}: HTTP ${response.status}`)
    const batch = await response.json() as Release[]
    releases.push(...batch)
    if (batch.length < 100) return releases
  }
}

function stamp(tag: string): string | undefined {
  return TAG.exec(tag)?.[2]
}

/** The latest release; `scope` restricts the answer to releases of that scope ('' for unscoped ones). */
export async function latestRelease(repository: string, options: { before?: string, asset?: string, scope?: string } = {}): Promise<string | undefined> {
  let limit: string | undefined
  if (options.before !== undefined) {
    limit = stamp(options.before)
    if (limit === undefined) throw new ToolError(`'${options.before}' is not a release tag`)
  }
  const candidates = (await listReleases(repository))
    .filter(r => !r.draft && !r.prerelease && stamp(r.tag_name) !== undefined)
    .filter(r => options.scope === undefined || scopeOf(r.tag_name) === options.scope)
    .filter(r => limit === undefined || stamp(r.tag_name)! < limit)
    .filter(r => options.asset === undefined || r.assets.some(a => a.name === options.asset))
    .sort((a, b) => (stamp(b.tag_name)! < stamp(a.tag_name)! ? -1 : stamp(b.tag_name)! > stamp(a.tag_name)! ? 1 : 0))
  return candidates[0]?.tag_name
}
