// mica-tools <group> <command> [arguments] (design section 3).
//
// A command prints its result on stdout and exits 0; a broken rule prints `refused <rule>` on stdout, its detail on
// stderr, and exits 1; any other failure prints `error: <message>` on stderr and exits 1; a usage error exits 2.
// The repository a command works on is MICA_REPO_ROOT (set by bin/mica-tools), or the working directory.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { Refused, ToolError, UsageError } from './errors.ts'
import { collect } from './locks/collect.ts'
import { buildArgs, checkDockerfiles, resolve as resolveImage } from './locks/from.ts'
import { checkLock } from './locks/lock.ts'
import { checkLocks, modeOf, readToolsPin, TOOLS_PIN } from './locks/pins.ts'
import { localLock, moveLock, verifyLocks } from './locks/releases.ts'
import { updateLocks } from './locks/update.ts'
import { checkUpstream, gitField, sourceField } from './locks/upstream.ts'
import { check as reposCheck, checkoutPinned, get as reposGet } from './repos/cache.ts'
import { controlFields, controlText, payloadMember } from './deb/archive.ts'
import { version } from './deb/version.ts'
import { lint } from './lint/shell.ts'
import { blobToFile, manifest as ociManifest } from './oci/client.ts'
import { writeIndex } from './pool/index.ts'
import { latestRelease, repositoryName } from './release/latest.ts'
import { pack } from './deb/pack.ts'
import { gate } from './pool/gate.ts'
import { guard } from './pool/guard.ts'
import { inputsHash, manifest as inputsManifest, readDeclaration } from './pool/inputs.ts'
import { attach } from './release/attach.ts'
import { releaseCheck } from './release/check.ts'
import { publishPools } from './release/pool.ts'

export type Io = { out: (line: string) => void, err: (line: string) => void, write?: (bytes: Uint8Array) => Promise<unknown> }

async function write(io: Io, bytes: Uint8Array): Promise<void> {
  await (io.write ?? (b => Bun.write(Bun.stdout, b)))(bytes)
}

/** Exit 1 with nothing more to print. */
class Silent extends Error {}

type Command = { usage: string, run: (args: string[], io: Io) => Promise<void> | void }

function root(): string {
  return resolve(process.env.MICA_REPO_ROOT ?? process.cwd())
}

function locksDir(): string {
  return join(root(), 'locks')
}

function arity(args: string[], min: number, max = min): void {
  if (args.length < min || args.length > max) throw new UsageError()
}

const THIS_REPOSITORY = resolve(import.meta.dir, '..')

