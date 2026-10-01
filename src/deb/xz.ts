// An .xz decoder (the xz file format 1.0.4 with the LZMA2 filter), so a Debian archive reads with no dependency and
// no host tool: dpkg-deb compresses control.tar and data.tar with xz by default. Integrity is the archive's sha256,
// checked by whoever pinned it; the block checks are skipped, the structure is not.
import { ToolError } from '../errors.ts'

class Bytes {
  buf = new Uint8Array(1 << 16)
  length = 0

  push(byte: number): void {
    if (this.length === this.buf.length) this.grow(1)
    this.buf[this.length++] = byte
  }

  append(data: Uint8Array): void {
    this.grow(data.length)
    this.buf.set(data, this.length)
    this.length += data.length
  }

  private grow(extra: number): void {
    if (this.length + extra <= this.buf.length) return
    let size = this.buf.length * 2
    while (size < this.length + extra) size *= 2
    const next = new Uint8Array(size)
    next.set(this.buf.subarray(0, this.length))
    this.buf = next
  }
}

function fail(what: string): never {
  throw new ToolError(`not a readable xz stream: ${what}`)
}

class RangeDecoder {
  range = 0xFFFFFFFF
  code = 0
  constructor(private readonly data: Uint8Array, private at: number, private readonly end: number) {
    if (this.byte() !== 0) fail('a range coder that does not start with 0')
    for (let i = 0; i < 4; i++) this.code = ((this.code << 8) | this.byte()) >>> 0
  }

  private byte(): number {
    if (this.at >= this.end) fail('a chunk that ends early')
    return this.data[this.at++]!
  }

  private normalize(): void {
    if (this.range < 0x1000000) {
      this.range = (this.range << 8) >>> 0
      this.code = ((this.code << 8) | this.byte()) >>> 0
    }
  }

  bit(probs: Uint16Array, i: number): number {
    this.normalize()
    const p = probs[i]!
    const bound = (this.range >>> 11) * p
    if (this.code < bound) {
      this.range = bound
      probs[i] = p + ((2048 - p) >>> 5)
      return 0
    }
    this.range -= bound
    this.code -= bound
    probs[i] = p - (p >>> 5)
    return 1
  }

  direct(count: number): number {
    let result = 0
    for (let i = 0; i < count; i++) {
      this.normalize()
      this.range >>>= 1
      let bit = 0
      if (this.code >= this.range) { this.code -= this.range; bit = 1 }
      result = ((result << 1) | bit) >>> 0
    }
    return result
  }

  tree(probs: Uint16Array, base: number, bits: number): number {
    let m = 1
    for (let i = 0; i < bits; i++) m = (m << 1) | this.bit(probs, base + m)
    return m - (1 << bits)
  }

  reverse(probs: Uint16Array, base: number, bits: number): number {
    let m = 1, result = 0
    for (let i = 0; i < bits; i++) {
      const bit = this.bit(probs, base + m)
      m = (m << 1) | bit
      result |= bit << i
    }
    return result
  }

  /** A chunk ends normalized: its last byte is read by the normalization after its last symbol. */
  finished(): boolean {
    this.normalize()
    return this.at === this.end && this.code === 0
  }
}

const STATES = 12
const POS_STATES_MAX = 16
const END_POS_MODEL = 14
const FULL_DISTANCES = 128

class LengthDecoder {
  choice = new Uint16Array(2)
  low = new Uint16Array(POS_STATES_MAX << 3)
  mid = new Uint16Array(POS_STATES_MAX << 3)
  high = new Uint16Array(256)

  reset(): void {
    for (const a of [this.choice, this.low, this.mid, this.high]) a.fill(1024)
  }

  decode(rc: RangeDecoder, posState: number): number {
    if (rc.bit(this.choice, 0) === 0) return rc.tree(this.low, posState << 3, 3)
    if (rc.bit(this.choice, 1) === 0) return 8 + rc.tree(this.mid, posState << 3, 3)
    return 16 + rc.tree(this.high, 0, 8)
  }
}

/** The LZMA state an LZMA2 stream carries from chunk to chunk. */
class Lzma {
  lc = 0
  lp = 0
  pb = 0
  state = 0
  reps = [0, 0, 0, 0]
  literal = new Uint16Array(0x300)
  isMatch = new Uint16Array(STATES << 4)
  isRep = new Uint16Array(STATES)
  isRepG0 = new Uint16Array(STATES)
  isRepG1 = new Uint16Array(STATES)
  isRepG2 = new Uint16Array(STATES)
  isRep0Long = new Uint16Array(STATES << 4)
  posSlot = new Uint16Array(4 << 6)
  posDecoders = new Uint16Array(1 + FULL_DISTANCES - END_POS_MODEL)
  align = new Uint16Array(16)
  len = new LengthDecoder()
  repLen = new LengthDecoder()

