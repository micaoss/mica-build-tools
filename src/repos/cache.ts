// The source cache, `repos/` (docs/spec/release-lock.md section 5): content-addressed archives under
// repos/sha256/<hex> and bare mirrors under repos/git/<name>.git. Only a pinned sha256, commit or tree enters a
// build; a cached file that does not hash to its name is refused, never silently fetched again; under
// MICA_OFFLINE=1 a miss is refused as `offline-miss` and nothing is fetched. A download tries the mirror MICA_MIRROR
// names first, when its form applies to the URL, and falls back to the row's own URL on any mirror failure: the
// sha256 is checked whichever source served the bytes, so a mirror can only make a download faster.
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { Writable } from 'node:stream'
import { basename, dirname, join, resolve } from 'node:path'
import { Refused, ToolError } from '../errors.ts'
import { checkPins, modeOf } from '../locks/pins.ts'
import { COMMIT, SHA256 } from '../locks/rules.ts'
import { checkUpstream } from '../locks/upstream.ts'
import { git } from '../process.ts'

export function offline(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MICA_OFFLINE === '1'
}

export function sha256Of(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

/** The cached archive of a sha256, verified; a miss is `offline-miss` offline and `fetch-required` otherwise. */
export function lookup(repos: string, sha256: string, isOffline = offline()): string {
  if (!SHA256.test(sha256)) throw new ToolError(`'${sha256}' is not a sha256`)
  const path = join(repos, 'sha256', sha256)
  if (!existsSync(path)) throw new Refused(isOffline ? 'offline-miss' : 'fetch-required', `repos/sha256/${sha256}`)
  const got = sha256Of(readFileSync(path))
  if (got !== sha256) throw new Refused('cache-corrupt', `repos/sha256/${sha256} hashes to ${got}`)
  return path
}

/** Writes a response body to a file as it arrives, and returns its sha256: an archive is never held whole in memory. */
export async function streamToFile(response: Response, target: string): Promise<string> {
  mkdirSync(dirname(target), { recursive: true })
  const hash = createHash('sha256')
  const file = Bun.file(target).writer()
  try {
    await response.body!.pipeTo(Writable.toWeb(new Writable({
      write(chunk: Uint8Array, _encoding, done) { hash.update(chunk); file.write(chunk); done() },
    })))
  }
  finally {
    await file.end()
  }
  return hash.digest('hex')
}

/**
 * The mirror's URL for a row's URL, or undefined where the mirror's form does not apply. MICA_MIRROR is `<base>`
 * or `pool:<base>`, mapping `.../pool/<path>` to `<base>/pool/<path>`, or `snapshot:<base>`, replacing
 * `https://snapshot.debian.org/`; https only.
 */
export function mirrorUrl(spec: string, url: string): string | undefined {
  const m = /^(?:(pool|snapshot):)?(https:\/\/.+)$/.exec(spec)
  if (m === null) throw new ToolError(`MICA_MIRROR=${spec} is not <https base>, pool:<https base> or snapshot:<https base>`)
  const base = m[2]!.replace(/\/+$/, '')
  if (m[1] === 'snapshot') {
    const host = 'https://snapshot.debian.org/'
    return url.startsWith(host) ? `${base}/${url.slice(host.length)}` : undefined
  }
  const at = url.indexOf('/pool/')
  return at < 0 ? undefined : `${base}/pool/${url.slice(at + '/pool/'.length)}`
}

/** The per-download ceiling, MICA_FETCH_DEADLINE in seconds (default 600). */
function deadline(env: NodeJS.ProcessEnv = process.env): number {
  const value = env.MICA_FETCH_DEADLINE ?? '600'
  if (!/^[1-9][0-9]*$/.test(value)) throw new ToolError(`MICA_FETCH_DEADLINE=${value} is not a whole number of seconds`)
  return Number(value) * 1000
}

async function fetchTo(url: string, sha256: string, target: string, deadlineMs: number): Promise<void> {
  const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(deadlineMs) })
    .catch((e: unknown) => { throw new ToolError(`${url}: ${e instanceof Error && e.name === 'TimeoutError' ? `stalled past ${deadlineMs / 1000} s` : e instanceof Error ? e.message : String(e)}`) })
  if (!response.ok) { await response.arrayBuffer().catch(() => undefined); throw new ToolError(`${url}: HTTP ${response.status}`) }
  const partial = mkdtempSync(join(dirname(target), '.partial-'))
  try {
    const got = await streamToFile(response, join(partial, sha256)).catch((e: unknown) => {
      throw new ToolError(`${url}: ${e instanceof Error && e.name === 'TimeoutError' ? `stalled past ${deadlineMs / 1000} s` : e instanceof Error ? e.message : String(e)}`)
    })
    if (got !== sha256) throw new ToolError(`${url} downloads with sha256 ${got}, not the pinned ${sha256}`)
    renameSync(join(partial, sha256), target)
  }
  finally {
    rmSync(partial, { recursive: true, force: true })
  }
}

