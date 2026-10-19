// `locks update` (design 3.1): every input pinned in locks/ moves to its latest release, and
// locks/mica-build-tools.pin to the commit of this tool's latest release with bin/mica-tools rewritten from that
// commit's bootstrap; an input given a release takes that one. Everything is downloaded and verified before
// anything is written, and what it writes is pins: a build still reads only what a pin names. With `check`
// nothing under locks/ or bin/ is written: the lines say what would move, and the caller fails when any would.
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ToolError } from '../errors.ts'
import { tagCommit } from '../release/check.ts'
import { latestRelease } from '../release/latest.ts'
import { ensure, mirrorOf } from '../repos/cache.ts'
import { readPin, readToolsPin, TOOLS_PIN, TOOLS_PIN_HEADER } from './pins.ts'
import { resolveMove, writeMove, type Move } from './releases.ts'
import { COMMIT, RELEASE } from './rules.ts'

const TOOLS = 'mica-build-tools'

type ToolsMove = { commit: string, release: string, bootstrap: Uint8Array }

/** This tool at a release or a commit (its latest release when none is named), with the bootstrap of that commit. */
async function resolveTools(root: string, named: string | undefined, env: NodeJS.ProcessEnv): Promise<ToolsMove> {
  const byCommit = named !== undefined && COMMIT.test(named)
  if (named !== undefined && !byCommit && !RELEASE.test(named)) throw new ToolError(`'${named}' is not <YYYYMMDD-HHMM> or a commit of 40 hex`)
  const release = byCommit ? '' : named ?? await latestRelease(TOOLS, { scope: '' })
  if (release === undefined) throw new ToolError(`${TOOLS} has no published release`)
  const commit = byCommit ? named : await tagCommit(TOOLS, release)
  const url = env.MICA_TOOLS_URL ?? `https://github.com/micaoss/${TOOLS}.git`
  const repos = join(root, 'repos')
  if (ensure(repos, url, commit) !== 'commit') throw new ToolError(`${commit} is no commit of ${TOOLS}`)
  const shown = Bun.spawnSync(['git', '--git-dir', mirrorOf(repos, url), 'show', `${commit}:bootstrap/mica-tools`], { stdout: 'pipe', stderr: 'pipe' })
  if (shown.exitCode !== 0) throw new ToolError(`${TOOLS} ${commit} carries no bootstrap/mica-tools`)
  return { commit, release, bootstrap: new Uint8Array(shown.stdout) }
}

/** What `locks update` found: one line per input, in the order of their names, this tool last, and how many move. */
export type Update = { lines: string[], inputs: number, moved: number }

/** `locks update`, and with `check` what it would do, writing nothing under locks/ or bin/. */
export async function updateLocks(root: string, named: Map<string, string>, check = false, env: NodeJS.ProcessEnv = process.env): Promise<Update> {
  const locks = join(root, 'locks')
  if (!existsSync(locks)) throw new ToolError(`${locks} does not exist`)
  const pinsDir = join(locks, 'pins')
  const inputs = existsSync(pinsDir) ? readdirSync(pinsDir).filter(f => f.endsWith('.pin')).map(f => f.slice(0, -4)).sort() : []
  const tools = existsSync(join(locks, TOOLS_PIN))
  for (const name of named.keys())
    if (!(inputs.includes(name) || (tools && name === TOOLS))) throw new ToolError(`${name} is no input of locks/`)
  for (const [name, release] of named)
    if (name !== TOOLS && !RELEASE.test(release)) throw new ToolError(`'${release}' is not <YYYYMMDD-HHMM>`)

  // Everything is resolved and verified first.
  const lines: string[] = []
  const moves: Move[] = []
  for (const input of inputs) {
    const pin = readPin(join(pinsDir, `${input}.pin`))
    if (pin.RELEASE === 'offline') { lines.push(`${input} offline, left as it is`); continue }
    const move = await resolveMove(locks, input, named.get(input))
    const lock = join(locks, `${input}.lock`)
    const same = pin.RELEASE === move.release && pin.SHA256SUMS === move.sums
      && existsSync(lock) && Buffer.compare(readFileSync(lock), Buffer.from(move.lock)) === 0
    if (same) { lines.push(`${input} ${move.release} unchanged`); continue }
    moves.push(move)
    lines.push(`${input} ${pin.RELEASE} -> ${move.release}`)
  }
  let toolsMove: ToolsMove | undefined
  if (tools) {
    const pinned = readToolsPin(join(locks, TOOLS_PIN))
    const move = await resolveTools(root, named.get(TOOLS), env)
    const copy = join(root, 'bin/mica-tools')
    const same = pinned === move.commit && existsSync(copy) && Buffer.compare(readFileSync(copy), Buffer.from(move.bootstrap)) === 0
    if (same) {
      lines.push(`${TOOLS} ${pinned} unchanged`)
    }
    else {
      toolsMove = move
      lines.push(`${TOOLS} ${pinned} -> ${move.commit}${move.release ? ` (${move.release})` : ''}`)
    }
  }

  const update = { lines, inputs: lines.length, moved: moves.length + (toolsMove === undefined ? 0 : 1) }
  if (check) return update
  for (const move of moves) writeMove(locks, move)
  if (toolsMove !== undefined) {
    mkdirSync(join(root, 'bin'), { recursive: true })
    writeFileSync(join(root, 'bin/mica-tools'), toolsMove.bootstrap)
    chmodSync(join(root, 'bin/mica-tools'), 0o755)
    writeFileSync(join(locks, TOOLS_PIN), `${TOOLS_PIN_HEADER}\nREPOSITORY=${TOOLS}\nCOMMIT=${toolsMove.commit}\n`)
  }
  return update
}
