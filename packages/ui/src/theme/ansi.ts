// Shared by the app's status line bar and the TUI footer. Only SGR colour,
// bold and dim survive; every other escape sequence and control character is dropped.

export type AnsiColor = number | { r: number; g: number; b: number }

export type AnsiRun = {
  text: string
  // A palette index 0-255, or a truecolour value. Undefined means the default colour.
  fg?: AnsiColor
  bold: boolean
  dim: boolean
}

type Style = Pick<AnsiRun, "fg" | "bold" | "dim">

// CSI, OSC (BEL or ST terminated), a truncated sequence at the end of the line, then two-character escapes.
const ESCAPE =
  /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b(?:\[[0-?]*[ -/]*|\][^\u0007\u001b]*)?$|\u001b[ -/]*[0-~]/g
const CONTROL = /[\u0000-\u0008\u000a-\u001f\u007f]/g
const SGR = /^\u001b\[([0-9;:]*)m$/

export function parseAnsi(line: string): AnsiRun[] {
  const runs: AnsiRun[] = []
  let style: Style = { bold: false, dim: false }
  let index = 0
  const push = (text: string) => {
    const clean = text.replace(CONTROL, "")
    if (!clean) return
    const last = runs.at(-1)
    if (last && sameStyle(last, style)) last.text += clean
    else runs.push({ text: clean, ...style })
  }

  for (const match of line.matchAll(ESCAPE)) {
    push(line.slice(index, match.index))
    index = match.index + match[0].length
    const params = SGR.exec(match[0])
    if (params) style = applySgr(style, params[1])
  }
  push(line.slice(index))
  return runs
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
  if (a.bold !== b.bold || a.dim !== b.dim) return false
  if (typeof a.fg === "object" && typeof b.fg === "object")
    return a.fg.r === b.fg.r && a.fg.g === b.fg.g && a.fg.b === b.fg.b
  return a.fg === b.fg
}

function applySgr(current: Style, raw: string): Style {
  const codes = raw === "" ? [0] : raw.split(/[;:]/).map((code) => (code === "" ? 0 : Number(code)))
  let style = current
  for (let i = 0; i < codes.length; i++) {
    const code = codes[i]
    if (code === 0) style = { bold: false, dim: false }
    else if (code === 1) style = { ...style, bold: true }
    else if (code === 2) style = { ...style, dim: true }
    else if (code === 22) style = { ...style, bold: false, dim: false }
    else if (code >= 30 && code <= 37) style = { ...style, fg: code - 30 }
    else if (code >= 90 && code <= 97) style = { ...style, fg: code - 90 + 8 }
    else if (code === 39) style = { bold: style.bold, dim: style.dim }
    else if (code === 38 && codes[i + 1] === 5) {
      const palette = codes[i + 2]
      if (palette !== undefined && palette >= 0 && palette <= 255) style = { ...style, fg: palette }
      i += 2
    } else if (code === 38 && codes[i + 1] === 2) {
      const [r, g, b] = codes.slice(i + 2, i + 5)
      if ([r, g, b].every((value) => value !== undefined && value >= 0 && value <= 255))
        style = { ...style, fg: { r, g, b } }
      i += 4
    }
  }
  return style
}
