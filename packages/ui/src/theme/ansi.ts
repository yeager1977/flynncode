// Shared by the app's status line bar and the TUI's. Only printable text and SGR survive: colours (foreground and
// background), bold and dim are styled, other SGR attributes are ignored, and every other escape sequence and control
// character is dropped. The server applies the same rules before it publishes a line; this is the second pass.

export type AnsiColor = number | { r: number; g: number; b: number }

export type AnsiRun = {
  text: string
  // A palette index 0-255, or a truecolour value. Undefined means the default colour.
  fg?: AnsiColor
  bg?: AnsiColor
  bold: boolean
  dim: boolean
}

type Style = Omit<AnsiRun, "text">

// Kept in step with the server's sanitizer in packages/flynncode/src/statusline/service.ts. In order: SGR (kept),
// any other CSI, OSC/DCS/SOS/PM/APC strings up to BEL or ST (or the end of the line), a CSI cut short, any other
// escape, then C0, DEL, C1 and the bidi overrides and isolates. Anything else is one visible character.
const TOKEN =
  /(\u001b\[[0-9;:]*m)|(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]|(?:\u001b[\]PX^_]|[\u0090\u0098\u009d-\u009f])[\s\S]*?(?:\u0007|\u001b\\|\u009c|$)|(?:\u001b\[|\u009b)[0-?]*[ -/]*|\u001b[ -/]*[0-~]?|[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]|([\s\S])/gu
const SGR = /^\u001b\[([0-9;:]*)m$/
const PIECE = /\u001b\[[0-9;:]*m|[^\u001b]+/g

const plain: Style = { bold: false, dim: false }

/**
 * The line with only printable text and SGR sequences left, cut to `limit` visible characters. SGR sequences do not
 * count and are never cut in half.
 */
export function sanitizeAnsi(line: string, limit = Number.POSITIVE_INFINITY) {
  return Array.from(line.matchAll(TOKEN)).reduce(
    (acc, match) => {
      if (match[1]) return { text: acc.text + match[1], visible: acc.visible }
      if (!match[2] || acc.visible >= limit) return acc
      return { text: acc.text + match[2], visible: acc.visible + 1 }
    },
    { text: "", visible: 0 },
  ).text
}

export function parseAnsi(line: string): AnsiRun[] {
  return (sanitizeAnsi(line).match(PIECE) ?? []).reduce(
    (acc, piece) => {
      const sgr = SGR.exec(piece)
      if (sgr) return { runs: acc.runs, style: applySgr(acc.style, sgr[1].split(";")) }
      const last = acc.runs.at(-1)
      if (last && sameStyle(last, acc.style))
        return { runs: [...acc.runs.slice(0, -1), { ...last, text: last.text + piece }], style: acc.style }
      return { runs: [...acc.runs, { text: piece, ...acc.style }], style: acc.style }
    },
    { runs: [] as AnsiRun[], style: plain },
  ).runs
}

export function ansiPlainText(line: string) {
  return parseAnsi(line)
    .map((run) => run.text)
    .join("")
}

// xterm's 6x6x6 colour cube (16-231) and 24-step grey ramp (232-255).
export function ansiCubeRgb(index: number) {
  if (index >= 232) {
    const gray = (index - 232) * 10 + 8
    return { r: gray, g: gray, b: gray }
  }
  const cube = index - 16
  const level = (value: number) => (value === 0 ? 0 : value * 40 + 55)
  return { r: level(Math.floor(cube / 36)), g: level(Math.floor(cube / 6) % 6), b: level(cube % 6) }
}

function sameStyle(a: Style, b: Style) {
  return a.bold === b.bold && a.dim === b.dim && sameColor(a.fg, b.fg) && sameColor(a.bg, b.bg)
}

function sameColor(a: AnsiColor | undefined, b: AnsiColor | undefined) {
  if (typeof a === "object" && typeof b === "object") return a.r === b.r && a.g === b.g && a.b === b.b
  return a === b
}

// `params` are the `;`-separated parameters. 38, 48 and 58 take their operands from the parameters that follow
// (`38;5;n`, `38;2;r;g;b`) or from `:` sub-parameters (`38:5:n`, `38:2::r:g:b`), so operands are never read as codes.
function applySgr(style: Style, params: string[]): Style {
  if (params.length === 0) return style
  if (params[0].includes(":")) return applySgr(extended(style, params[0].split(":")), params.slice(1))
  const code = params[0] === "" ? 0 : Number(params[0])
  if (code === 38 || code === 48 || code === 58) {
    const size = params[1] === "5" ? 3 : params[1] === "2" ? 5 : 1
    return applySgr(extended(style, params.slice(0, size)), params.slice(size))
  }
  return applySgr(basic(style, code), params.slice(1))
}

function basic(style: Style, code: number): Style {
  if (code === 0) return plain
  if (code === 1) return { ...style, bold: true }
  if (code === 2) return { ...style, dim: true }
  if (code === 22) return { ...style, bold: false, dim: false }
  if (code >= 30 && code <= 37) return { ...style, fg: code - 30 }
  if (code >= 90 && code <= 97) return { ...style, fg: code - 90 + 8 }
  if (code === 39) return { ...style, fg: undefined }
  if (code >= 40 && code <= 47) return { ...style, bg: code - 40 }
  if (code >= 100 && code <= 107) return { ...style, bg: code - 100 + 8 }
  if (code === 49) return { ...style, bg: undefined }
  return style
}

// [code, "5", n] or [code, "2", (colour space,) r, g, b]. 58 (underline colour) is consumed and ignored.
function extended(style: Style, parts: string[]): Style {
  const color = extendedColor(parts.slice(1))
  if (color === undefined) return style
  if (parts[0] === "38") return { ...style, fg: color }
  if (parts[0] === "48") return { ...style, bg: color }
  return style
}

function extendedColor(parts: string[]): AnsiColor | undefined {
  const values = parts.map((part) => (part === "" ? Number.NaN : Number(part)))
  if (parts[0] === "5") return byte(values[1]) ? values[1] : undefined
  if (parts[0] !== "2" || parts.length < 4) return undefined
  const rgb = values.slice(-3)
  return rgb.every(byte) ? { r: rgb[0], g: rgb[1], b: rgb[2] } : undefined
}

function byte(value: number | undefined): value is number {
  return value !== undefined && Number.isInteger(value) && value >= 0 && value <= 255
}
