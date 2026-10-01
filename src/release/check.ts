// `release check` (design 3.4; docs/spec/build-rules.md section 1): the preconditions every release of every
// repository meets before anything is read from a registry or written anywhere, refused by name, and the commit
// the tag names. `release pool` and `release attach` run it first.
//
// The tag is `<YYYYMMDD-HHMM>` -- `<scope>.<YYYYMMDD-HHMM>` for a repository with scoped releases (lock 1.0) --
// naming a real UTC minute not later than now; `refs/tags/<tag>` on GitHub is a commit and it is HEAD; HEAD is on
// origin/main; the tree is clean.
import { ToolError } from '../errors.ts'
import { RELEASE, SCOPE, SCOPED, rpartition } from '../locks/rules.ts'
import { git } from '../process.ts'
import { OWNER } from './pool.ts'

/** The stamp as a UTC time, when its digits are one. */
export function stampTime(stamp: string): Date | undefined {
  if (!RELEASE.test(stamp)) return undefined
  const [y, mo, d, h, mi] = [stamp.slice(0, 4), stamp.slice(4, 6), stamp.slice(6, 8), stamp.slice(9, 11), stamp.slice(11, 13)].map(Number)
  const time = new Date(Date.UTC(y!, mo! - 1, d!, h!, mi!))
  const back = `${time.getUTCFullYear()}${String(time.getUTCMonth() + 1).padStart(2, '0')}${String(time.getUTCDate()).padStart(2, '0')}-${String(time.getUTCHours()).padStart(2, '0')}${String(time.getUTCMinutes()).padStart(2, '0')}`
  return back === stamp ? time : undefined
}

/** The scope and stamp of a tag as this repository releases them, or a refusal naming what is wrong. */
export function releaseTag(repository: string, tag: string, now = new Date()): { scope: string, stamp: string } {
  const scoped = SCOPED.has(repository)
  // The stamp is what follows the last dot; a scope may hold one itself.
  const [scope, stamp] = rpartition(tag, '.')
  if (!RELEASE.test(stamp) || (scope !== '' && !SCOPE.test(scope)))
    throw new ToolError(`'${tag}' is not a release tag ${scoped ? '<scope>.' : ''}<YYYYMMDD-HHMM>`)
  if (scoped && scope === '') throw new ToolError(`'${tag}' is not a scoped release tag <scope>.<YYYYMMDD-HHMM>; ${repository} releases by scope (lock 1.0)`)
  if (!scoped && scope !== '') throw new ToolError(`'${tag}' names a scope, and ${repository} has no scoped releases (lock 1.0)`)
  const time = stampTime(stamp)
  if (time === undefined) throw new ToolError(`the tag '${tag}' is not a UTC time YYYYMMDD-HHMM`)
  if (time.getTime() > now.getTime()) throw new ToolError(`the tag ${tag} is a time in the future`)
  return { scope, stamp }
}

/** GitHub's record of a tag: the object it names. `hint` ends the message of a tag that does not exist. */
async function tagObject(repository: string, tag: string, hint = ''): Promise<{ type: string, sha: string }> {
  const api = process.env.MICA_GITHUB_API ?? 'https://api.github.com'
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || ''
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json' }
  if (token !== '') headers.Authorization = `Bearer ${token}`
  const url = `${api}/repos/${OWNER}/${repository}/git/ref/tags/${tag}`
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(120000) })
    .catch((e: unknown) => { throw new ToolError(`could not read ${tag} in ${repository}: ${e instanceof Error ? e.message : String(e)}`) })
  if (response.status === 404) throw new ToolError(`${tag} does not exist in ${repository}${hint}`)
  if (response.status !== 200) throw new ToolError(`could not read ${tag} in ${repository} (HTTP ${response.status})`)
  const body = await response.json() as { object?: { type?: string, sha?: string } }
  return { type: body.object?.type ?? '', sha: body.object?.sha ?? '' }
}

/** The commit a release tag names on GitHub; a tag object is refused, since a release tag is the commit's own. */
export async function tagCommit(repository: string, tag: string, hint = ''): Promise<string> {
  const object = await tagObject(repository, tag, hint)
  if (object.type !== 'commit') throw new ToolError(`${tag} names an annotated tag, not a commit; a release tag is created by gh release create on the commit itself`)
  return object.sha
}

/** Every precondition, in the order a release script checks them; returns the commit the tag names. */
export async function releaseCheck(root: string, repository: string, tag: string, now = new Date()): Promise<string> {
  releaseTag(repository, tag, now)
  const head = git(['-C', root, 'rev-parse', 'HEAD'])
  if (!head.ok) throw new ToolError(`${root} has no commit to release`)
  const commit = head.out.trim()
  const object = { sha: await tagCommit(repository, tag, `; cut the release with gh release create ${tag} --target ${commit}`) }
  if (object.sha !== commit) throw new ToolError(`${tag} names ${object.sha}, not the checked-out commit ${commit}`)
  if (!git(['-C', root, 'rev-parse', '--verify', '--quiet', 'origin/main']).ok) throw new ToolError(`${root} has no origin/main; fetch it first, since a release is cut from a commit of main`)
  if (!git(['-C', root, 'merge-base', '--is-ancestor', commit, 'origin/main']).ok) throw new ToolError(`${commit} is not on origin/main; a release is cut from a commit of main`)
  if (git(['-C', root, 'status', '--porcelain']).out !== '') throw new ToolError(`${root} has uncommitted changes; a release is published from a clean checkout of its commit`)
  return commit
}