/**
 * Downloads from the first source that serves the pinned bytes within the ceiling; the last source is the row's own
 * URL, whose failure is the error. Returns the source that served.
 */
export async function downloadFrom(sources: string[], sha256: string, target: string, deadlineMs: number): Promise<string> {
  mkdirSync(dirname(target), { recursive: true })
  for (const [i, url] of sources.entries()) {
    try {
      await fetchTo(url, sha256, target, deadlineMs)
      return url
    }
    catch (e) {
      if (i === sources.length - 1 || !(e instanceof ToolError)) throw e
    }
  }
  throw new ToolError('no source to download from')
}

/**
 * `repos get`: the archive from the cache or downloaded, verified and stored, then copied to `out`. Returns
 * `cached`, or the URL that served it.
 */
export async function get(repos: string, sha256: string, url: string, out: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  let path: string, source = 'cached'
  try {
    path = lookup(repos, sha256, offline(env))
  }
  catch (e) {
    if (!(e instanceof Refused) || e.rule !== 'fetch-required') throw e
    if (!url.startsWith('https://')) throw new ToolError(`${url} is not https`)
    const mirror = env.MICA_MIRROR === undefined ? undefined : mirrorUrl(env.MICA_MIRROR, url)
    const ceiling = deadline(env)
    path = join(repos, 'sha256', sha256)
    source = await downloadFrom(mirror === undefined ? [url] : [mirror, url], sha256, path, ceiling)
  }
  mkdirSync(dirname(out) || '.', { recursive: true })
  copyFileSync(path, out)
  return source
}

/** The mirror of a git URL: repos/git/<name>.git, the name being the URL's last path element without `.git`. */
export function mirrorOf(repos: string, url: string): string {
  const name = basename(url.replace(/\/+$/, '')).replace(/\.git$/, '')
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) throw new ToolError(`${url} names no repository`)
  return join(repos, 'git', `${name}.git`)
}

function objectType(mirror: string, object: string): string {
  const r = git(['--git-dir', mirror, 'cat-file', '-t', object])
  return r.ok ? r.out.trim() : ''
}

/** Makes the mirror hold the object, fetching only when it does not; returns `commit` or `tree`. */
export function ensure(repos: string, url: string, object: string, isOffline = offline()): string {
  if (!COMMIT.test(object)) throw new ToolError(`'${object}' is not a 40-hex commit or tree`)
  const mirror = mirrorOf(repos, url)
  if (!existsSync(mirror)) {
    if (isOffline) throw new Refused('offline-miss', `${object} of ${url}: no mirror ${mirror}`)
    mkdirSync(dirname(mirror), { recursive: true })
    if (!git(['init', '--quiet', '--bare', mirror]).ok) throw new ToolError(`git init --bare ${mirror} failed`)
  }
  let type = objectType(mirror, object)
  if (type === '') {
    if (isOffline) throw new Refused('offline-miss', `${object} of ${url} is not in ${mirror}`)
    // A commit is fetched by its id; a tree has no ref of its own, so a miss after that fetches every ref.
    git(['--git-dir', mirror, 'fetch', '--quiet', url, object], { quiet: true })
    type = objectType(mirror, object)
    if (type === '') {
      const all = git(['--git-dir', mirror, 'fetch', '--quiet', url, '+refs/heads/*:refs/heads/*', '+refs/tags/*:refs/tags/*'])
      if (!all.ok) throw new ToolError(`fetching ${url} into ${mirror} failed: ${all.err.trim()}`)
      type = objectType(mirror, object)
    }
  }
  if (type !== 'commit' && type !== 'tree') throw new ToolError(`${url} holds no commit or tree ${object}`)
  // An object fetched by its id has no ref, and git gc prunes what no ref reaches; the pin keeps one.
  const pinned = git(['--git-dir', mirror, 'update-ref', `refs/pins/${object}`, object])
  if (!pinned.ok) throw new ToolError(`recording the pin ${object} in ${mirror} failed: ${pinned.err.trim()}`)
  return type
}

