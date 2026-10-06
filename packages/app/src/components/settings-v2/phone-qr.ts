// Tiny vendored QR Code encoder for the phone connection card.
//
// Byte mode, error correction level L, versions 1-4, fixed mask 0. The
// launcher URL is short (IPv4 + port + "/m"), so version 4 capacity (78
// bytes) is plenty and version info blocks (v7+) are never needed.
// Rendered client-side to a <canvas>; the URL never leaves the device.

type QrVersion = {
  version: number
  size: number
  totalCodewords: number
  ecCodewords: number
  alignment: readonly number[]
}

const VERSIONS: readonly QrVersion[] = [
  { version: 1, size: 21, totalCodewords: 26, ecCodewords: 7, alignment: [] },
  { version: 2, size: 25, totalCodewords: 44, ecCodewords: 10, alignment: [6, 18] },
  { version: 3, size: 29, totalCodewords: 70, ecCodewords: 15, alignment: [6, 22] },
  { version: 4, size: 33, totalCodewords: 100, ecCodewords: 20, alignment: [6, 26] },
]

const MAX_BYTES = 78

function buildExpTable(): number[] {
  const table = new Array<number>(512)
  let value = 1
  for (let i = 0; i < 512; i++) {
    table[i] = value
    value <<= 1
    if (value >= 256) value ^= 0x11d
  }
  return table
}

function buildLogTable(exp: readonly number[]): number[] {
  const table = new Array<number>(256).fill(0)
  for (let i = 1; i < 255; i++) table[exp[i]] = i
  return table
}

const EXP = buildExpTable()
const LOG = buildLogTable(EXP)

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0
  return EXP[LOG[a] + LOG[b]]
}

function generatorPoly(degree: number): number[] {
  let poly = [1]
  for (let i = 0; i < degree; i++) {
    const next = new Array<number>(poly.length + 1).fill(0)
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= gfMul(poly[j], EXP[i])
      next[j + 1] ^= poly[j]
    }
    poly = next
  }
  return poly
}

function rsRemainder(data: readonly number[], ecCount: number): number[] {
  const gen = generatorPoly(ecCount).reverse()
  const work = [...data]
  for (let i = 0; i < ecCount; i++) work.push(0)
  for (let i = 0; i < data.length; i++) {
    const factor = work[i]
    if (factor === 0) continue
    for (let j = 0; j < gen.length; j++) work[i + j] ^= gfMul(gen[j], factor)
  }
  return work.slice(data.length)
}

function encodeData(bytes: readonly number[], dataCodewords: number): number[] {
  const bits: number[] = []
  const push = (value: number, length: number) => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >> i) & 1)
  }
  push(0b0100, 4)
  push(bytes.length, 8)
  for (const byte of bytes) push(byte, 8)
  push(0, Math.min(4, dataCodewords * 8 - bits.length))
  while (bits.length % 8 !== 0) bits.push(0)
  const codewords: number[] = []
  for (let i = 0; i < bits.length; i += 8) {
    let word = 0
    for (let j = 0; j < 8; j++) word = (word << 1) | bits[i + j]
    codewords.push(word)
  }
  const pads = [0xec, 0x11]
  for (let i = 0; codewords.length < dataCodewords; i++) codewords.push(pads[i % 2])
  return codewords
}

function formatValue(): number {
  const data = (0b01 << 3) | 0
  let rem = data
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >> 9) & 1 ? 0x537 : 0)
  return ((data << 10) | rem) ^ 0x5412
}

function bitOf(value: number, index: number): boolean {
  return ((value >> index) & 1) !== 0
}

export function canEncodeQr(text: string): boolean {
  return new TextEncoder().encode(text).length <= MAX_BYTES
}

export function encodeQrMatrix(text: string): boolean[][] {
  const bytes = Array.from(new TextEncoder().encode(text))
  const spec = VERSIONS.find((candidate) => candidate.totalCodewords - candidate.ecCodewords - 2 >= bytes.length)
  if (!spec) throw new Error("text too long for vendored QR encoder")
  const dataCodewords = spec.totalCodewords - spec.ecCodewords
  const data = encodeData(bytes, dataCodewords)
  const codewords = [...data, ...rsRemainder(data, spec.ecCodewords)]
  const size = spec.size
  const modules: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false))
  const reserved: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false))

  const set = (x: number, y: number, dark: boolean) => {
    modules[y][x] = dark
    reserved[y][x] = true
  }

  const finder = (left: number, top: number) => {
    for (let dy = -1; dy <= 7; dy++) {
      for (let dx = -1; dx <= 7; dx++) {
        const x = left + dx
        const y = top + dy
        if (x < 0 || y < 0 || x >= size || y >= size) continue
        const inside = dx >= 0 && dx <= 6 && dy >= 0 && dy <= 6
        const dark =
          inside && (dx === 0 || dx === 6 || dy === 0 || dy === 6 || (dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4))
        set(x, y, dark)
      }
    }
  }
  finder(0, 0)
  finder(size - 7, 0)
  finder(0, size - 7)

  for (let i = 8; i < size - 8; i++) {
    set(6, i, i % 2 === 0)
    set(i, 6, i % 2 === 0)
  }

  for (const cy of spec.alignment) {
    for (const cx of spec.alignment) {
      if ((cx < 9 && cy < 9) || (cx >= size - 8 && cy < 9) || (cx < 9 && cy >= size - 8)) continue
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const dark = dx === -2 || dx === 2 || dy === -2 || dy === 2 || (dx === 0 && dy === 0)
          set(cx + dx, cy + dy, dark)
        }
      }
    }
  }

  const format = formatValue()
  for (let i = 0; i <= 5; i++) set(8, i, bitOf(format, i))
  set(8, 7, bitOf(format, 6))
  set(8, 8, bitOf(format, 7))
  set(7, 8, bitOf(format, 8))
  for (let i = 9; i < 15; i++) set(14 - i, 8, bitOf(format, i))
  for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bitOf(format, i))
  for (let i = 8; i < 15; i++) set(8, size - 1 - (i - 8), bitOf(format, i))
  set(8, size - 8, true)

  let index = 0
  const totalBits = codewords.length * 8
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j
        const upward = ((right + 1) & 2) === 0
        const y = upward ? size - 1 - vert : vert
        if (reserved[y][x]) continue
        const dark = index < totalBits && bitOf(codewords[index >> 3], 7 - (index & 7))
        modules[y][x] = dark !== ((x + y) % 2 === 0)
        index++
      }
    }
  }
  return modules
}

export function drawQrToCanvas(canvas: HTMLCanvasElement, text: string): void {
  const context = canvas.getContext("2d")
  if (!context) return
  const modules = encodeQrMatrix(text)
  const size = modules.length
  const quiet = 4
  const scale = 4
  canvas.width = (size + quiet * 2) * scale
  canvas.height = (size + quiet * 2) * scale
  context.fillStyle = "#ffffff"
  context.fillRect(0, 0, canvas.width, canvas.height)
  context.fillStyle = "#000000"
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (modules[y][x]) context.fillRect((x + quiet) * scale, (y + quiet) * scale, scale, scale)
    }
  }
}
