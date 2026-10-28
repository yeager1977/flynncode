import { RGBA, TextAttributes } from "@opentui/core"
import { parseAnsi } from "@flynncode/ui/theme/ansi"
import { ansiToRgba } from "../theme"

// opentui text does not interpret raw ANSI, so each SGR run becomes a styled chunk.
export function statusLineChunks(line: string) {
  return parseAnsi(line).map((run) => ({
    text: run.text,
    fg:
      run.fg === undefined
        ? undefined
        : typeof run.fg === "number"
          ? ansiToRgba(run.fg)
          : RGBA.fromInts(run.fg.r, run.fg.g, run.fg.b),
    attributes: (run.bold ? TextAttributes.BOLD : 0) | (run.dim ? TextAttributes.DIM : 0),
  }))
}