/** The id of the tree a directory holds, computed through a scratch index. */
function treeOf(mirror: string, dir: string): string {
  const scratch = mkdtempSync(join(dirname(mirror), '.index-'))
  try {
    // The blobs `git add` writes go to a scratch object store that reads through to the mirror's, so a check
    // leaves nothing in the mirror, whatever the directory holds.
    mkdirSync(join(scratch, 'objects'))
    const env = { GIT_INDEX_FILE: join(scratch, 'index'), GIT_OBJECT_DIRECTORY: join(scratch, 'objects'), GIT_ALTERNATE_OBJECT_DIRECTORIES: resolve(mirror, 'objects') }
    const add = git(['--git-dir', mirror, '--work-tree', dir, 'add', '--all', '--force', '.'], { env })
    if (!add.ok) throw new ToolError(`hashing ${dir} failed: ${add.err.trim()}`)
    return git(['--git-dir', mirror, 'write-tree'], { env }).out.trim()
  }
  finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

/**
 * `repos git`: the pinned commit or tree out of its mirror into `dir`, fetched into the mirror first when missing,
 * and verified. A commit is a checkout whose HEAD is the commit; a tree is its files, whose tree id is verified.
 * A directory that already holds exactly the pin is left as it is.
 */
export function checkoutPinned(repos: string, url: string, object: string, dir: string): void {
  const type = ensure(repos, url, object)
  const mirror = mirrorOf(repos, url)
  if (type === 'commit') {
    if (existsSync(join(dir, '.git')) && git(['-C', dir, 'rev-parse', 'HEAD']).out.trim() === object
      && git(['-C', dir, 'status', '--porcelain']).out === '') return
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dirname(dir), { recursive: true })
    // A checkout reading its objects from the mirror; a clone of a mirror whose only refs are pins is "empty".
    const init = git(['-c', 'init.defaultBranch=main', 'init', '--quiet', dir])
    if (!init.ok) throw new ToolError(`git init ${dir} failed: ${init.err.trim()}`)
    writeFileSync(join(dir, '.git/objects/info/alternates'), `${resolve(mirror, 'objects')}\n`)
    const co = git(['-C', dir, 'checkout', '--quiet', '--detach', object])
    if (!co.ok) throw new ToolError(`checking ${object} out in ${dir} failed: ${co.err.trim()}`)
    const head = git(['-C', dir, 'rev-parse', 'HEAD']).out.trim()
    if (head !== object) throw new ToolError(`${dir} is at ${head} after checking out ${object}`)
    return
  }
  if (existsSync(dir) && treeOf(mirror, dir) === object) return
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const archive = Bun.spawnSync(['git', '--git-dir', mirror, 'archive', '--format=tar', object], { stdout: 'pipe', stderr: 'pipe' })
  if (archive.exitCode !== 0) throw new ToolError(`git archive ${object} failed: ${archive.stderr.toString().trim()}`)
  const tar = Bun.spawnSync(['tar', '-x', '-C', dir], { stdin: archive.stdout })
  if (tar.exitCode !== 0) throw new ToolError(`extracting ${object} into ${dir} failed`)
  const got = treeOf(mirror, dir)
  if (got !== object) throw new ToolError(`${dir} holds tree ${got}, not ${object}`)
}

/**
 * `repos check`: every `source` and `git` row of locks/upstream.lock, and every `upstream` row of the producer
 * locks in locks/, is in repos/ and hashes right. Returns one line per row checked.
 */
export function check(root: string): string[] {
  const repos = join(root, 'repos'), locks = join(root, 'locks')
  const lines: string[] = []
  const upstream = join(locks, 'upstream.lock')
  const rows = existsSync(upstream) ? checkUpstream(upstream) : []
  for (const row of rows) {
    if (row[0] === 'source') {
      lookup(repos, row[4]!)
      lines.push(`source ${row[1]} ${row[2]} ${row[4]}`)
    }
    else if (row[0] === 'git') {
      const mirror = mirrorOf(repos, row[2]!)
      if (!existsSync(mirror) || objectType(mirror, row[4]!) === '')
        throw new Refused(offline() ? 'offline-miss' : 'fetch-required', `git ${row[1]} ${row[4]} is not in ${mirror}`)
      const fsck = git(['--git-dir', mirror, 'fsck', '--no-dangling', '--connectivity-only', row[4]!])
      if (!fsck.ok) throw new Refused('cache-corrupt', `git ${row[1]} ${row[4]} in ${mirror}: ${fsck.err.trim()}`)
      lines.push(`git ${row[1]} ${row[4]}`)
    }
  }
  if (existsSync(locks)) {
    for (const input of checkPins(locks, modeOf())) {
      for (const row of input.lock.rows.filter(r => r[0] === 'upstream')) {
        lookup(repos, row[4]!)
        lines.push(`upstream ${input.name} ${row[1]} ${row[2]} ${row[4]}`)
      }
    }
  }
  return lines
}