  properties(byte: number): void {
    if (byte > 224) fail('LZMA properties above 224')
    this.lc = byte % 9
    this.lp = Math.floor(byte / 9) % 5
    this.pb = Math.floor(byte / 45)
    if (this.lc + this.lp > 4) fail('lc + lp above 4')
    this.literal = new Uint16Array(0x300 << (this.lc + this.lp))
  }

  reset(): void {
    this.state = 0
    this.reps = [0, 0, 0, 0]
    for (const a of [this.literal, this.isMatch, this.isRep, this.isRepG0, this.isRepG1, this.isRepG2, this.isRep0Long, this.posSlot, this.posDecoders, this.align])
      a.fill(1024)
    this.len.reset()
    this.repLen.reset()
  }

  /** Decodes exactly `size` bytes onto `out`, whose dictionary begins at `dictStart`. */
  chunk(rc: RangeDecoder, out: Bytes, dictStart: number, size: number): void {
    const target = out.length + size
    const posMask = (1 << this.pb) - 1, lpMask = (1 << this.lp) - 1
    const back = (distance: number): number => {
      const at = out.length - distance - 1
      if (at < dictStart) fail('a distance beyond the dictionary')
      return out.buf[at]!
    }
    while (out.length < target) {
      const pos = out.length - dictStart
      const posState = pos & posMask
      const s = this.state
      if (rc.bit(this.isMatch, (s << 4) + posState) === 0) {
        const prev = pos > 0 ? out.buf[out.length - 1]! : 0
        const base = 0x300 * (((pos & lpMask) << this.lc) + (prev >>> (8 - this.lc)))
        let symbol = 1
        if (s >= 7) {
          let match = back(this.reps[0]!)
          do {
            const matchBit = (match >>> 7) & 1
            match <<= 1
            const bit = rc.bit(this.literal, base + ((1 + matchBit) << 8) + symbol)
            symbol = (symbol << 1) | bit
            if (matchBit !== bit) break
          } while (symbol < 0x100)
        }
        while (symbol < 0x100) symbol = (symbol << 1) | rc.bit(this.literal, base + symbol)
        out.push(symbol & 0xFF)
        this.state = s < 4 ? 0 : s < 10 ? s - 3 : s - 6
        continue
      }
      let length: number
      if (rc.bit(this.isRep, s) === 1) {
        if (pos === 0) fail('a repeated match at the start of the dictionary')
        if (rc.bit(this.isRepG0, s) === 0) {
          if (rc.bit(this.isRep0Long, (s << 4) + posState) === 0) {
            this.state = s < 7 ? 9 : 11
            out.push(back(this.reps[0]!))
            continue
          }
        }
        else {
          let distance: number
          if (rc.bit(this.isRepG1, s) === 0) {
            distance = this.reps[1]!
          }
          else {
            if (rc.bit(this.isRepG2, s) === 0) {
              distance = this.reps[2]!
            }
            else {
              distance = this.reps[3]!
              this.reps[3] = this.reps[2]!
            }
            this.reps[2] = this.reps[1]!
          }
          this.reps[1] = this.reps[0]!
          this.reps[0] = distance
        }
        length = this.repLen.decode(rc, posState)
        this.state = s < 7 ? 8 : 11
      }
      else {
        this.reps[3] = this.reps[2]!
        this.reps[2] = this.reps[1]!
        this.reps[1] = this.reps[0]!
        length = this.len.decode(rc, posState)
        this.state = s < 7 ? 7 : 10
        this.reps[0] = this.distance(rc, length)
      }
      length += 2
      if (out.length + length > target) fail('a match beyond the chunk')
      const from = out.length - this.reps[0]! - 1
      if (from < dictStart) fail('a distance beyond the dictionary')
      for (let i = 0; i < length; i++) out.push(out.buf[from + i]!)
    }
  }