const COMMANDS: Record<string, Command> = {
  'lock check': {
    usage: 'lock check [--collect] <file>',
    run(args, io) {
      if (args[0] === '--collect') {
        arity(args, 2)
        const { outcome, rules } = collect(checkLock, args[1]!)
        if (outcome === 'valid') { io.out('valid'); return }
        io.out(`${outcome === 'set' ? 'refused' : 'stopped'} ${rules.join(' ')}`)
        throw new Silent()
      }
      arity(args, 1)
      checkLock(args[0]!)
      io.out('valid')
    },
  },
  'lock rows': {
    usage: 'lock rows <file> <kind>',
    run(args, io) {
      arity(args, 2)
      for (const row of checkLock(args[0]!).rows) if (row[0] === args[1]) io.out(row.join('\t'))
    },
  },
  'upstream check': {
    usage: 'upstream check [<file>]',
    run(args, io) {
      arity(args, 0, 1)
      checkUpstream(args[0] ?? join(locksDir(), 'upstream.lock'))
      io.out('valid')
    },
  },
  'upstream rows': {
    usage: 'upstream rows <image|source|git> [<file>]',
    run(args, io) {
      arity(args, 1, 2)
      if (!['image', 'source', 'git'].includes(args[0]!)) throw new UsageError()
      for (const row of checkUpstream(args[1] ?? join(locksDir(), 'upstream.lock'))) if (row[0] === args[0]) io.out(row.join('\t'))
    },
  },
  'upstream get': {
    usage: 'upstream get git <name> url|ref|commit | upstream get source <name> <amd64|arm64|all> version|sha256|url',
    run(args, io) {
      const file = join(locksDir(), 'upstream.lock')
      if (args[0] === 'git' && args.length === 3) { io.out(gitField(file, args[1]!, args[2]!)); return }
      if (args[0] === 'source' && args.length === 4) { io.out(sourceField(file, args[1]!, args[2]!, args[3]!)); return }
      throw new UsageError()
    },
  },
  'locks check': {
    usage: 'locks check [--ci]',
    run(args, io) {
      arity(args, 0, 1)
      if (args.length === 1 && args[0] !== '--ci') throw new UsageError()
      const inputs = checkLocks(locksDir(), args[0] === '--ci' ? 'ci' : modeOf())
      io.out(`valid: ${inputs.map(i => `${i.name} ${i.pin.RELEASE}`).join(', ') || 'no input'}`)
    },
  },
  'locks verify': {
    usage: 'locks verify',
    async run(args, io) {
      arity(args, 0)
      for (const line of await verifyLocks(locksDir())) io.out(line)
    },
  },
  'locks move': {
    usage: 'locks move <repository>[.<scope>] [<release>]',
    async run(args, io) {
      arity(args, 1, 2)
      io.out(await moveLock(locksDir(), args[0]!, args[1]))
    },
  },
  'locks update': {
    usage: 'locks update [--check] [<input>=<release>...]',
    async run(args, io) {
      const check = args[0] === '--check'
      const named = new Map<string, string>()
      for (const arg of args.slice(check ? 1 : 0)) {
        const m = /^([^=]+)=(.+)$/.exec(arg)
        if (m === null) throw new UsageError()
        if (named.has(m[1]!)) throw new ToolError(`${m[1]} is named twice`)
        named.set(m[1]!, m[2]!)
      }
      const { lines, inputs, moved } = await updateLocks(root(), named, check)
      for (const line of lines) io.out(line)
      if (check && moved > 0) throw new ToolError(`${moved} of ${inputs} inputs would move; mica-tools locks update${args.slice(1).map(a => ` ${a}`).join('')} moves them`)
    },
  },
  'local-lock': {
    usage: 'local-lock <repository>[.<scope>] <checkout>',
    run(args, io) {
      arity(args, 2)
      io.out(localLock(locksDir(), args[0]!, args[1]!))
    },
  },
  'from': {
    usage: 'from --ref <selector> | from <ARG>=<selector>... | from --check <dockerfile>...',
    run(args, io) {
      if (args[0] === '--check') {
        arity(args, 2, Infinity)
        checkDockerfiles(args.slice(1))
        return
      }
      const inputs = checkLocks(locksDir(), modeOf())
      if (args[0] === '--ref') {
        arity(args, 2)
        io.out(resolveImage(args[1]!, inputs, locksDir()))
        return
      }
      arity(args, 1, Infinity)
      for (const line of buildArgs(args, inputs, locksDir())) io.out(line)
    },
  },
  'pin check': {
    usage: 'pin check <file>',
    run(args, io) {
      arity(args, 1)
      readToolsPin(args[0]!)
      io.out('valid')
    },
  },
  'self-check': {
    usage: 'self-check',
    run(args, io) {
      arity(args, 0)
      const commit = readToolsPin(join(locksDir(), TOOLS_PIN))
      const head = Bun.spawnSync(['git', '-C', THIS_REPOSITORY, 'rev-parse', 'HEAD'], { stdout: 'pipe' }).stdout.toString().trim()
      if (head !== commit) throw new ToolError(`this checkout is at ${head || 'no commit'}, and locks/mica-build-tools.pin names ${commit}`)
      const copy = join(root(), 'bin/mica-tools')
      if (!existsSync(copy)) throw new Refused('bootstrap-drift', `${copy} does not exist`)
      if (Buffer.compare(readFileSync(copy), readFileSync(join(THIS_REPOSITORY, 'bootstrap/mica-tools'))) !== 0)
        throw new Refused('bootstrap-drift', `bin/mica-tools differs from bootstrap/mica-tools at ${commit}`)
      io.out(`bin/mica-tools is bootstrap/mica-tools at ${commit}`)
    },
  },
  'repos get': {
    usage: 'repos get <sha256> <url> <out>',
    async run(args, io) {
      arity(args, 3)
      const source = await reposGet(join(root(), 'repos'), args[0]!, args[1]!, args[2]!)
      io.out(source === 'cached' ? `cached ${args[0]}` : `${source === args[1] ? 'origin' : 'mirror'} ${source}`)
    },
  },
  'repos git': {
    usage: 'repos git <url> <commit|tree> <dir>',
    run(args) {
      arity(args, 3)
      checkoutPinned(join(root(), 'repos'), args[0]!, args[1]!, args[2]!)
    },
  },
  'repos check': {
    usage: 'repos check',
    run(args, io) {
      arity(args, 0)
      for (const line of reposCheck(root())) io.out(line)
    },
  },
  'version': {
    usage: 'version',
    run(args, io) {
      arity(args, 0)
      io.out(version(root()))
    },
  },
  'deb control': {
    usage: 'deb control <archive> [Field...]',
    run(args, io) {
      arity(args, 1, Infinity)
      const text = controlText(args[0]!)
      if (args.length === 1) { io.out(text.replace(/\n$/, '')); return }
      const fields = controlFields(text)
      for (const name of args.slice(1)) io.out(fields[name] ?? '')
    },
  },
  'deb member': {
    usage: 'deb member <archive> <path> [<out>]',
    async run(args, io) {
      arity(args, 2, 3)
      const entry = payloadMember(args[0]!, args[1]!)
      if (args.length === 2) { await write(io, entry.body); return }
      mkdirSync(dirname(args[2]!), { recursive: true })
      writeFileSync(args[2]!, entry.body)
      chmodSync(args[2]!, entry.mode & 0o777)
    },
  },
  'inputs': {
    usage: 'inputs <producer> <amd64|arm64|all> [--manifest]',
    run(args, io) {
      arity(args, 2, 3)
      if (args.length === 3 && args[2] !== '--manifest') throw new UsageError()
      const declaration = readDeclaration(root(), args[0]!)
      if (args.length === 3) { for (const line of inputsManifest(root(), declaration, args[1]!)) io.out(line); return }
      io.out(inputsHash(root(), declaration, args[1]!))
    },
  },
  'deb pack': {
    usage: 'deb pack --root <dir> --control <template> --arch <amd64|arm64|all> --out <dir> [--maintainer-scripts <dir>] [--substitute <name>=<value>...]',
    run(args, io) {
      const values = new Map<string, string>()
      const substitutions: Record<string, string> = {}
      for (let i = 0; i < args.length; i += 2) {
        const [option, value] = [args[i]!, args[i + 1]]
        if (value === undefined) throw new UsageError()
        if (option === '--substitute') {
          const at = value.indexOf('=')
          if (at < 1) throw new UsageError()
          substitutions[value.slice(0, at)] = value.slice(at + 1)
        }
        else if (['--root', '--control', '--arch', '--out', '--maintainer-scripts'].includes(option) && !values.has(option)) { values.set(option, value) }
        else { throw new UsageError() }
      }
      for (const required of ['--root', '--control', '--arch', '--out']) if (!values.has(required)) throw new UsageError()
      const deb = pack({
        root: values.get('--root')!, control: values.get('--control')!, arch: values.get('--arch')! as 'amd64' | 'arm64' | 'all',
        out: values.get('--out')!, repository: process.env.MICA_DEB_SOURCE_REPO ?? '', epoch: process.env.SOURCE_DATE_EPOCH ?? '',
        substitutions, ...(values.has('--maintainer-scripts') ? { scripts: values.get('--maintainer-scripts')! } : {}),
      })
      io.out(deb)
    },
  },
  'pool gate': {
    usage: 'pool gate --arch <amd64|arm64>...',
    run(args, io) {
      const arches: string[] = []
      for (let i = 0; i < args.length; i += 2) {
        if (args[i] !== '--arch' || args[i + 1] === undefined) throw new UsageError()
        arches.push(args[i + 1]!)
      }
      if (arches.length === 0) throw new UsageError()
      const { archives, problems } = gate(join(root(), '_out/debs'), arches)
      for (const problem of problems) io.err(`error: ${problem}`)
      if (problems.length > 0) throw new Silent()
      io.out(`pass: ${archives} archive(s) in ${arches.join(', ')}`)
    },
  },
  'pool guard': {
    usage: 'pool guard [--before <tag>] <amd64|arm64> <archive|item>',
    async run(args, io) {
      let before: string | undefined
      if (args[0] === '--before') { before = args[1]; args = args.slice(2) }
      arity(args, 2)
      if (before === undefined && args.length !== 2) throw new UsageError()
      io.out(await guard(root(), repositoryName(root()), args[0]!, args[1]!, before))
    },
  },
  'release pool': {
    usage: 'release pool <tag> [--arch <amd64|arm64>...]',
    async run(args, io) {
      arity(args, 1, 5)
      const arches: string[] = []
      for (let i = 1; i < args.length; i += 2) {
        if (args[i] !== '--arch' || !['amd64', 'arm64'].includes(args[i + 1] ?? '')) throw new UsageError()
        arches.push(args[i + 1]!)
      }
      const chosen = arches.length > 0 ? arches : ['amd64', 'arm64'].filter(a => existsSync(join(root(), '_out/debs', a, 'pool')))
      for (const line of await publishPools(root(), repositoryName(root()), args[0]!, chosen)) io.out(line)
    },
  },
  'release attach': {
    usage: 'release attach <tag> <lock> [--data <file>...] [--notes <text>]',
    async run(args, io) {
      arity(args, 2, Infinity)
      let notes = ''
      const data: string[] = []
      for (let i = 2; i < args.length; i += 2) {
        const value = args[i + 1]
        if (value === undefined) throw new UsageError()
        if (args[i] === '--data') data.push(value)
        else if (args[i] === '--notes' && notes === '') notes = value
        else throw new UsageError()
      }
      for (const line of await attach(root(), repositoryName(root()), args[0]!, args[1]!, notes, data)) io.out(line)
    },
  },
  'pool index': {
    usage: 'pool index --arch <amd64|arm64>',
    run(args, io) {
      arity(args, 2)
      if (args[0] !== '--arch' || !['amd64', 'arm64'].includes(args[1]!)) throw new UsageError()
      io.out(writeIndex(join(root(), '_out/debs', args[1]!), args[1]!))
    },
  },
  'oci manifest': {
    usage: 'oci manifest <reference>@sha256:<hex>',
    async run(args, io) {
      arity(args, 1)
      await write(io, await ociManifest(args[0]!, locksDir()))
    },
  },
  'oci blob': {
    usage: 'oci blob <name> <sha256> <out>',
    async run(args) {
      arity(args, 3)
      await blobToFile(args[0]!, args[1]!, args[2]!, locksDir())
    },
  },
  'release check': {
    usage: 'release check <tag>',
    async run(args, io) {
      arity(args, 1)
      io.out(await releaseCheck(root(), repositoryName(root()), args[0]!))
    },
  },
  'release latest': {
    usage: 'release latest [--repository <repository>] [--before <tag>] [--asset <name>]',
    async run(args, io) {
      const options: { before?: string, asset?: string } = {}
      let repository: string | undefined
      for (let i = 0; i < args.length; i += 2) {
        const value = args[i + 1]
        if (args[i] === '--before' && value !== undefined) options.before = value
        else if (args[i] === '--asset' && value !== undefined) options.asset = value
        else if (args[i] === '--repository' && value !== undefined) repository = value
        else throw new UsageError()
      }
      if (repository !== undefined && !/^[a-z0-9][a-z0-9-]*$/.test(repository)) throw new ToolError(`'${repository}' is not a repository name`)
      const tag = await latestRelease(repository ?? repositoryName(root()), options)
      if (tag === undefined) throw new ToolError('no published release matches')
      io.out(tag)
    },
  },
  'shell-lint': {
    usage: 'shell-lint [<pathspec>...]',
    run(args, io) {
      const { scanned, findings } = lint(root(), args)
      for (const finding of findings) io.err(`error: ${finding}`)
      if (findings.length > 0) throw new Silent()
      io.out(`clean: ${scanned} file(s) set pipefail and pipe nothing into an early-exiting reader`)
    },
  },
}

