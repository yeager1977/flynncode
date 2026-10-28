import { RGBA, TextAttributes } from "@opentui/core"
import { parseAnsi, type AnsiColor } from "@flynncode/ui/theme/ansi"
import { ansiToRgba } from "../theme"

// opentui text does not interpret raw ANSI, so each SGR run becomes a styled chunk. parseAnsi drops every escape
// except SGR and every control character, a second pass after the server's.
export function statusLineChunks(line: string) {
  return parseAnsi(line).map((run) => ({
    text: run.text,
    fg: rgba(run.fg),
    bg: rgba(run.bg),
    attributes: (run.bold ? TextAttributes.BOLD : 0) | (run.dim ? TextAttributes.DIM : 0),
  }))
}

// An event is newer than any fetch that started before it, and a reset (session switch) invalidates every fetch in
// flight, so a slow response can never overwrite fresher lines.
export function createStatusLineSource(apply: (lines: string[]) => void) {
  const state = { generation: 0 }
  return {
    push(lines: string[]) {
      state.generation++
      apply(lines)
    },
    reset() {
      state.generation++
      apply([])
    },
    async fetch(load: () => Promise<string[] | undefined>) {
      const run = state.generation
      const lines = await load().catch(() => undefined)
      if (!lines || run !== state.generation) return
      apply(lines)
    },
  }
}

function rgba(color: AnsiColor | undefined) {
  if (color === undefined) return undefined
  if (typeof color === "number") return ansiToRgba(color)
  return RGBA.fromInts(color.r, color.g, color.b)
}