  private distance(rc: RangeDecoder, length: number): number {
    const slot = rc.tree(this.posSlot, Math.min(length, 3) << 6, 6)
    if (slot < 4) return slot
    const direct = (slot >>> 1) - 1
    let distance = ((2 | (slot & 1)) << direct) >>> 0
    if (slot < END_POS_MODEL) return (distance + rc.reverse(this.posDecoders, distance - slot, direct)) >>> 0
    distance = (distance + ((rc.direct(direct - 4) << 4) >>> 0)) >>> 0
    return (distance + rc.reverse(this.align, 0, 4)) >>> 0
  }
}

/** One LZMA2 stream from `at`; returns where it ended. */
function lzma2(data: Uint8Array, at: number, out: Bytes): number {
  const lzma = new Lzma()
  let dictStart = out.length, needProps = true
  for (;;) {
    if (at >= data.length) fail('LZMA2 data that ends early')
    const control = data[at++]!
    if (control === 0x00) return at
    if (control === 0x01 || control === 0x02) {
      if (control === 0x01) dictStart = out.length
      const size = ((data[at]! << 8) | data[at + 1]!) + 1
      at += 2
      if (at + size > data.length) fail('an uncompressed chunk that ends early')
      out.append(data.subarray(at, at + size))
      at += size
      continue
    }
    if (control < 0x80) fail(`the LZMA2 control byte ${control}`)
    const size = ((control & 0x1F) << 16) + (data[at]! << 8) + data[at + 1]! + 1
    const packed = (data[at + 2]! << 8) + data[at + 3]! + 1
    at += 4
    const reset = (control >>> 5) & 3
    if (reset === 3) dictStart = out.length
    if (reset >= 2) {
      lzma.properties(data[at++]!)
      needProps = false
    }
    else if (needProps) {
      fail('an LZMA chunk before any properties')
    }
    if (reset >= 1) lzma.reset()
    if (at + packed > data.length) fail('an LZMA chunk that ends early')
    const rc = new RangeDecoder(data, at, at + packed)
    lzma.chunk(rc, out, dictStart, size)
    if (!rc.finished()) fail('an LZMA chunk with data left over')
    at += packed
  }
}

function varint(data: Uint8Array, at: number): [number, number] {
  let value = 0
  for (let i = 0; i < 9; i++) {
    const byte = data[at + i]
    if (byte === undefined) fail('a number that ends early')
    value += (byte & 0x7F) * 2 ** (7 * i)
    if ((byte & 0x80) === 0) return [value, at + i + 1]
  }
  return fail('a number longer than 9 bytes')
}

const MAGIC = [0xFD, 0x37, 0x7A, 0x58, 0x5A, 0x00]
const CHECK_SIZE: Record<number, number> = { 0: 0, 1: 4, 4: 8, 10: 32 }

/** Decompresses a whole .xz file: one or more streams, stream padding between them. */
export function unxz(data: Uint8Array): Uint8Array {
  const out = new Bytes()
  let at = 0
  while (at < data.length) {
    if (MAGIC.some((b, i) => data[at + i] !== b)) fail('no stream header')
    if (data[at + 6] !== 0) fail('stream flags')
    const checkSize = CHECK_SIZE[data[at + 7]!]
    if (checkSize === undefined) fail(`the check type ${data[at + 7]}`)
    at += 12
    // Blocks, until the index indicator.
    while (data[at] !== 0x00) {
      if (at >= data.length) fail('a stream without an index')
      const headerSize = (data[at]! + 1) * 4
      const flags = data[at + 1]!
      let p = at + 2
      if (flags & 0x40) p = varint(data, p)[1]
      if (flags & 0x80) p = varint(data, p)[1]
      if ((flags & 0x03) !== 0) fail('a filter chain other than LZMA2 alone')
      const [filter, afterId] = varint(data, p)
      if (filter !== 0x21) fail(`the filter ${filter}; only LZMA2 is read`)
      const [propsSize] = varint(data, afterId)
      if (propsSize !== 1) fail('LZMA2 properties that are not one byte')
      at += headerSize
      const start = at
      at = lzma2(data, at, out)
      at += (4 - ((at - start) % 4)) % 4
      at += checkSize
    }
    // The index, then the stream footer.
    const [records, afterCount] = varint(data, at + 1)
    let p = afterCount
    for (let i = 0; i < records; i++) p = varint(data, varint(data, p)[1])[1]
    p += (4 - ((p - at) % 4)) % 4
    at = p + 4 + 12
    if (data[at - 2] !== 0x59 || data[at - 1] !== 0x5A) fail('no stream footer')
    while (at < data.length && data[at] === 0) at += 1
  }
  return out.buf.slice(0, out.length)
}