function usage(): string {
  return 'usage: mica-tools <command>\n' + Object.values(COMMANDS).map(c => `  mica-tools ${c.usage}`).join('\n')
}

export async function main(argv: string[], io: Io = { out: l => console.log(l), err: l => console.error(l) }): Promise<number> {
  const key = [argv.slice(0, 2).join(' '), argv[0] ?? ''].find(k => Object.hasOwn(COMMANDS, k))
  if (key === undefined) { io.err(usage()); return 2 }
  const command = COMMANDS[key]!
  const args = argv.slice(key.split(' ').length)
  try {
    await command.run(args, io)
    return 0
  }
  catch (e) {
    if (e instanceof Silent) return 1
    if (e instanceof UsageError) { io.err(`usage: mica-tools ${command.usage}`); return 2 }
    if (e instanceof Refused) {
      io.out(`refused ${e.rule}`)
      if (e.detail) io.err(`mica-tools ${key}: ${e.message}`)
      return 1
    }
    if (e instanceof ToolError) { io.err(`error: ${e.message}`); return 1 }
    // Anything else is still a failure of this command, reported as one rather than as a stack trace.
    if (e instanceof Error) { io.err(`error: mica-tools ${key}: ${e.message}`); return 1 }
    throw e
  }
}

if (import.meta.main) process.exit(await main(Bun.argv.slice(2)))
