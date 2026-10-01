// A Debian binary archive read without dpkg (design 3.3: `deb control`, `deb member`). A .deb is an `ar` archive
// whose control.tar[.gz|.xz] member holds ./control and whose data.tar[.gz|.xz] member holds the payload; any
// other compression is refused by name, and so is a path the payload does not carry as a regular file.
import { readFileSync } from 'node:fs'
import { ToolError } from '../errors.ts'
import { unxz } from './xz.ts'

function* arMembers(path: string, data: Uint8Array): Generator<[string, Uint8Array]> {
  const ascii = (a: number, b: number) => new TextDecoder('latin1').decode(data.subarray(a, b))
  if (ascii(0, 8) !== '!<arch>\n') throw new ToolError(`${path} is not an ar archive, so not a Debian binary package`)
  let at = 8
  while (at + 60 <= data.length) {
    const name = ascii(at, at + 16).trim().replace(/\/$/, '')
    const size = parseInt(ascii(at + 48, at + 58).trim(), 10)
    if (!Number.isFinite(size) || at + 60 + size > data.length) throw new ToolError(`${path}: the ar member ${name} ends early`)
    yield [name, data.subarray(at + 60, at + 60 + size)]
    at += 60 + size + (size & 1)
  }
}

function decompress(path: string, name: string, body: Uint8Array): Uint8Array {
  if (name.endsWith('.tar')) return body
  if (name.endsWith('.tar.gz')) return Bun.gunzipSync(new Uint8Array(body))
  if (name.endsWith('.tar.xz')) return unxz(body)
  throw new ToolError(`${path} compresses ${name.replace(/\.tar.*$/, '.tar')} as ${name}; only .tar, .tar.gz and .tar.xz are read`)
}

/** The decompressed tar of the member whose name starts with `prefix` (`control.tar` or `data.tar`). */
function memberTar(path: string, prefix: string): Uint8Array {
  const data = new Uint8Array(readFileSync(path))
  for (const [name, body] of arMembers(path, data))
    if (name.startsWith(prefix)) return decompress(path, name, body)
  throw new ToolError(`${path} carries no ${prefix} member`)
}

export type TarEntry = { name: string, type: string, mode: number, uid: number, gid: number, mtime: number, linkname: string, body: Uint8Array }

/** The entries of an uncompressed tar: ustar and GNU headers, long names through the L and K entries. */
export function* tarEntries(tar: Uint8Array): Generator<TarEntry> {
  const text = (at: number, len: number) => new TextDecoder().decode(tar.subarray(at, at + len)).replace(/\0.*$/s, '')
  const octal = (at: number, len: number) => parseInt(text(at, len).trim() || '0', 8)
  let at = 0
  let longName: string | undefined, longLink: string | undefined
  while (at + 512 <= tar.length) {
    if (tar.subarray(at, at + 512).every(b => b === 0)) break
    const name = text(at, 100), mode = octal(at + 100, 8), uid = octal(at + 108, 8), gid = octal(at + 116, 8)
    const size = octal(at + 124, 12), mtime = octal(at + 136, 12), type = text(at + 156, 1) || '0', linkname = text(at + 157, 100), prefix = text(at + 345, 155)
    const body = tar.subarray(at + 512, at + 512 + size)
    at += 512 + Math.ceil(size / 512) * 512
    if (type === 'L') { longName = new TextDecoder().decode(body).replace(/\0.*$/s, ''); continue }
    if (type === 'K') { longLink = new TextDecoder().decode(body).replace(/\0.*$/s, ''); continue }
    yield { name: longName ?? (prefix ? `${prefix}/${name}` : name), type, mode, uid, gid, mtime, linkname: longLink ?? linkname, body }
    longName = undefined
    longLink = undefined
  }
}

/** A member name as installed: no leading ./, no trailing /. */
export function installedPath(name: string): string {
  return name.replace(/^(\.\/)+/, '').replace(/\/+$/, '').replace(/^\.$/, '')
}

/** Every entry of the control tarball (control, md5sums, conffiles, maintainer scripts). */
export function controlEntries(path: string): TarEntry[] {
  return [...tarEntries(memberTar(path, 'control.tar'))]
}

export function controlText(path: string): string {
  for (const entry of controlEntries(path))
    if (installedPath(entry.name) === 'control' && entry.type === '0') return new TextDecoder().decode(entry.body)
  throw new ToolError(`${path}: its control.tar carries no control file`)
}

/** The fields of a control file; a continuation line joins its field with a newline. */
export function controlFields(text: string): Record<string, string> {
  const result: Record<string, string> = {}
  let key: string | undefined
  for (const line of text.split('\n')) {
    if (line.startsWith(' ') || line.startsWith('\t')) {
      if (key !== undefined) result[key] += '\n' + line
    }
    else if (line) {
      const i = line.indexOf(':')
      key = (i < 0 ? line : line.slice(0, i)).trim()
      result[key] = (i < 0 ? '' : line.slice(i + 1)).trim()
    }
  }
  return result
}

/** Every payload entry, named as the archive carries it (./usr/...). */
export function payloadEntries(path: string): TarEntry[] {
  return [...tarEntries(memberTar(path, 'data.tar'))]
}

/** One regular file of the payload, by its installed path. */
export function payloadMember(path: string, wanted: string): TarEntry {
  const want = installedPath(wanted.replace(/^\/+/, ''))
  const entry = payloadEntries(path).find(e => installedPath(e.name) === want)
  if (entry === undefined) throw new ToolError(`${path} carries no ${want} in its payload`)
  if (entry.type !== '0') throw new ToolError(`${path}: ${want} is not a regular file in the payload (a ${JSON.stringify(entry.type)} entry)`)
  return entry
}
